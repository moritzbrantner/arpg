#![forbid(unsafe_code)]

use std::collections::BTreeMap;
use std::error::Error;
use std::fmt;

use physics_engine::{BodyId, RigidBody, Vec3i, World, WorldConfig};
use serde::{Deserialize, Serialize};

pub type PlayerId = u32;
pub const TICK_HZ: u16 = 60;
pub const MAX_PLAYERS: usize = 4;
pub const WORLD_UNITS_PER_METER: i32 = 100;
const PLAYER_SPEED: i32 = 420;
const PLAYER_DIAGONAL_SPEED: i32 = 297;
const PLAYER_BODY_BASE: u64 = 1_000;
const STATIC_BODY_BASE: u64 = 10_000;
const PLAYER_HALF_EXTENTS: Vec3i = Vec3i::new(30, 50, 30);
const PLAYER_Y: i32 = 50;
const ATTACK_RANGE: i64 = 220;
const ATTACK_DAMAGE: u16 = 25;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GameError {
    message: String,
}

impl GameError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }

    pub fn message(&self) -> &str {
        &self.message
    }
}

impl fmt::Display for GameError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl Error for GameError {}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PlayerCommand<C> {
    pub player_id: PlayerId,
    pub sequence: u32,
    pub command: C,
}

impl<C> PlayerCommand<C> {
    pub fn new(player_id: PlayerId, sequence: u32, command: C) -> Result<Self, GameError> {
        if sequence == 0 {
            return Err(GameError::new("command sequence must be non-zero"));
        }
        Ok(Self {
            player_id,
            sequence,
            command,
        })
    }
}

/// Transport-neutral authority boundary for one ARPG simulation instance.
///
/// Local play, a browser peer host, and a dedicated `game-server` host all
/// drive the same implementation. Rendering and transport stay outside core.
pub trait AuthoritativeGame: Send + 'static {
    type Command: Send + 'static;
    type Snapshot: Send + 'static;

    fn tick_hz(&self) -> u16;
    fn max_players(&self) -> usize;
    fn current_tick(&self) -> u64;
    fn add_player(&mut self, player_id: PlayerId) -> Result<(), GameError>;
    fn remove_player(&mut self, player_id: PlayerId) -> bool;
    fn apply_command(&mut self, command: PlayerCommand<Self::Command>) -> Result<(), GameError>;
    fn advance_tick(&mut self) -> Result<(), GameError>;
    fn snapshot(&self) -> Result<Self::Snapshot, GameError>;
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ArpgCommand {
    SetMovement { x: i8, z: i8 },
    PrimaryAttack,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArpgSnapshot {
    pub schema_version: u16,
    pub tick: u64,
    pub world_units_per_meter: i32,
    pub players: Vec<PlayerSnapshot>,
    pub monsters: Vec<MonsterSnapshot>,
    pub static_colliders: Vec<StaticColliderSnapshot>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerSnapshot {
    pub id: PlayerId,
    pub position: [i32; 3],
    pub health: u16,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MonsterSnapshot {
    pub id: u32,
    pub position: [i32; 3],
    pub health: u16,
    pub alive: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StaticColliderSnapshot {
    pub id: u64,
    pub position: [i32; 3],
    pub half_extents: [i32; 3],
    pub kind: StaticColliderKind,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StaticColliderKind {
    Wall,
    Pillar,
}

#[derive(Clone, Copy, Debug)]
struct PlayerState {
    movement_x: i8,
    movement_z: i8,
    health: u16,
}

#[derive(Clone, Copy, Debug)]
struct MonsterState {
    id: u32,
    position: Vec3i,
    health: u16,
}

#[derive(Debug)]
pub struct ArpgGame {
    tick: u64,
    world: World,
    players: BTreeMap<PlayerId, PlayerState>,
    last_sequences: BTreeMap<PlayerId, u32>,
    monsters: Vec<MonsterState>,
    static_colliders: Vec<StaticColliderSnapshot>,
}

impl Default for ArpgGame {
    fn default() -> Self {
        Self::new().expect("built-in ARPG fixture must be valid")
    }
}

impl ArpgGame {
    pub fn new() -> Result<Self, GameError> {
        let mut world = World::new(WorldConfig {
            gravity: Vec3i::ZERO,
            ..WorldConfig::default()
        });
        let static_colliders = built_in_colliders();
        for collider in &static_colliders {
            world
                .add_body(RigidBody::fixed(
                    BodyId(collider.id),
                    array_to_vec(collider.position),
                    array_to_vec(collider.half_extents),
                ))
                .map_err(physics_error)?;
        }

        Ok(Self {
            tick: 0,
            world,
            players: BTreeMap::new(),
            last_sequences: BTreeMap::new(),
            monsters: vec![
                MonsterState {
                    id: 1,
                    position: Vec3i::new(-250, PLAYER_Y, -200),
                    health: 100,
                },
                MonsterState {
                    id: 2,
                    position: Vec3i::new(300, PLAYER_Y, 180),
                    health: 100,
                },
                MonsterState {
                    id: 3,
                    position: Vec3i::new(500, PLAYER_Y, -320),
                    health: 100,
                },
            ],
            static_colliders,
        })
    }

    fn player_body_id(player_id: PlayerId) -> BodyId {
        BodyId(PLAYER_BODY_BASE + u64::from(player_id))
    }

    fn movement_velocity(state: PlayerState) -> Vec3i {
        let x = i32::from(state.movement_x.clamp(-1, 1));
        let z = i32::from(state.movement_z.clamp(-1, 1));
        if x != 0 && z != 0 {
            Vec3i::new(x * PLAYER_DIAGONAL_SPEED, 0, z * PLAYER_DIAGONAL_SPEED)
        } else {
            Vec3i::new(x * PLAYER_SPEED, 0, z * PLAYER_SPEED)
        }
    }

    fn attack(&mut self, player_id: PlayerId) -> Result<(), GameError> {
        let player_position = self
            .world
            .body(Self::player_body_id(player_id))
            .ok_or_else(|| GameError::new("player physics body is missing"))?
            .position();
        let range_sq = ATTACK_RANGE * ATTACK_RANGE;
        let target = self
            .monsters
            .iter_mut()
            .filter(|monster| monster.health > 0)
            .filter_map(|monster| {
                let dx = i64::from(monster.position.x - player_position.x);
                let dz = i64::from(monster.position.z - player_position.z);
                let distance_sq = dx * dx + dz * dz;
                (distance_sq <= range_sq).then_some((distance_sq, monster.id, monster))
            })
            .min_by_key(|(distance_sq, id, _)| (*distance_sq, *id));

        if let Some((_, _, monster)) = target {
            monster.health = monster.health.saturating_sub(ATTACK_DAMAGE);
        }
        Ok(())
    }
}

impl AuthoritativeGame for ArpgGame {
    type Command = ArpgCommand;
    type Snapshot = ArpgSnapshot;

    fn tick_hz(&self) -> u16 {
        TICK_HZ
    }

    fn max_players(&self) -> usize {
        MAX_PLAYERS
    }

    fn current_tick(&self) -> u64 {
        self.tick
    }

    fn add_player(&mut self, player_id: PlayerId) -> Result<(), GameError> {
        if player_id == 0 {
            return Err(GameError::new("player id must be non-zero"));
        }
        if self.players.contains_key(&player_id) {
            return Err(GameError::new("player already exists"));
        }
        if self.players.len() >= MAX_PLAYERS {
            return Err(GameError::new("ARPG MVP player capacity reached"));
        }

        let spawn = spawn_position(self.players.len());
        self.world
            .add_body(RigidBody::dynamic(
                Self::player_body_id(player_id),
                spawn,
                Vec3i::ZERO,
                PLAYER_HALF_EXTENTS,
            ))
            .map_err(physics_error)?;
        self.players.insert(
            player_id,
            PlayerState {
                movement_x: 0,
                movement_z: 0,
                health: 100,
            },
        );
        self.last_sequences.insert(player_id, 0);
        Ok(())
    }

    fn remove_player(&mut self, player_id: PlayerId) -> bool {
        let removed = self.players.remove(&player_id).is_some();
        self.last_sequences.remove(&player_id);
        if removed {
            self.world.remove_body(Self::player_body_id(player_id));
        }
        removed
    }

    fn apply_command(&mut self, command: PlayerCommand<Self::Command>) -> Result<(), GameError> {
        if !self.players.contains_key(&command.player_id) {
            return Err(GameError::new("command references an unknown player"));
        }
        let last_sequence = self
            .last_sequences
            .get(&command.player_id)
            .copied()
            .unwrap_or_default();
        if command.sequence <= last_sequence {
            return Err(GameError::new("command sequence is stale"));
        }

        match command.command {
            ArpgCommand::SetMovement { x, z } => {
                let state = self
                    .players
                    .get_mut(&command.player_id)
                    .expect("player existence checked");
                state.movement_x = x.clamp(-1, 1);
                state.movement_z = z.clamp(-1, 1);
            }
            ArpgCommand::PrimaryAttack => self.attack(command.player_id)?,
        }
        self.last_sequences
            .insert(command.player_id, command.sequence);
        Ok(())
    }

    fn advance_tick(&mut self) -> Result<(), GameError> {
        for (&player_id, &state) in &self.players {
            self.world
                .set_velocity(
                    Self::player_body_id(player_id),
                    Self::movement_velocity(state),
                )
                .map_err(physics_error)?;
        }
        self.world.step(1).map_err(physics_error)?;
        self.tick = self
            .tick
            .checked_add(1)
            .ok_or_else(|| GameError::new("tick overflow"))?;
        Ok(())
    }

    fn snapshot(&self) -> Result<Self::Snapshot, GameError> {
        let players = self
            .players
            .iter()
            .map(|(&id, state)| {
                let body = self
                    .world
                    .body(Self::player_body_id(id))
                    .ok_or_else(|| GameError::new("player physics body is missing"))?;
                Ok(PlayerSnapshot {
                    id,
                    position: vec_to_array(body.position()),
                    health: state.health,
                })
            })
            .collect::<Result<Vec<_>, GameError>>()?;

        Ok(ArpgSnapshot {
            schema_version: 1,
            tick: self.tick,
            world_units_per_meter: WORLD_UNITS_PER_METER,
            players,
            monsters: self
                .monsters
                .iter()
                .map(|monster| MonsterSnapshot {
                    id: monster.id,
                    position: vec_to_array(monster.position),
                    health: monster.health,
                    alive: monster.health > 0,
                })
                .collect(),
            static_colliders: self.static_colliders.clone(),
        })
    }
}

fn built_in_colliders() -> Vec<StaticColliderSnapshot> {
    let definitions = [
        (
            0,
            [0, PLAYER_Y, -650],
            [900, 100, 25],
            StaticColliderKind::Wall,
        ),
        (
            1,
            [0, PLAYER_Y, 650],
            [900, 100, 25],
            StaticColliderKind::Wall,
        ),
        (
            2,
            [-900, PLAYER_Y, 0],
            [25, 100, 650],
            StaticColliderKind::Wall,
        ),
        (
            3,
            [900, PLAYER_Y, 0],
            [25, 100, 650],
            StaticColliderKind::Wall,
        ),
        (
            4,
            [0, PLAYER_Y, 0],
            [55, 100, 55],
            StaticColliderKind::Pillar,
        ),
        (
            5,
            [280, PLAYER_Y, -120],
            [55, 100, 55],
            StaticColliderKind::Pillar,
        ),
        (
            6,
            [-120, PLAYER_Y, 300],
            [55, 100, 55],
            StaticColliderKind::Pillar,
        ),
    ];
    definitions
        .into_iter()
        .map(
            |(index, position, half_extents, kind)| StaticColliderSnapshot {
                id: STATIC_BODY_BASE + index,
                position,
                half_extents,
                kind,
            },
        )
        .collect()
}

fn spawn_position(index: usize) -> Vec3i {
    const SPAWNS: [Vec3i; MAX_PLAYERS] = [
        Vec3i::new(-400, PLAYER_Y, -200),
        Vec3i::new(-400, PLAYER_Y, -80),
        Vec3i::new(-280, PLAYER_Y, -200),
        Vec3i::new(-280, PLAYER_Y, -80),
    ];
    SPAWNS[index]
}

fn physics_error(error: impl fmt::Display) -> GameError {
    GameError::new(format!("physics-engine: {error}"))
}

const fn vec_to_array(value: Vec3i) -> [i32; 3] {
    [value.x, value.y, value.z]
}

const fn array_to_vec(value: [i32; 3]) -> Vec3i {
    Vec3i::new(value[0], value[1], value[2])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_sequence_must_be_non_zero() {
        assert_eq!(
            PlayerCommand::new(7, 0, ()).unwrap_err().message(),
            "command sequence must be non-zero"
        );
    }

    #[test]
    fn wasd_style_movement_is_driven_through_physics_engine() {
        let mut game = ArpgGame::new().unwrap();
        game.add_player(1).unwrap();
        let before = game.snapshot().unwrap().players[0].position;
        game.apply_command(
            PlayerCommand::new(1, 1, ArpgCommand::SetMovement { x: 1, z: 0 }).unwrap(),
        )
        .unwrap();
        for _ in 0..10 {
            game.advance_tick().unwrap();
        }
        let after = game.snapshot().unwrap().players[0].position;
        assert!(after[0] > before[0]);
        assert_eq!(after[2], before[2]);
    }

    #[test]
    fn fixed_dungeon_boundary_stops_the_player() {
        let mut game = ArpgGame::new().unwrap();
        game.add_player(1).unwrap();
        game.apply_command(
            PlayerCommand::new(1, 1, ArpgCommand::SetMovement { x: 1, z: 0 }).unwrap(),
        )
        .unwrap();
        for _ in 0..400 {
            game.advance_tick().unwrap();
        }
        let x = game.snapshot().unwrap().players[0].position[0];
        assert!(x <= 845, "player crossed the east wall: {x}");
    }

    #[test]
    fn primary_attack_is_core_owned_and_deterministic() {
        let mut game = ArpgGame::new().unwrap();
        game.add_player(1).unwrap();
        for sequence in 1..=4 {
            game.apply_command(
                PlayerCommand::new(1, sequence, ArpgCommand::PrimaryAttack).unwrap(),
            )
            .unwrap();
        }
        let snapshot = game.snapshot().unwrap();
        let monster = &snapshot.monsters[0];
        assert_eq!(monster.health, 0);
        assert!(!monster.alive);
    }

    #[test]
    fn stale_commands_fail_closed() {
        let mut game = ArpgGame::new().unwrap();
        game.add_player(1).unwrap();
        game.apply_command(
            PlayerCommand::new(1, 5, ArpgCommand::SetMovement { x: 1, z: 0 }).unwrap(),
        )
        .unwrap();
        let error = game
            .apply_command(
                PlayerCommand::new(1, 5, ArpgCommand::SetMovement { x: -1, z: 0 }).unwrap(),
            )
            .unwrap_err();
        assert_eq!(error.message(), "command sequence is stale");
    }
}
