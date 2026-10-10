//! Reconnect mid-guard (#92): what each authority keeps of a held shield across a reconnect.
//!
//! The browser client owns the held guard input and sends it as `SetGuard` edges. These
//! tests pin the authority half of the reconnect contract, which decides what a reconnecting
//! client must (and must not) send:
//!
//! - dedicated: `game_server::MatchRuntime` keeps the player, its guard and its command
//!   watermark across an in-grace disconnect/reconnect. A guard still held needs no new
//!   command and is never dropped by the reconnect itself; a release sent after the resume
//!   with the continued sequence lowers it; a replayed stale raise cannot re-raise it; and a
//!   re-asserted raise of an already raised guard does not restart the raise.
//! - peer-hosted: the host removes a disconnected guest's player and adds a fresh one when
//!   the guest's link comes back, so the re-joined player starts lowered and only a
//!   re-asserted `SetGuard { raised: true }` raises it again.

use arpg_core::{
    ArpgCommand, ArpgGame, ArpgSnapshot, AuthoritativeGame, GuardPhase, GuardStance, PlayerCommand,
    PlayerId, ScenarioId, WorkbenchOperation,
};
use arpg_game_server::GameServerAdapter;
use arpg_protocol::{JsonProtocol, WireProtocol};
use game_server::{
    CommandOutcome, MatchRuntime, RECONNECT_TOKEN_BYTES, ReconnectToken, SessionLease,
};

const SEED: u32 = 0x0092_6A4D;
const RECONNECT_GRACE_TICKS: u64 = 120;
/// Outage length inside the grace period.
const OUTAGE_TICKS: u64 = 30;
const _: () = assert!(OUTAGE_TICKS < RECONNECT_GRACE_TICKS);
/// Enough ticks for any authored raise to finish.
const SETTLE_TICKS: u64 = 20;

const RAISED: Option<GuardStance> = Some(GuardStance {
    phase: GuardPhase::Raised,
    ticks_remaining: 0,
});

/// A quiet arena: the dummy scenario without its target, so nothing hurts the player and a
/// guard only changes through `SetGuard`.
fn arena() -> ArpgGame {
    let mut game = ArpgGame::new_scenario(ScenarioId::Dummy, SEED).unwrap();
    let room = game.workbench_room().unwrap();
    let targets: Vec<u32> = game
        .snapshot()
        .unwrap()
        .monsters
        .iter()
        .filter(|monster| monster.room_id == room)
        .map(|monster| monster.id)
        .collect();
    for monster_id in targets {
        game.apply_workbench(&WorkbenchOperation::RemoveMonster { monster_id })
            .unwrap();
    }
    game
}

fn token(byte: u8) -> ReconnectToken {
    ReconnectToken([byte; RECONNECT_TOKEN_BYTES])
}

fn guard_of(snapshot: &ArpgSnapshot, player: PlayerId) -> Option<GuardStance> {
    snapshot
        .players
        .iter()
        .find(|candidate| candidate.id == player)
        .expect("player is in the snapshot")
        .guard
}

struct Dedicated {
    runtime: MatchRuntime<GameServerAdapter<ArpgGame, JsonProtocol>>,
    lease: SessionLease,
}

impl Dedicated {
    fn new() -> Self {
        let adapter = GameServerAdapter::new(arena(), JsonProtocol);
        let mut runtime = MatchRuntime::new(adapter, RECONNECT_GRACE_TICKS);
        let lease = runtime.admit(token(1)).unwrap();
        Self { runtime, lease }
    }

    fn submit(&mut self, sequence: u32, command: ArpgCommand) -> CommandOutcome {
        let payload = JsonProtocol.encode_command(&command).unwrap();
        self.runtime
            .submit_command(
                self.lease.player_id,
                self.lease.connection_epoch,
                sequence,
                &payload,
            )
            .unwrap()
    }

    fn advance(&mut self, ticks: u64) {
        for _ in 0..ticks {
            self.runtime.advance_tick().unwrap();
        }
    }

    fn guard(&self) -> Option<GuardStance> {
        let snapshot = self.runtime.snapshot().unwrap();
        let decoded = JsonProtocol.decode_snapshot(&snapshot.payload).unwrap();
        guard_of(&decoded, self.lease.player_id)
    }

    /// Drops the connection, waits out an in-grace outage and resumes the same player.
    fn outage_and_resume(&mut self, replacement: u8) {
        let previous = self.lease;
        assert!(
            self.runtime
                .disconnect(previous.player_id, previous.connection_epoch)
        );
        self.advance(OUTAGE_TICKS);
        self.lease = self
            .runtime
            .reconnect(previous.reconnect_token, token(replacement))
            .unwrap();
        assert_eq!(self.lease.player_id, previous.player_id);
        assert!(self.lease.connection_epoch > previous.connection_epoch);
    }

    /// Admits the player, raises its guard fully and returns the next free sequence.
    fn raised() -> (Self, u32) {
        let mut server = Self::new();
        assert_eq!(
            server.submit(1, ArpgCommand::SetGuard { raised: true }),
            CommandOutcome::Applied
        );
        server.advance(SETTLE_TICKS);
        assert_eq!(server.guard(), RAISED, "fixture: the guard rose");
        (server, 2)
    }
}

/// A key held through the outage: the client sends nothing, and the resumed player still
/// guards. Breaks if the runtime/adapter re-adds the player on reconnect or if any
/// disconnect hook lowers held input (a phantom drop while the key is still held).
#[test]
fn dedicated_resume_keeps_a_guard_that_is_still_held() {
    let (mut server, _) = Dedicated::raised();
    server.outage_and_resume(2);
    assert_eq!(
        server.guard(),
        RAISED,
        "the reconnect itself dropped the guard"
    );
    server.advance(SETTLE_TICKS);
    assert_eq!(
        server.guard(),
        RAISED,
        "a held guard decayed after the resume"
    );
}

/// A key released during the outage: the client's buffered release reaches the resumed
/// session with the continued sequence and lowers the guard; the pre-outage raise replayed
/// by a duplicate datagram is stale and cannot raise it again.
#[test]
fn dedicated_release_sent_after_resume_lowers_the_guard_and_stale_raise_is_ignored() {
    let (mut server, next) = Dedicated::raised();
    server.outage_and_resume(2);
    assert_eq!(
        server.submit(next, ArpgCommand::SetGuard { raised: false }),
        CommandOutcome::Applied,
        "the runtime's watermark must accept the continued sequence"
    );
    assert_eq!(
        server.guard(),
        None,
        "a release lowers the guard immediately"
    );
    assert_eq!(
        server.submit(1, ArpgCommand::SetGuard { raised: true }),
        CommandOutcome::IgnoredStale,
        "a duplicate of the pre-outage raise is stale after the resume"
    );
    server.advance(SETTLE_TICKS);
    assert_eq!(server.guard(), None, "the released guard stays lowered");
}

/// A resumed client may re-assert a guard it still holds. Re-asserting an already raised
/// guard must not restart the raise (which would open an unprotected window just because
/// the connection blipped). Breaks if `SetGuard { raised: true }` resets the stance.
#[test]
fn dedicated_reasserting_a_still_held_guard_after_resume_keeps_it_raised() {
    let (mut server, next) = Dedicated::raised();
    server.outage_and_resume(2);
    assert_eq!(
        server.submit(next, ArpgCommand::SetGuard { raised: true }),
        CommandOutcome::Applied
    );
    assert_eq!(server.guard(), RAISED, "re-assertion restarted the raise");
    server.advance(1);
    assert_eq!(server.guard(), RAISED, "re-assertion restarted the raise");
}

/// Peer host: a guest whose link drops is removed (`participant-disconnected` →
/// `removePlayer`) and re-added on its next `peer-ready`. The re-joined player starts with a
/// lowered guard whatever the guest still holds, so a guest still holding the key must
/// re-assert it, and its continued sequence is accepted by the fresh player.
#[test]
fn peer_rejoin_starts_lowered_and_a_reasserted_raise_raises_again() {
    const GUEST: PlayerId = 2;
    let mut host = arena();
    host.add_player(1).unwrap();
    host.add_player(GUEST).unwrap();
    host.apply_command(
        PlayerCommand::new(GUEST, 1, ArpgCommand::SetGuard { raised: true }).unwrap(),
    )
    .unwrap();
    for _ in 0..SETTLE_TICKS {
        host.advance_tick().unwrap();
    }
    assert_eq!(guard_of(&host.snapshot().unwrap(), GUEST), RAISED);

    assert!(host.remove_player(GUEST));
    host.advance_tick().unwrap();
    host.add_player(GUEST).unwrap();
    for _ in 0..SETTLE_TICKS {
        host.advance_tick().unwrap();
    }
    assert_eq!(
        guard_of(&host.snapshot().unwrap(), GUEST),
        None,
        "a re-joined guest starts lowered: the host does not remember the held key"
    );

    // The guest's runtime keeps counting sequences across the re-join.
    host.apply_command(
        PlayerCommand::new(GUEST, 7, ArpgCommand::SetGuard { raised: true }).unwrap(),
    )
    .unwrap();
    for _ in 0..SETTLE_TICKS {
        host.advance_tick().unwrap();
    }
    assert_eq!(guard_of(&host.snapshot().unwrap(), GUEST), RAISED);
}
