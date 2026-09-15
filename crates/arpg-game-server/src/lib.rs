#![forbid(unsafe_code)]

use arpg_core::{AuthoritativeGame, PlayerCommand};
use arpg_protocol::WireProtocol;
use game_server::{GameSimulation, SimulationError, SimulationSnapshot};

pub const PINNED_GAME_SERVER_REVISION: &str = "81cad7a4d80849d13c37120a411d3a053c46f9a0";

pub struct GameServerAdapter<G, P> {
    game: G,
    protocol: P,
}

impl<G, P> GameServerAdapter<G, P> {
    pub fn new(game: G, protocol: P) -> Self {
        Self { game, protocol }
    }

    pub fn game(&self) -> &G {
        &self.game
    }

    pub fn game_mut(&mut self) -> &mut G {
        &mut self.game
    }

    pub fn into_parts(self) -> (G, P) {
        (self.game, self.protocol)
    }
}

impl<G, P> GameSimulation for GameServerAdapter<G, P>
where
    G: AuthoritativeGame,
    P: WireProtocol<G::Command, G::Snapshot>,
{
    fn tick_hz(&self) -> u16 {
        self.game.tick_hz()
    }

    fn max_players(&self) -> usize {
        self.game.max_players()
    }

    fn current_tick(&self) -> u64 {
        self.game.current_tick()
    }

    fn add_player(&mut self, player_id: game_server::PlayerId) -> Result<(), SimulationError> {
        self.game.add_player(player_id).map_err(map_game_error)
    }

    fn remove_player(&mut self, player_id: game_server::PlayerId) -> bool {
        self.game.remove_player(player_id)
    }

    fn apply_command(
        &mut self,
        player_id: game_server::PlayerId,
        sequence: u32,
        payload: &[u8],
    ) -> Result<(), SimulationError> {
        let command = self
            .protocol
            .decode_command(payload)
            .map_err(map_protocol_error)?;
        let command = PlayerCommand::new(player_id, sequence, command).map_err(map_game_error)?;
        self.game.apply_command(command).map_err(map_game_error)
    }

    fn advance_tick(&mut self) -> Result<(), SimulationError> {
        self.game.advance_tick().map_err(map_game_error)
    }

    fn snapshot(&self) -> Result<SimulationSnapshot, SimulationError> {
        let snapshot = self.game.snapshot().map_err(map_game_error)?;
        let payload = self
            .protocol
            .encode_snapshot(&snapshot)
            .map_err(map_protocol_error)?;
        Ok(SimulationSnapshot::new(self.game.current_tick(), payload))
    }
}

fn map_game_error(error: arpg_core::GameError) -> SimulationError {
    SimulationError::new(error.to_string())
}

fn map_protocol_error(error: arpg_protocol::ProtocolError) -> SimulationError {
    SimulationError::new(error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use arpg_core::{GameError, PlayerId};
    use arpg_protocol::ProtocolError;
    use std::collections::BTreeSet;

    #[derive(Clone, Debug, Eq, PartialEq)]
    struct TestSnapshot {
        tick: u64,
        player_count: u8,
        last_value: u8,
    }

    #[derive(Default)]
    struct TestGame {
        tick: u64,
        players: BTreeSet<PlayerId>,
        commands: Vec<PlayerCommand<u8>>,
    }

    impl AuthoritativeGame for TestGame {
        type Command = u8;
        type Snapshot = TestSnapshot;

        fn tick_hz(&self) -> u16 {
            20
        }

        fn max_players(&self) -> usize {
            4
        }

        fn current_tick(&self) -> u64 {
            self.tick
        }

        fn add_player(&mut self, player_id: PlayerId) -> Result<(), GameError> {
            if !self.players.insert(player_id) {
                return Err(GameError::new("player already exists"));
            }
            Ok(())
        }

        fn remove_player(&mut self, player_id: PlayerId) -> bool {
            self.players.remove(&player_id)
        }

        fn apply_command(
            &mut self,
            command: PlayerCommand<Self::Command>,
        ) -> Result<(), GameError> {
            if !self.players.contains(&command.player_id) {
                return Err(GameError::new("unknown player"));
            }
            self.commands.push(command);
            Ok(())
        }

        fn advance_tick(&mut self) -> Result<(), GameError> {
            self.tick += 1;
            Ok(())
        }

        fn snapshot(&self) -> Result<Self::Snapshot, GameError> {
            let player_count = u8::try_from(self.players.len())
                .map_err(|_| GameError::new("too many players for test snapshot"))?;
            Ok(TestSnapshot {
                tick: self.tick,
                player_count,
                last_value: self.commands.last().map_or(0, |command| command.command),
            })
        }
    }

    struct TestProtocol;

    impl WireProtocol<u8, TestSnapshot> for TestProtocol {
        fn encode_command(&self, command: &u8) -> Result<Vec<u8>, ProtocolError> {
            Ok(vec![*command])
        }

        fn decode_command(&self, payload: &[u8]) -> Result<u8, ProtocolError> {
            match payload {
                [value] => Ok(*value),
                _ => Err(ProtocolError::new("expected one command byte")),
            }
        }

        fn encode_snapshot(&self, snapshot: &TestSnapshot) -> Result<Vec<u8>, ProtocolError> {
            let mut payload = Vec::with_capacity(10);
            payload.extend_from_slice(&snapshot.tick.to_be_bytes());
            payload.push(snapshot.player_count);
            payload.push(snapshot.last_value);
            Ok(payload)
        }

        fn decode_snapshot(&self, payload: &[u8]) -> Result<TestSnapshot, ProtocolError> {
            if payload.len() != 10 {
                return Err(ProtocolError::new("expected ten snapshot bytes"));
            }
            let tick = u64::from_be_bytes(payload[0..8].try_into().expect("checked length"));
            Ok(TestSnapshot {
                tick,
                player_count: payload[8],
                last_value: payload[9],
            })
        }
    }

    #[test]
    fn preserves_player_and_command_sequence_at_the_core_boundary() {
        let mut adapter = GameServerAdapter::new(TestGame::default(), TestProtocol);
        adapter.add_player(7).unwrap();
        adapter.apply_command(7, 11, &[42]).unwrap();

        assert_eq!(
            adapter.game().commands,
            vec![PlayerCommand {
                player_id: 7,
                sequence: 11,
                command: 42,
            }]
        );
    }

    #[test]
    fn publishes_game_server_snapshots_from_typed_core_state() {
        let mut adapter = GameServerAdapter::new(TestGame::default(), TestProtocol);
        adapter.add_player(3).unwrap();
        adapter.apply_command(3, 1, &[9]).unwrap();
        adapter.advance_tick().unwrap();

        let snapshot = adapter.snapshot().unwrap();
        assert_eq!(snapshot.tick, 1);
        assert_eq!(snapshot.payload, vec![0, 0, 0, 0, 0, 0, 0, 1, 1, 9]);
        assert_eq!(
            snapshot.state_hash,
            game_server::snapshot_hash(snapshot.tick, &snapshot.payload)
        );
    }

    #[test]
    fn rejects_malformed_game_payloads_before_the_core_sees_them() {
        let mut adapter = GameServerAdapter::new(TestGame::default(), TestProtocol);
        adapter.add_player(1).unwrap();

        let error = adapter.apply_command(1, 1, &[1, 2]).unwrap_err();
        assert_eq!(error.to_string(), "expected one command byte");
        assert!(adapter.game().commands.is_empty());
    }

    #[test]
    fn real_arpg_snapshot_matches_the_game_server_runtime_path() {
        use arpg_core::{ArpgCommand, ArpgGame};
        use arpg_protocol::JsonProtocol;
        use game_server::{MatchRuntime, RECONNECT_TOKEN_BYTES, ReconnectToken};

        let command = ArpgCommand::SetMovement { x: 1, z: 0 };
        let protocol = JsonProtocol;

        let mut local = ArpgGame::new().unwrap();
        local.add_player(1).unwrap();
        local
            .apply_command(PlayerCommand::new(1, 1, command).unwrap())
            .unwrap();
        for _ in 0..12 {
            local.advance_tick().unwrap();
        }
        let local_snapshot = local.snapshot().unwrap();

        let adapter = GameServerAdapter::new(ArpgGame::new().unwrap(), JsonProtocol);
        let mut runtime = MatchRuntime::new(adapter, 120);
        let lease = runtime
            .admit(ReconnectToken([7; RECONNECT_TOKEN_BYTES]))
            .unwrap();
        assert_eq!(lease.player_id, 1);
        let encoded = protocol.encode_command(&command).unwrap();
        runtime
            .submit_command(
                lease.player_id,
                lease.connection_epoch,
                1,
                &encoded,
            )
            .unwrap();
        for _ in 0..12 {
            runtime.advance_tick().unwrap();
        }
        let server_snapshot = runtime.snapshot().unwrap();
        let decoded = protocol.decode_snapshot(&server_snapshot.payload).unwrap();

        assert_eq!(decoded, local_snapshot);
    }
}
