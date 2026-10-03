//! Test-only measurements around the actual game tick, shared unchanged with the old pin control.
use super::*;
use physics_engine::{StepReport, StepStats};
use std::{
    cell::Cell,
    fs,
    mem::size_of,
    time::{Duration, Instant},
};

#[derive(Clone, Copy)]
pub(super) struct PhysicsSample {
    pub elapsed: Duration,
    pub stats: StepStats,
}
thread_local! {
    static MEASURE: Cell<bool> = const { Cell::new(false) };
    static LAST: Cell<Option<PhysicsSample>> = const { Cell::new(None) };
}
pub(super) fn start_physics() -> Option<Instant> {
    MEASURE.get().then(Instant::now)
}
pub(super) fn finish_physics(start: Option<Instant>, report: &StepReport) {
    if let Some(start) = start {
        LAST.set(Some(PhysicsSample {
            elapsed: start.elapsed(),
            stats: report.stats,
        }));
    }
}
pub(super) fn timed_tick(game: &mut ArpgGame) -> (Duration, PhysicsSample) {
    LAST.set(None);
    MEASURE.set(true);
    let start = Instant::now();
    let result = game.advance_tick();
    let elapsed = start.elapsed();
    MEASURE.set(false);
    result.unwrap();
    (
        elapsed,
        LAST.get().expect("actual game tick must execute physics"),
    )
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Case {
    Quiet,
    PartyQuiet,
    Sparse,
    Corner,
    Door,
    Correction,
    Combat,
    Crowd,
    Lifecycle,
}
impl Case {
    const ALL: [Self; 9] = [
        Self::Quiet,
        Self::PartyQuiet,
        Self::Sparse,
        Self::Corner,
        Self::Door,
        Self::Correction,
        Self::Combat,
        Self::Crowd,
        Self::Lifecycle,
    ];
    fn name(self) -> &'static str {
        match self {
            Self::Quiet => "quiet",
            Self::PartyQuiet => "party-quiet",
            Self::Sparse => "sparse",
            Self::Corner => "corner",
            Self::Door => "door",
            Self::Correction => "correction",
            Self::Combat => "combat",
            Self::Crowd => "crowd",
            Self::Lifecycle => "lifecycle",
        }
    }
}
pub(super) fn fixture(case: Case, seed: u32) -> ArpgGame {
    let mut game = ArpgGame::new_with_seed(seed).unwrap();
    match case {
        Case::Corner => game.player_spawns[0] = Vec3i::new(-2945, PLAYER_Y, -1745),
        Case::Correction => game.player_spawns[0] = Vec3i::new(-2970, PLAYER_Y, -1600),
        Case::Door => {
            let door = game
                .doors
                .iter()
                .find(|door| door.room_a == 1 && door.room_b == 2)
                .unwrap();
            game.player_spawns[0] = Vec3i::new(door.position[0] - 90, PLAYER_Y, door.position[2]);
        }
        Case::Combat | Case::Crowd => {
            let (x, z) = game
                .rooms
                .iter()
                .find(|room| room.id == 2)
                .unwrap()
                .center();
            game.player_spawns[0] = Vec3i::new(x, PLAYER_Y, z);
            if case == Case::Combat {
                game.monsters
                    .iter_mut()
                    .find(|monster| monster.room_id == 2)
                    .unwrap()
                    .position = Vec3i::new(x + 100, PLAYER_Y, z);
            } else {
                // Relocate all five generated enemies; use ordinary encounter/attack rules.
                for (index, monster) in game.monsters.iter_mut().enumerate() {
                    monster.room_id = 2;
                    monster.position = Vec3i::new(
                        x + if index % 2 == 0 { 100 } else { -100 },
                        PLAYER_Y,
                        z + (i32::try_from(index).unwrap() - 2) * 50,
                    );
                }
            }
        }
        _ => {}
    }
    let count = if matches!(case, Case::PartyQuiet | Case::Sparse | Case::Lifecycle) {
        4
    } else {
        1
    };
    for id in 1..=count {
        game.add_player(id).unwrap();
    }
    game.reconcile_encounters().unwrap();
    game
}
fn commands(game: &mut ArpgGame, case: Case, tick: u32) -> (Vec<String>, Duration) {
    let mut outcomes = Vec::new();
    let mut elapsed = Duration::ZERO;
    if case == Case::Lifecycle {
        if tick == 40 {
            let start = Instant::now();
            let removed = game.remove_player(4);
            elapsed += start.elapsed();
            outcomes.push(format!("remove:4:{removed}"));
        }
        if tick == 70 {
            let start = Instant::now();
            let added = game.add_player(4);
            elapsed += start.elapsed();
            outcomes.push(format!("add:4:{added:?}"));
        }
    }
    let command = match case {
        Case::Sparse | Case::Lifecycle if tick.is_multiple_of(24) => {
            let (x, z) = [(1, 0), (0, 1), (-1, 0), (0, -1)][(tick / 24) as usize % 4];
            Some(ArpgCommand::SetMovement { x, z })
        }
        Case::Corner if tick == 0 => Some(ArpgCommand::SetMovement { x: -1, z: -1 }),
        Case::Door if tick == 0 => Some(ArpgCommand::SetMovement { x: 1, z: 0 }),
        Case::Combat if tick < 64 && tick.is_multiple_of(16) => Some(ArpgCommand::PrimaryAttack),
        Case::Combat if tick == 64 => Some(ArpgCommand::SecondaryAttack),
        Case::Combat if tick == 96 => Some(ArpgCommand::Interact),
        Case::Crowd if tick.is_multiple_of(24) => Some(if tick < 96 {
            ArpgCommand::PrimaryAttack
        } else {
            ArpgCommand::Interact
        }),
        _ => None,
    };
    if let Some(command) = command {
        let input = PlayerCommand::new(1, tick + 1, command).unwrap();
        let start = Instant::now();
        let result = game.apply_command(input);
        elapsed += start.elapsed();
        outcomes.push(format!("{command:?}:{result:?}"));
    }
    (outcomes, elapsed)
}
fn frame(game: &ArpgGame, payload: &[u8], commands: &[String]) -> Vec<u8> {
    let bodies = game.world.bodies().collect::<Vec<_>>();
    let hidden = format!(
        "{:?}",
        (
            &game.players,
            &game.last_sequences,
            &game.monsters,
            &game.ground_loot,
            game.next_ground_loot_id,
            game.player_spawns,
            bodies,
            commands
        )
    );
    let mut bytes = Vec::new();
    for part in [payload, hidden.as_bytes()] {
        bytes.extend_from_slice(&(part.len() as u64).to_le_bytes());
        bytes.extend_from_slice(part);
    }
    bytes
}
struct Measurement {
    trace: Vec<u8>,
    tick: u128,
    physics: u128,
    adapter: u128,
    command: u128,
    observer_body_pointer_bytes: usize,
    stats: Vec<StepStats>,
    end: ArpgSnapshot,
}
fn replay(case: Case, seed: u32, ticks: u32) -> Measurement {
    let mut game = fixture(case, seed);
    let mut m = Measurement {
        trace: Vec::new(),
        tick: 0,
        physics: 0,
        adapter: 0,
        command: 0,
        observer_body_pointer_bytes: 0,
        stats: Vec::new(),
        end: game.snapshot().unwrap(),
    };
    for tick in 0..ticks {
        let (command_outcomes, elapsed) = commands(&mut game, case, tick);
        m.command += elapsed.as_nanos();
        let (elapsed, physics) = timed_tick(&mut game);
        m.tick += elapsed.as_nanos();
        m.physics += physics.elapsed.as_nanos();
        m.stats.push(physics.stats);
        let start = Instant::now();
        let snapshot = game.snapshot().unwrap();
        let payload = serde_json::to_vec(&snapshot).unwrap();
        m.adapter += start.elapsed().as_nanos();
        m.observer_body_pointer_bytes += game.world.bodies().count() * size_of::<&RigidBody>();
        m.trace.extend(frame(&game, &payload, &command_outcomes));
        m.end = snapshot;
    }
    assert_eq!(m.end.tick, u64::from(ticks));
    match case {
        Case::Corner => {
            assert!(m.end.players[0].position[0] >= -2945);
            assert!(m.end.players[0].position[2] >= -1745);
        }
        Case::Correction => assert!(m.end.players[0].position[0] >= -2945),
        Case::Door if ticks >= 120 => assert!(m.end.doors.iter().any(|door| door.locked)),
        Case::Combat if ticks >= 120 => {
            assert_eq!(m.end.players[0].experience, 50);
            assert_eq!(m.end.players[0].gold, 10);
        }
        Case::Lifecycle if ticks >= 120 => assert_eq!(m.end.players.len(), 4),
        _ => {}
    }
    m
}
#[test]
fn actual_seeded_ticks_preserve_wall_door_correction_combat_and_lifecycle_acceptance() {
    for seed in [42, 0xDEAD_BEEF] {
        for case in Case::ALL {
            let first = replay(case, seed, 120);
            let second = replay(case, seed, 120);
            assert_eq!(first.trace, second.trace, "{} seed {seed}", case.name());
        }
    }
}
#[test]
#[ignore = "explicit paired whole-game measurements and complete trace oracle"]
fn seeded_physics_workload_matrix() {
    let output = std::env::var_os("ARPG_PHYSICS_TRACE_DIR");
    let reference = std::env::var_os("ARPG_PHYSICS_REFERENCE_DIR");
    if let Some(path) = &output {
        fs::create_dir_all(path).unwrap();
    }
    for seed in [42, 0xDEAD_BEEF, 0xA420_0916] {
        for case in Case::ALL {
            for trial in 0..3 {
                let m = replay(case, seed, 120);
                let name = format!("{}-{seed}-{trial}.trace", case.name());
                if let Some(path) = &reference {
                    assert_eq!(
                        m.trace,
                        fs::read(std::path::Path::new(path).join(&name)).unwrap(),
                        "old/new full game trace: {name}"
                    );
                }
                if let Some(path) = &output {
                    fs::write(std::path::Path::new(path).join(&name), &m.trace).unwrap();
                }
                println!(
                    "ARPG_PHYSICS {}",
                    serde_json::json!({
                        "case":case.name(),"seed":seed,"trial":trial,"ticks":120,
                        "tick_ms":m.tick as f64/1e6,"physics_ms":m.physics as f64/1e6,
                        "nonphysics_tick_ms":(m.tick-m.physics) as f64/1e6,
                        "command_dispatch_ms":m.command as f64/1e6,"snapshot_payload_ms":m.adapter as f64/1e6,
                        "trace_bytes":m.trace.len(),"observer_body_pointer_bytes":m.observer_body_pointer_bytes,
                        "final_players":m.end.players.len(),"final_monsters":m.end.monsters.len(),
                        "last_step_stats":format!("{:?}",m.stats.last().unwrap()),
                    })
                );
            }
        }
    }
}
