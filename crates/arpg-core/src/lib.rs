#![forbid(unsafe_code)]

use std::collections::{BTreeMap, BTreeSet};
use std::error::Error;
use std::fmt;

use physics_engine::{BodyId, RigidBody, Vec3i, World, WorldConfig};
use serde::{Deserialize, Serialize};

pub type DoorId = u64;
pub type GroundLootId = u64;
pub type PlayerId = u32;
pub type RoomId = u32;
pub type RunSeed = u32;
pub const TICK_HZ: u16 = 60;
pub const MAX_PLAYERS: usize = 4;
pub const WORLD_UNITS_PER_METER: i32 = 100;
pub const SAVE_STATE_SCHEMA_VERSION: u16 = 1;
// physics-engine::World::step(1) integrates velocity as world units per simulation tick.
// At 60 Hz and 100 world units per meter, 7 units/tick is 4.2 m/s rather than
// the previous 260 units/tick (156 m/s).
const PLAYER_SPEED: i32 = 7;
const PLAYER_DIAGONAL_SPEED: i32 = 5;
const PLAYER_BODY_BASE: u64 = 1_000;
const STATIC_BODY_BASE: u64 = 10_000;
const DOOR_BODY_BASE: u64 = 20_000;
const GROUND_LOOT_ID_BASE: u64 = 30_000;
const PLAYER_HALF_EXTENTS: Vec3i = Vec3i::new(30, 50, 30);
const PLAYER_Y: i32 = 50;
const ATTACK_RANGE: i64 = 220;
const SECONDARY_ATTACK_RANGE: i64 = 150;
const SECONDARY_ATTACK_DAMAGE_NUMERATOR: u16 = 3;
const SECONDARY_ATTACK_DAMAGE_DENOMINATOR: u16 = 2;
const PRIMARY_WINDUP_TICKS: u8 = 5;
const PRIMARY_ACTIVE_TICKS: u8 = 1;
const PRIMARY_RECOVERY_TICKS: u8 = 8;
const SECONDARY_WINDUP_TICKS: u8 = 10;
const SECONDARY_ACTIVE_TICKS: u8 = 1;
const SECONDARY_RECOVERY_TICKS: u8 = 14;
const INTERACT_WINDUP_TICKS: u8 = 2;
const INTERACT_ACTIVE_TICKS: u8 = 1;
const INTERACT_RECOVERY_TICKS: u8 = 3;
const INTERACT_RANGE: i64 = 160;
const GROUND_LOOT_GOLD_AMOUNT: u32 = 10;
const MONSTER_ATTACK_RANGE: i64 = 180;
const MONSTER_ATTACK_DAMAGE: u16 = 10;
const MONSTER_ATTACK_WINDUP_TICKS: u8 = 18;
const MONSTER_ATTACK_ACTIVE_TICKS: u8 = 1;
const MONSTER_ATTACK_RECOVERY_TICKS: u8 = 30;
const PLAYER_HURT_TICKS: u8 = 6;
const PRIMARY_STAGGER_TICKS: u8 = 4;
const SECONDARY_STAGGER_TICKS: u8 = 8;
const BASE_ATTACK_DAMAGE: u16 = 25;
const ATTACK_DAMAGE_PER_LEVEL: u16 = 5;
const BASE_MAX_HEALTH: u16 = 100;
const MAX_HEALTH_PER_LEVEL: u16 = 10;
const EXPERIENCE_PER_LEVEL: u32 = 100;
const MONSTER_EXPERIENCE_REWARD: u32 = 50;
const DEFAULT_DUNGEON_SEED: RunSeed = 0xA420_0916;
const ARENA_HALF_WIDTH: i32 = 3_000;
const ARENA_HALF_DEPTH: i32 = 1_800;
const WALL_HALF_THICKNESS: i32 = 25;
const WALL_HALF_HEIGHT: i32 = 100;
const DOOR_HALF_WIDTH: i32 = 90;
const PARTITION_MARGIN: i32 = 25;
const DOOR_EDGE_MARGIN: i32 = 250;
const ROOM_SPAWN_MARGIN: i32 = 220;
const PLAYER_SPAWN_OFFSET: i32 = 60;
const ROOM_ACTIVATION_MARGIN: i32 = 30;

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
    SecondaryAttack,
    Interact,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ActionKind {
    PrimaryAttack,
    SecondaryAttack,
    Interact,
}

impl ActionKind {
    const fn windup_ticks(self) -> u8 {
        match self {
            Self::PrimaryAttack => PRIMARY_WINDUP_TICKS,
            Self::SecondaryAttack => SECONDARY_WINDUP_TICKS,
            Self::Interact => INTERACT_WINDUP_TICKS,
        }
    }

    const fn active_ticks(self) -> u8 {
        match self {
            Self::PrimaryAttack => PRIMARY_ACTIVE_TICKS,
            Self::SecondaryAttack => SECONDARY_ACTIVE_TICKS,
            Self::Interact => INTERACT_ACTIVE_TICKS,
        }
    }

    const fn recovery_ticks(self) -> u8 {
        match self {
            Self::PrimaryAttack => PRIMARY_RECOVERY_TICKS,
            Self::SecondaryAttack => SECONDARY_RECOVERY_TICKS,
            Self::Interact => INTERACT_RECOVERY_TICKS,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ActionPhase {
    Windup,
    Active,
    Recovery,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerActionSnapshot {
    pub kind: ActionKind,
    pub phase: ActionPhase,
    pub ticks_remaining: u8,
    pub facing: [i8; 2],
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MonsterReactionKind {
    Stagger,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MonsterReactionSnapshot {
    pub kind: MonsterReactionKind,
    pub ticks_remaining: u8,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PlayerReactionKind {
    Hurt,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerReactionSnapshot {
    pub kind: PlayerReactionKind,
    pub ticks_remaining: u8,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MonsterActionSnapshot {
    pub phase: ActionPhase,
    pub ticks_remaining: u8,
    pub target_player_id: PlayerId,
    pub range: i32,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArpgSnapshot {
    pub schema_version: u16,
    pub run_seed: RunSeed,
    pub tick: u64,
    pub world_units_per_meter: i32,
    pub rooms: Vec<RoomSnapshot>,
    pub doors: Vec<DoorSnapshot>,
    pub players: Vec<PlayerSnapshot>,
    pub monsters: Vec<MonsterSnapshot>,
    pub ground_loot: Vec<GroundLootSnapshot>,
    pub static_colliders: Vec<StaticColliderSnapshot>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomSnapshot {
    pub id: RoomId,
    pub min_x: i32,
    pub max_x: i32,
    pub min_z: i32,
    pub max_z: i32,
    pub kind: RoomKind,
    pub encounter_state: RoomEncounterState,
    pub neighbors: Vec<RoomId>,
}

impl RoomSnapshot {
    fn contains_xz_with_margin(&self, position: Vec3i, margin: i32) -> bool {
        position.x >= self.min_x + margin
            && position.x <= self.max_x - margin
            && position.z >= self.min_z + margin
            && position.z <= self.max_z - margin
    }

    fn center(&self) -> (i32, i32) {
        ((self.min_x + self.max_x) / 2, (self.min_z + self.max_z) / 2)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RoomKind {
    Start,
    Combat,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RoomEncounterState {
    Dormant,
    Active,
    Cleared,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DoorSnapshot {
    pub id: DoorId,
    pub room_a: RoomId,
    pub room_b: RoomId,
    pub position: [i32; 3],
    pub half_extents: [i32; 3],
    pub locked: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerSnapshot {
    pub id: PlayerId,
    pub position: [i32; 3],
    pub health: u16,
    pub max_health: u16,
    pub level: u16,
    pub experience: u32,
    pub experience_into_level: u32,
    pub experience_for_next_level: u32,
    pub attack_damage: u16,
    pub gold: u32,
    pub alive: bool,
    pub facing: [i8; 2],
    pub action: Option<PlayerActionSnapshot>,
    pub reaction: Option<PlayerReactionSnapshot>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MonsterSnapshot {
    pub id: u32,
    pub room_id: RoomId,
    pub position: [i32; 3],
    pub health: u16,
    pub alive: bool,
    pub action: Option<MonsterActionSnapshot>,
    pub reaction: Option<MonsterReactionSnapshot>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LootKind {
    Gold,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroundLootSnapshot {
    pub id: GroundLootId,
    pub position: [i32; 3],
    pub kind: LootKind,
    pub amount: u32,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArpgSaveState {
    pub schema_version: u16,
    pub run_seed: RunSeed,
    pub tick: u64,
    pub players: Vec<PlayerSaveState>,
    pub rooms: Vec<RoomSaveState>,
    pub monsters: Vec<MonsterSaveState>,
    pub ground_loot: Vec<GroundLootSnapshot>,
    pub next_ground_loot_id: GroundLootId,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlayerSaveState {
    pub id: PlayerId,
    pub position: [i32; 3],
    pub movement: [i8; 2],
    pub facing: [i8; 2],
    pub action: Option<PlayerActionSnapshot>,
    pub hurt_ticks_remaining: u8,
    pub health: u16,
    pub experience: u32,
    pub gold: u32,
    pub last_sequence: u32,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RoomSaveState {
    pub id: RoomId,
    pub encounter_state: RoomEncounterState,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MonsterActionSaveState {
    pub phase: ActionPhase,
    pub ticks_remaining: u8,
    pub target_player_id: PlayerId,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MonsterSaveState {
    pub id: u32,
    pub room_id: RoomId,
    pub position: [i32; 3],
    pub health: u16,
    pub action: Option<MonsterActionSaveState>,
    pub stagger_ticks_remaining: u8,
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
    Door,
}

#[derive(Clone, Copy, Debug)]
struct ActionState {
    kind: ActionKind,
    phase: ActionPhase,
    ticks_remaining: u8,
    facing_x: i8,
    facing_z: i8,
}

impl ActionState {
    fn snapshot(self) -> PlayerActionSnapshot {
        PlayerActionSnapshot {
            kind: self.kind,
            phase: self.phase,
            ticks_remaining: self.ticks_remaining,
            facing: [self.facing_x, self.facing_z],
        }
    }
}

#[derive(Clone, Copy, Debug)]
struct MonsterActionState {
    phase: ActionPhase,
    ticks_remaining: u8,
    target_player_id: PlayerId,
}

impl MonsterActionState {
    fn snapshot(self) -> MonsterActionSnapshot {
        MonsterActionSnapshot {
            phase: self.phase,
            ticks_remaining: self.ticks_remaining,
            target_player_id: self.target_player_id,
            range: i32::try_from(MONSTER_ATTACK_RANGE).expect("monster attack range must fit i32"),
        }
    }
}

#[derive(Clone, Copy, Debug)]
struct PlayerState {
    movement_x: i8,
    movement_z: i8,
    facing_x: i8,
    facing_z: i8,
    action: Option<ActionState>,
    hurt_ticks_remaining: u8,
    health: u16,
    experience: u32,
    gold: u32,
}

#[derive(Clone, Copy, Debug)]
struct MonsterState {
    id: u32,
    room_id: RoomId,
    position: Vec3i,
    health: u16,
    action: Option<MonsterActionState>,
    stagger_ticks_remaining: u8,
}

#[derive(Clone, Copy, Debug)]
struct GroundLootState {
    id: GroundLootId,
    position: Vec3i,
    kind: LootKind,
    amount: u32,
}

#[derive(Clone, Copy, Debug)]
struct DungeonRng {
    state: u64,
}

impl DungeonRng {
    fn new(seed: u64) -> Self {
        Self {
            state: if seed == 0 {
                0x9E37_79B9_7F4A_7C15
            } else {
                seed
            },
        }
    }

    fn next_u32(&mut self) -> u32 {
        self.state ^= self.state << 13;
        self.state ^= self.state >> 7;
        self.state ^= self.state << 17;
        (self.state >> 32) as u32
    }

    fn range_i32(&mut self, min: i32, max: i32) -> i32 {
        debug_assert!(min <= max);
        let span = u32::try_from(max - min + 1).expect("dungeon range must fit u32");
        min + i32::try_from(self.next_u32() % span).expect("range sample must fit i32")
    }
}

#[derive(Debug)]
struct GeneratedDungeon {
    rooms: Vec<RoomSnapshot>,
    doors: Vec<DoorSnapshot>,
    static_colliders: Vec<StaticColliderSnapshot>,
    player_spawns: [Vec3i; MAX_PLAYERS],
    monsters: Vec<MonsterState>,
}

#[derive(Debug)]
pub struct ArpgGame {
    run_seed: RunSeed,
    tick: u64,
    world: World,
    players: BTreeMap<PlayerId, PlayerState>,
    last_sequences: BTreeMap<PlayerId, u32>,
    rooms: Vec<RoomSnapshot>,
    doors: Vec<DoorSnapshot>,
    player_spawns: [Vec3i; MAX_PLAYERS],
    monsters: Vec<MonsterState>,
    ground_loot: Vec<GroundLootState>,
    next_ground_loot_id: GroundLootId,
    static_colliders: Vec<StaticColliderSnapshot>,
}

impl Default for ArpgGame {
    fn default() -> Self {
        Self::new().expect("built-in ARPG fixture must be valid")
    }
}

impl ArpgGame {
    pub fn new() -> Result<Self, GameError> {
        Self::new_with_seed(DEFAULT_DUNGEON_SEED)
    }

    pub fn new_with_seed(run_seed: RunSeed) -> Result<Self, GameError> {
        let mut world = World::new(WorldConfig {
            gravity: Vec3i::ZERO,
            ..WorldConfig::default()
        });
        let GeneratedDungeon {
            rooms,
            doors,
            static_colliders,
            player_spawns,
            monsters,
        } = generate_dungeon(run_seed);
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
            run_seed,
            tick: 0,
            world,
            players: BTreeMap::new(),
            last_sequences: BTreeMap::new(),
            rooms,
            doors,
            player_spawns,
            monsters,
            ground_loot: Vec::new(),
            next_ground_loot_id: GROUND_LOOT_ID_BASE,
            static_colliders,
        })
    }

    pub fn run_seed(&self) -> RunSeed {
        self.run_seed
    }

    pub fn save_state(&self) -> Result<ArpgSaveState, GameError> {
        let players = self
            .players
            .iter()
            .map(|(&id, state)| {
                let body = self
                    .world
                    .body(Self::player_body_id(id))
                    .ok_or_else(|| GameError::new("player physics body is missing"))?;
                Ok(PlayerSaveState {
                    id,
                    position: vec_to_array(body.position()),
                    movement: [state.movement_x, state.movement_z],
                    facing: [state.facing_x, state.facing_z],
                    action: state.action.map(ActionState::snapshot),
                    hurt_ticks_remaining: state.hurt_ticks_remaining,
                    health: state.health,
                    experience: state.experience,
                    gold: state.gold,
                    last_sequence: self.last_sequences.get(&id).copied().unwrap_or_default(),
                })
            })
            .collect::<Result<Vec<_>, GameError>>()?;

        Ok(ArpgSaveState {
            schema_version: SAVE_STATE_SCHEMA_VERSION,
            run_seed: self.run_seed,
            tick: self.tick,
            players,
            rooms: self
                .rooms
                .iter()
                .map(|room| RoomSaveState {
                    id: room.id,
                    encounter_state: room.encounter_state,
                })
                .collect(),
            monsters: self
                .monsters
                .iter()
                .map(|monster| MonsterSaveState {
                    id: monster.id,
                    room_id: monster.room_id,
                    position: vec_to_array(monster.position),
                    health: monster.health,
                    action: monster.action.map(|action| MonsterActionSaveState {
                        phase: action.phase,
                        ticks_remaining: action.ticks_remaining,
                        target_player_id: action.target_player_id,
                    }),
                    stagger_ticks_remaining: monster.stagger_ticks_remaining,
                })
                .collect(),
            ground_loot: self
                .ground_loot
                .iter()
                .map(|loot| GroundLootSnapshot {
                    id: loot.id,
                    position: vec_to_array(loot.position),
                    kind: loot.kind,
                    amount: loot.amount,
                })
                .collect(),
            next_ground_loot_id: self.next_ground_loot_id,
        })
    }

    pub fn from_save_state(save: ArpgSaveState) -> Result<Self, GameError> {
        if save.schema_version != SAVE_STATE_SCHEMA_VERSION {
            return Err(GameError::new(format!(
                "unsupported ARPG save schema version {}; expected {}",
                save.schema_version, SAVE_STATE_SCHEMA_VERSION
            )));
        }
        if save.players.len() > MAX_PLAYERS {
            return Err(GameError::new("save contains too many players"));
        }

        let mut game = Self::new_with_seed(save.run_seed)?;
        game.tick = save.tick;

        if save.rooms.len() != game.rooms.len() {
            return Err(GameError::new(
                "save room set does not match generated dungeon",
            ));
        }
        let mut room_states = BTreeMap::new();
        for room in save.rooms {
            if room_states.insert(room.id, room.encounter_state).is_some() {
                return Err(GameError::new("save contains duplicate room ids"));
            }
        }
        for room in &mut game.rooms {
            let state = room_states
                .remove(&room.id)
                .ok_or_else(|| GameError::new("save is missing a generated room"))?;
            if room.kind == RoomKind::Start && state != RoomEncounterState::Cleared {
                return Err(GameError::new("start room must remain cleared"));
            }
            room.encounter_state = state;
        }
        if !room_states.is_empty() {
            return Err(GameError::new("save contains unknown room ids"));
        }

        let mut player_ids = BTreeSet::new();
        for player in &save.players {
            if player.id == 0 || !player_ids.insert(player.id) {
                return Err(GameError::new(
                    "save contains invalid or duplicate player ids",
                ));
            }
            Self::validate_axis(player.movement, "movement")?;
            Self::validate_facing(player.facing)?;
            if player.health
                > Self::max_health_for_level(Self::level_for_experience(player.experience))
            {
                return Err(GameError::new(
                    "saved player health exceeds authoritative maximum",
                ));
            }
            if let Some(action) = player.action {
                Self::validate_action_snapshot(action)?;
            }
        }

        if save.monsters.len() != game.monsters.len() {
            return Err(GameError::new(
                "save monster set does not match generated dungeon",
            ));
        }
        let mut monster_states = BTreeMap::new();
        for monster in save.monsters {
            if monster.health > 100 {
                return Err(GameError::new(
                    "saved monster health exceeds authoritative maximum",
                ));
            }
            if let Some(action) = monster.action
                && (action.ticks_remaining == 0 || action.target_player_id == 0)
            {
                return Err(GameError::new("saved monster action is invalid"));
            }
            if monster_states.insert(monster.id, monster).is_some() {
                return Err(GameError::new("save contains duplicate monster ids"));
            }
        }
        for monster in &mut game.monsters {
            let saved = monster_states
                .remove(&monster.id)
                .ok_or_else(|| GameError::new("save is missing a generated monster"))?;
            if saved.room_id != monster.room_id {
                return Err(GameError::new(
                    "saved monster room does not match generated dungeon",
                ));
            }
            monster.position = array_to_vec(saved.position);
            monster.health = saved.health;
            monster.action = saved.action.map(|action| MonsterActionState {
                phase: action.phase,
                ticks_remaining: action.ticks_remaining,
                target_player_id: action.target_player_id,
            });
            monster.stagger_ticks_remaining = saved.stagger_ticks_remaining;
        }
        if !monster_states.is_empty() {
            return Err(GameError::new("save contains unknown monster ids"));
        }

        let mut loot_ids = BTreeSet::new();
        let mut ground_loot = Vec::with_capacity(save.ground_loot.len());
        for loot in save.ground_loot {
            if loot.id < GROUND_LOOT_ID_BASE
                || loot.amount == 0
                || !loot_ids.insert(loot.id)
                || loot.id >= save.next_ground_loot_id
            {
                return Err(GameError::new("save contains invalid ground loot"));
            }
            ground_loot.push(GroundLootState {
                id: loot.id,
                position: array_to_vec(loot.position),
                kind: loot.kind,
                amount: loot.amount,
            });
        }
        if save.next_ground_loot_id < GROUND_LOOT_ID_BASE {
            return Err(GameError::new(
                "save contains an invalid next ground loot id",
            ));
        }
        game.ground_loot = ground_loot;
        game.next_ground_loot_id = save.next_ground_loot_id;

        for player in save.players {
            game.add_player(player.id)?;
            game.world
                .set_position(
                    Self::player_body_id(player.id),
                    array_to_vec(player.position),
                )
                .map_err(physics_error)?;
            let state = game
                .players
                .get_mut(&player.id)
                .expect("saved player was just added");
            *state = PlayerState {
                movement_x: player.movement[0],
                movement_z: player.movement[1],
                facing_x: player.facing[0],
                facing_z: player.facing[1],
                action: player.action.map(|action| ActionState {
                    kind: action.kind,
                    phase: action.phase,
                    ticks_remaining: action.ticks_remaining,
                    facing_x: action.facing[0],
                    facing_z: action.facing[1],
                }),
                hurt_ticks_remaining: player.hurt_ticks_remaining,
                health: player.health,
                experience: player.experience,
                gold: player.gold,
            };
            game.last_sequences.insert(player.id, player.last_sequence);
            let velocity = Self::movement_velocity(*state);
            game.world
                .set_velocity(Self::player_body_id(player.id), velocity)
                .map_err(physics_error)?;
        }

        game.sync_door_locks()?;
        Ok(game)
    }

    fn validate_axis(axis: [i8; 2], label: &str) -> Result<(), GameError> {
        if axis
            .into_iter()
            .any(|component| !(-1..=1).contains(&component))
        {
            return Err(GameError::new(format!(
                "saved {label} axis is outside -1..=1"
            )));
        }
        Ok(())
    }

    fn validate_facing(facing: [i8; 2]) -> Result<(), GameError> {
        Self::validate_axis(facing, "facing")?;
        if facing == [0, 0] {
            return Err(GameError::new("saved facing cannot be zero"));
        }
        Ok(())
    }

    fn validate_action_snapshot(action: PlayerActionSnapshot) -> Result<(), GameError> {
        Self::validate_facing(action.facing)?;
        if action.ticks_remaining == 0 {
            return Err(GameError::new("saved player action has no remaining ticks"));
        }
        Ok(())
    }

    fn player_body_id(player_id: PlayerId) -> BodyId {
        BodyId(PLAYER_BODY_BASE + u64::from(player_id))
    }

    fn level_for_experience(experience: u32) -> u16 {
        let level = 1u32.saturating_add(experience / EXPERIENCE_PER_LEVEL);
        u16::try_from(level.min(u32::from(u16::MAX))).expect("clamped level must fit u16")
    }

    fn max_health_for_level(level: u16) -> u16 {
        BASE_MAX_HEALTH.saturating_add(level.saturating_sub(1).saturating_mul(MAX_HEALTH_PER_LEVEL))
    }

    fn attack_damage_for_level(level: u16) -> u16 {
        BASE_ATTACK_DAMAGE.saturating_add(
            level
                .saturating_sub(1)
                .saturating_mul(ATTACK_DAMAGE_PER_LEVEL),
        )
    }

    fn movement_velocity(state: PlayerState) -> Vec3i {
        if state.health == 0 || state.action.is_some() {
            return Vec3i::ZERO;
        }
        let x = i32::from(state.movement_x.clamp(-1, 1));
        let z = i32::from(state.movement_z.clamp(-1, 1));
        if x != 0 && z != 0 {
            Vec3i::new(x * PLAYER_DIAGONAL_SPEED, 0, z * PLAYER_DIAGONAL_SPEED)
        } else {
            Vec3i::new(x * PLAYER_SPEED, 0, z * PLAYER_SPEED)
        }
    }

    fn room_at_position(&self, position: Vec3i) -> Option<RoomId> {
        self.rooms
            .iter()
            .find(|room| room.contains_xz_with_margin(position, ROOM_ACTIVATION_MARGIN))
            .map(|room| room.id)
    }

    fn award_experience(&mut self, player_id: PlayerId, amount: u32) -> Result<(), GameError> {
        let state = self
            .players
            .get_mut(&player_id)
            .ok_or_else(|| GameError::new("experience references an unknown player"))?;
        let previous_level = Self::level_for_experience(state.experience);
        let previous_max_health = Self::max_health_for_level(previous_level);
        state.experience = state.experience.saturating_add(amount);
        let level = Self::level_for_experience(state.experience);
        let max_health = Self::max_health_for_level(level);
        if max_health > previous_max_health {
            state.health = state
                .health
                .saturating_add(max_health - previous_max_health)
                .min(max_health);
        }
        Ok(())
    }

    fn start_action(&mut self, player_id: PlayerId, kind: ActionKind) -> Result<(), GameError> {
        let state = self
            .players
            .get_mut(&player_id)
            .ok_or_else(|| GameError::new("action references an unknown player"))?;
        if state.health == 0 || state.action.is_some() {
            return Ok(());
        }
        state.action = Some(ActionState {
            kind,
            phase: ActionPhase::Windup,
            ticks_remaining: kind.windup_ticks(),
            facing_x: state.facing_x,
            facing_z: state.facing_z,
        });
        Ok(())
    }

    fn target_is_in_front(facing_x: i8, facing_z: i8, dx: i64, dz: i64) -> bool {
        let distance_sq = dx * dx + dz * dz;
        if distance_sq == 0 {
            return true;
        }
        let facing_x = i64::from(facing_x);
        let facing_z = i64::from(facing_z);
        let facing_len_sq = facing_x * facing_x + facing_z * facing_z;
        if facing_len_sq == 0 {
            return true;
        }
        let dot = dx * facing_x + dz * facing_z;
        dot > 0 && 4 * dot * dot >= distance_sq * facing_len_sq
    }

    fn spawn_ground_loot(&mut self, position: Vec3i) -> Result<(), GameError> {
        let id = self.next_ground_loot_id;
        self.next_ground_loot_id = self
            .next_ground_loot_id
            .checked_add(1)
            .ok_or_else(|| GameError::new("ground loot id overflow"))?;
        self.ground_loot.push(GroundLootState {
            id,
            position,
            kind: LootKind::Gold,
            amount: GROUND_LOOT_GOLD_AMOUNT,
        });
        Ok(())
    }

    fn resolve_interaction(&mut self, player_id: PlayerId) -> Result<(), GameError> {
        let player_position = self
            .world
            .body(Self::player_body_id(player_id))
            .ok_or_else(|| GameError::new("player physics body is missing"))?
            .position();
        let range_sq = INTERACT_RANGE * INTERACT_RANGE;
        let target = self
            .ground_loot
            .iter()
            .enumerate()
            .filter_map(|(index, loot)| {
                let dx = i64::from(loot.position.x - player_position.x);
                let dz = i64::from(loot.position.z - player_position.z);
                let distance_sq = dx * dx + dz * dz;
                (distance_sq <= range_sq).then_some((distance_sq, loot.id, index))
            })
            .min_by_key(|(distance_sq, id, _)| (*distance_sq, *id));
        let Some((_, _, index)) = target else {
            return Ok(());
        };
        let loot = self.ground_loot.remove(index);
        let player = self
            .players
            .get_mut(&player_id)
            .ok_or_else(|| GameError::new("interaction references an unknown player"))?;
        match loot.kind {
            LootKind::Gold => {
                player.gold = player.gold.saturating_add(loot.amount);
            }
        }
        Ok(())
    }

    fn resolve_attack(
        &mut self,
        player_id: PlayerId,
        kind: ActionKind,
        facing_x: i8,
        facing_z: i8,
    ) -> Result<(), GameError> {
        let player_position = self
            .world
            .body(Self::player_body_id(player_id))
            .ok_or_else(|| GameError::new("player physics body is missing"))?
            .position();
        let player_level = Self::level_for_experience(
            self.players
                .get(&player_id)
                .ok_or_else(|| GameError::new("attack references an unknown player"))?
                .experience,
        );
        let (range, damage_numerator, damage_denominator, stagger_ticks) = match kind {
            ActionKind::PrimaryAttack => (ATTACK_RANGE, 1, 1, PRIMARY_STAGGER_TICKS),
            ActionKind::SecondaryAttack => (
                SECONDARY_ATTACK_RANGE,
                SECONDARY_ATTACK_DAMAGE_NUMERATOR,
                SECONDARY_ATTACK_DAMAGE_DENOMINATOR,
                SECONDARY_STAGGER_TICKS,
            ),
            ActionKind::Interact => return Ok(()),
        };
        let attack_damage = Self::attack_damage_for_level(player_level)
            .saturating_mul(damage_numerator)
            / damage_denominator.max(1);
        let active_rooms = self
            .rooms
            .iter()
            .filter(|room| room.encounter_state == RoomEncounterState::Active)
            .map(|room| room.id)
            .collect::<BTreeSet<_>>();
        let range_sq = range * range;
        let target = self
            .monsters
            .iter_mut()
            .filter(|monster| monster.health > 0 && active_rooms.contains(&monster.room_id))
            .filter_map(|monster| {
                let dx = i64::from(monster.position.x - player_position.x);
                let dz = i64::from(monster.position.z - player_position.z);
                let distance_sq = dx * dx + dz * dz;
                (distance_sq <= range_sq && Self::target_is_in_front(facing_x, facing_z, dx, dz))
                    .then_some((distance_sq, monster.id, monster))
            })
            .min_by_key(|(distance_sq, id, _)| (*distance_sq, *id));

        let killed_position = if let Some((_, _, monster)) = target {
            let previous_health = monster.health;
            monster.health = monster.health.saturating_sub(attack_damage);
            if monster.health > 0 {
                monster.stagger_ticks_remaining = stagger_ticks;
                monster.action = None;
            }
            (previous_health > 0 && monster.health == 0).then_some(monster.position)
        } else {
            None
        };
        if let Some(position) = killed_position {
            self.award_experience(player_id, MONSTER_EXPERIENCE_REWARD)?;
            self.spawn_ground_loot(position)?;
        }
        self.reconcile_encounters()
    }

    fn advance_actions(&mut self) -> Result<(), GameError> {
        let player_ids = self.players.keys().copied().collect::<Vec<_>>();
        for player_id in player_ids {
            let effect = {
                let state = self
                    .players
                    .get_mut(&player_id)
                    .expect("player id came from player map");
                let Some(mut action) = state.action else {
                    continue;
                };
                if action.ticks_remaining > 1 {
                    action.ticks_remaining -= 1;
                    state.action = Some(action);
                    None
                } else {
                    match action.phase {
                        ActionPhase::Windup => {
                            action.phase = ActionPhase::Active;
                            action.ticks_remaining = action.kind.active_ticks();
                            state.action = Some(action);
                            Some((action.kind, action.facing_x, action.facing_z))
                        }
                        ActionPhase::Active => {
                            action.phase = ActionPhase::Recovery;
                            action.ticks_remaining = action.kind.recovery_ticks();
                            state.action = Some(action);
                            None
                        }
                        ActionPhase::Recovery => {
                            state.action = None;
                            None
                        }
                    }
                }
            };
            if let Some((kind, facing_x, facing_z)) = effect {
                match kind {
                    ActionKind::PrimaryAttack | ActionKind::SecondaryAttack => {
                        self.resolve_attack(player_id, kind, facing_x, facing_z)?;
                    }
                    ActionKind::Interact => self.resolve_interaction(player_id)?,
                }
            }
        }
        Ok(())
    }

    fn resolve_monster_attack(
        &mut self,
        monster_id: u32,
        target_player_id: PlayerId,
    ) -> Result<(), GameError> {
        let monster_position = self
            .monsters
            .iter()
            .find(|monster| monster.id == monster_id && monster.health > 0)
            .map(|monster| monster.position);
        let Some(monster_position) = monster_position else {
            return Ok(());
        };
        let target_position = self
            .world
            .body(Self::player_body_id(target_player_id))
            .map(|body| body.position());
        let Some(target_position) = target_position else {
            return Ok(());
        };
        let target_alive = self
            .players
            .get(&target_player_id)
            .is_some_and(|player| player.health > 0);
        if !target_alive {
            return Ok(());
        }

        let dx = i64::from(target_position.x - monster_position.x);
        let dz = i64::from(target_position.z - monster_position.z);
        if dx * dx + dz * dz > MONSTER_ATTACK_RANGE * MONSTER_ATTACK_RANGE {
            return Ok(());
        }

        let player = self
            .players
            .get_mut(&target_player_id)
            .ok_or_else(|| GameError::new("monster attack references an unknown player"))?;
        player.health = player.health.saturating_sub(MONSTER_ATTACK_DAMAGE);
        player.hurt_ticks_remaining = PLAYER_HURT_TICKS;
        player.action = None;
        Ok(())
    }

    fn advance_monster_actions(&mut self) -> Result<(), GameError> {
        let active_rooms = self
            .rooms
            .iter()
            .filter(|room| room.encounter_state == RoomEncounterState::Active)
            .map(|room| room.id)
            .collect::<BTreeSet<_>>();
        let targets = self
            .players
            .iter()
            .filter(|(_, state)| state.health > 0)
            .filter_map(|(&player_id, _)| {
                let position = self.world.body(Self::player_body_id(player_id))?.position();
                let room_id = self.room_at_position(position)?;
                Some((player_id, room_id, position))
            })
            .collect::<Vec<_>>();

        let mut hits = Vec::new();
        for monster in &mut self.monsters {
            if monster.health == 0
                || monster.stagger_ticks_remaining > 0
                || !active_rooms.contains(&monster.room_id)
            {
                if monster.stagger_ticks_remaining > 0 || monster.health == 0 {
                    monster.action = None;
                }
                continue;
            }

            if let Some(mut action) = monster.action {
                if action.ticks_remaining > 1 {
                    action.ticks_remaining -= 1;
                    monster.action = Some(action);
                    continue;
                }
                match action.phase {
                    ActionPhase::Windup => {
                        action.phase = ActionPhase::Active;
                        action.ticks_remaining = MONSTER_ATTACK_ACTIVE_TICKS;
                        monster.action = Some(action);
                        hits.push((monster.id, action.target_player_id));
                    }
                    ActionPhase::Active => {
                        action.phase = ActionPhase::Recovery;
                        action.ticks_remaining = MONSTER_ATTACK_RECOVERY_TICKS;
                        monster.action = Some(action);
                    }
                    ActionPhase::Recovery => {
                        monster.action = None;
                    }
                }
                continue;
            }

            let range_sq = MONSTER_ATTACK_RANGE * MONSTER_ATTACK_RANGE;
            let target = targets
                .iter()
                .filter(|(_, room_id, _)| *room_id == monster.room_id)
                .filter_map(|&(player_id, _, position)| {
                    let dx = i64::from(position.x - monster.position.x);
                    let dz = i64::from(position.z - monster.position.z);
                    let distance_sq = dx * dx + dz * dz;
                    (distance_sq <= range_sq).then_some((distance_sq, player_id))
                })
                .min_by_key(|(distance_sq, player_id)| (*distance_sq, *player_id));
            if let Some((_, target_player_id)) = target {
                monster.action = Some(MonsterActionState {
                    phase: ActionPhase::Windup,
                    ticks_remaining: MONSTER_ATTACK_WINDUP_TICKS,
                    target_player_id,
                });
            }
        }

        for (monster_id, target_player_id) in hits {
            self.resolve_monster_attack(monster_id, target_player_id)?;
        }
        Ok(())
    }

    fn reconcile_encounters(&mut self) -> Result<(), GameError> {
        let occupied_rooms = self
            .players
            .keys()
            .filter_map(|&player_id| {
                self.world
                    .body(Self::player_body_id(player_id))
                    .and_then(|body| self.room_at_position(body.position()))
            })
            .collect::<BTreeSet<_>>();
        let rooms_with_living_monsters = self
            .monsters
            .iter()
            .filter(|monster| monster.health > 0)
            .map(|monster| monster.room_id)
            .collect::<BTreeSet<_>>();

        for room in &mut self.rooms {
            if room.kind != RoomKind::Combat {
                continue;
            }
            match room.encounter_state {
                RoomEncounterState::Dormant if occupied_rooms.contains(&room.id) => {
                    room.encounter_state = if rooms_with_living_monsters.contains(&room.id) {
                        RoomEncounterState::Active
                    } else {
                        RoomEncounterState::Cleared
                    };
                }
                RoomEncounterState::Active if !rooms_with_living_monsters.contains(&room.id) => {
                    room.encounter_state = RoomEncounterState::Cleared;
                }
                _ => {}
            }
        }
        self.sync_door_locks()
    }

    fn sync_door_locks(&mut self) -> Result<(), GameError> {
        let active_rooms = self
            .rooms
            .iter()
            .filter(|room| room.encounter_state == RoomEncounterState::Active)
            .map(|room| room.id)
            .collect::<BTreeSet<_>>();
        let desired_locks = self
            .doors
            .iter()
            .map(|door| active_rooms.contains(&door.room_a) || active_rooms.contains(&door.room_b))
            .collect::<Vec<_>>();

        for (index, desired_locked) in desired_locks.into_iter().enumerate() {
            if self.doors[index].locked == desired_locked {
                continue;
            }
            let door = self.doors[index].clone();
            if desired_locked {
                self.world
                    .add_body(RigidBody::fixed(
                        BodyId(door.id),
                        array_to_vec(door.position),
                        array_to_vec(door.half_extents),
                    ))
                    .map_err(physics_error)?;
            } else {
                self.world.remove_body(BodyId(door.id));
            }
            self.doors[index].locked = desired_locked;
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

        let spawn = self.player_spawns[self.players.len()];
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
                facing_x: 1,
                facing_z: 0,
                action: None,
                hurt_ticks_remaining: 0,
                health: BASE_MAX_HEALTH,
                experience: 0,
                gold: 0,
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
                if state.movement_x != 0 || state.movement_z != 0 {
                    state.facing_x = state.movement_x;
                    state.facing_z = state.movement_z;
                }
            }
            ArpgCommand::PrimaryAttack => {
                self.start_action(command.player_id, ActionKind::PrimaryAttack)?
            }
            ArpgCommand::SecondaryAttack => {
                self.start_action(command.player_id, ActionKind::SecondaryAttack)?
            }
            ArpgCommand::Interact => self.start_action(command.player_id, ActionKind::Interact)?,
        }
        self.last_sequences
            .insert(command.player_id, command.sequence);
        Ok(())
    }

    fn advance_tick(&mut self) -> Result<(), GameError> {
        for player in self.players.values_mut() {
            player.hurt_ticks_remaining = player.hurt_ticks_remaining.saturating_sub(1);
        }
        for monster in &mut self.monsters {
            monster.stagger_ticks_remaining = monster.stagger_ticks_remaining.saturating_sub(1);
        }
        for (&player_id, &state) in &self.players {
            self.world
                .set_velocity(
                    Self::player_body_id(player_id),
                    Self::movement_velocity(state),
                )
                .map_err(physics_error)?;
        }
        self.world.step(1).map_err(physics_error)?;
        self.reconcile_encounters()?;
        self.advance_actions()?;
        self.advance_monster_actions()?;
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
                let level = Self::level_for_experience(state.experience);
                Ok(PlayerSnapshot {
                    id,
                    position: vec_to_array(body.position()),
                    health: state.health,
                    max_health: Self::max_health_for_level(level),
                    level,
                    experience: state.experience,
                    experience_into_level: state.experience % EXPERIENCE_PER_LEVEL,
                    experience_for_next_level: EXPERIENCE_PER_LEVEL,
                    attack_damage: Self::attack_damage_for_level(level),
                    gold: state.gold,
                    alive: state.health > 0,
                    facing: [state.facing_x, state.facing_z],
                    action: state.action.map(ActionState::snapshot),
                    reaction: (state.hurt_ticks_remaining > 0).then_some(PlayerReactionSnapshot {
                        kind: PlayerReactionKind::Hurt,
                        ticks_remaining: state.hurt_ticks_remaining,
                    }),
                })
            })
            .collect::<Result<Vec<_>, GameError>>()?;
        let mut static_colliders = self.static_colliders.clone();
        static_colliders.extend(self.doors.iter().filter(|door| door.locked).map(|door| {
            StaticColliderSnapshot {
                id: door.id,
                position: door.position,
                half_extents: door.half_extents,
                kind: StaticColliderKind::Door,
            }
        }));

        Ok(ArpgSnapshot {
            schema_version: 8,
            run_seed: self.run_seed,
            tick: self.tick,
            world_units_per_meter: WORLD_UNITS_PER_METER,
            rooms: self.rooms.clone(),
            doors: self.doors.clone(),
            players,
            monsters: self
                .monsters
                .iter()
                .map(|monster| MonsterSnapshot {
                    id: monster.id,
                    room_id: monster.room_id,
                    position: vec_to_array(monster.position),
                    health: monster.health,
                    alive: monster.health > 0,
                    action: monster.action.map(MonsterActionState::snapshot),
                    reaction: (monster.stagger_ticks_remaining > 0).then_some(
                        MonsterReactionSnapshot {
                            kind: MonsterReactionKind::Stagger,
                            ticks_remaining: monster.stagger_ticks_remaining,
                        },
                    ),
                })
                .collect(),
            ground_loot: self
                .ground_loot
                .iter()
                .map(|loot| GroundLootSnapshot {
                    id: loot.id,
                    position: vec_to_array(loot.position),
                    kind: loot.kind,
                    amount: loot.amount,
                })
                .collect(),
            static_colliders,
        })
    }
}

fn generate_dungeon(seed: RunSeed) -> GeneratedDungeon {
    let mut colliders = Vec::new();
    let mut doors = Vec::new();
    let mut rng = DungeonRng::new(u64::from(seed));
    let left_partition_x = rng.range_i32(-1_200, -800);
    let right_partition_x = rng.range_i32(800, 1_200);
    let horizontal_partition_z = rng.range_i32(-300, 300);

    push_wall(
        &mut colliders,
        [0, PLAYER_Y, -ARENA_HALF_DEPTH],
        [ARENA_HALF_WIDTH, WALL_HALF_HEIGHT, WALL_HALF_THICKNESS],
    );
    push_wall(
        &mut colliders,
        [0, PLAYER_Y, ARENA_HALF_DEPTH],
        [ARENA_HALF_WIDTH, WALL_HALF_HEIGHT, WALL_HALF_THICKNESS],
    );
    push_wall(
        &mut colliders,
        [-ARENA_HALF_WIDTH, PLAYER_Y, 0],
        [WALL_HALF_THICKNESS, WALL_HALF_HEIGHT, ARENA_HALF_DEPTH],
    );
    push_wall(
        &mut colliders,
        [ARENA_HALF_WIDTH, PLAYER_Y, 0],
        [WALL_HALF_THICKNESS, WALL_HALF_HEIGHT, ARENA_HALF_DEPTH],
    );

    let interior_z_min = -ARENA_HALF_DEPTH + WALL_HALF_THICKNESS;
    let interior_z_max = ARENA_HALF_DEPTH - WALL_HALF_THICKNESS;
    let lower_z_max = horizontal_partition_z - PARTITION_MARGIN;
    let upper_z_min = horizontal_partition_z + PARTITION_MARGIN;
    let vertical_connections = [((1, 2), (4, 5)), ((2, 3), (5, 6))];
    for (partition_index, partition_x) in [left_partition_x, right_partition_x]
        .into_iter()
        .enumerate()
    {
        let lower_door = rng.range_i32(
            interior_z_min + DOOR_EDGE_MARGIN,
            lower_z_max - DOOR_EDGE_MARGIN,
        );
        push_vertical_wall_with_door(
            &mut colliders,
            partition_x,
            interior_z_min,
            lower_z_max,
            lower_door,
        );
        let (lower_a, lower_b) = vertical_connections[partition_index].0;
        push_door(
            &mut doors,
            lower_a,
            lower_b,
            [partition_x, PLAYER_Y, lower_door],
            [WALL_HALF_THICKNESS, WALL_HALF_HEIGHT, DOOR_HALF_WIDTH],
        );

        let upper_door = rng.range_i32(
            upper_z_min + DOOR_EDGE_MARGIN,
            interior_z_max - DOOR_EDGE_MARGIN,
        );
        push_vertical_wall_with_door(
            &mut colliders,
            partition_x,
            upper_z_min,
            interior_z_max,
            upper_door,
        );
        let (upper_a, upper_b) = vertical_connections[partition_index].1;
        push_door(
            &mut doors,
            upper_a,
            upper_b,
            [partition_x, PLAYER_Y, upper_door],
            [WALL_HALF_THICKNESS, WALL_HALF_HEIGHT, DOOR_HALF_WIDTH],
        );
    }

    let interior_x_min = -ARENA_HALF_WIDTH + WALL_HALF_THICKNESS;
    let interior_x_max = ARENA_HALF_WIDTH - WALL_HALF_THICKNESS;
    let columns = [
        (interior_x_min, left_partition_x - PARTITION_MARGIN),
        (
            left_partition_x + PARTITION_MARGIN,
            right_partition_x - PARTITION_MARGIN,
        ),
        (right_partition_x + PARTITION_MARGIN, interior_x_max),
    ];
    let horizontal_connections = [(1, 4), (2, 5), (3, 6)];
    for (column_index, (x_min, x_max)) in columns.into_iter().enumerate() {
        let doorway = rng.range_i32(x_min + DOOR_EDGE_MARGIN, x_max - DOOR_EDGE_MARGIN);
        push_horizontal_wall_with_door(
            &mut colliders,
            horizontal_partition_z,
            x_min,
            x_max,
            doorway,
        );
        let (room_a, room_b) = horizontal_connections[column_index];
        push_door(
            &mut doors,
            room_a,
            room_b,
            [doorway, PLAYER_Y, horizontal_partition_z],
            [DOOR_HALF_WIDTH, WALL_HALF_HEIGHT, WALL_HALF_THICKNESS],
        );
    }

    let rows = [(interior_z_min, lower_z_max), (upper_z_min, interior_z_max)];
    let rooms = generated_rooms(columns, rows);
    let start_room = rooms
        .iter()
        .find(|room| room.kind == RoomKind::Start)
        .expect("generated dungeon must contain a start room");
    let player_spawns = generated_player_spawns(start_room);
    let monsters = generated_monsters(&rooms, &mut rng);

    GeneratedDungeon {
        rooms,
        doors,
        static_colliders: colliders,
        player_spawns,
        monsters,
    }
}

fn generated_rooms(columns: [(i32, i32); 3], rows: [(i32, i32); 2]) -> Vec<RoomSnapshot> {
    let neighbors = [
        vec![2, 4],
        vec![1, 3, 5],
        vec![2, 6],
        vec![1, 5],
        vec![2, 4, 6],
        vec![3, 5],
    ];
    let mut rooms = Vec::with_capacity(6);
    for (row_index, &(min_z, max_z)) in rows.iter().enumerate() {
        for (column_index, &(min_x, max_x)) in columns.iter().enumerate() {
            let index = row_index * columns.len() + column_index;
            let id = u32::try_from(index + 1).expect("room id must fit u32");
            let kind = if id == 1 {
                RoomKind::Start
            } else {
                RoomKind::Combat
            };
            rooms.push(RoomSnapshot {
                id,
                min_x,
                max_x,
                min_z,
                max_z,
                kind,
                encounter_state: if kind == RoomKind::Start {
                    RoomEncounterState::Cleared
                } else {
                    RoomEncounterState::Dormant
                },
                neighbors: neighbors[index].clone(),
            });
        }
    }
    rooms
}

fn generated_player_spawns(start_room: &RoomSnapshot) -> [Vec3i; MAX_PLAYERS] {
    let (center_x, center_z) = start_room.center();
    [
        Vec3i::new(
            center_x - PLAYER_SPAWN_OFFSET,
            PLAYER_Y,
            center_z - PLAYER_SPAWN_OFFSET,
        ),
        Vec3i::new(
            center_x - PLAYER_SPAWN_OFFSET,
            PLAYER_Y,
            center_z + PLAYER_SPAWN_OFFSET,
        ),
        Vec3i::new(
            center_x + PLAYER_SPAWN_OFFSET,
            PLAYER_Y,
            center_z - PLAYER_SPAWN_OFFSET,
        ),
        Vec3i::new(
            center_x + PLAYER_SPAWN_OFFSET,
            PLAYER_Y,
            center_z + PLAYER_SPAWN_OFFSET,
        ),
    ]
}

fn generated_monsters(rooms: &[RoomSnapshot], rng: &mut DungeonRng) -> Vec<MonsterState> {
    rooms
        .iter()
        .filter(|room| room.kind == RoomKind::Combat)
        .enumerate()
        .map(|(index, room)| MonsterState {
            id: u32::try_from(index + 1).expect("monster id must fit u32"),
            room_id: room.id,
            position: Vec3i::new(
                rng.range_i32(
                    room.min_x + ROOM_SPAWN_MARGIN,
                    room.max_x - ROOM_SPAWN_MARGIN,
                ),
                PLAYER_Y,
                rng.range_i32(
                    room.min_z + ROOM_SPAWN_MARGIN,
                    room.max_z - ROOM_SPAWN_MARGIN,
                ),
            ),
            health: 100,
            action: None,
            stagger_ticks_remaining: 0,
        })
        .collect()
}

fn push_door(
    doors: &mut Vec<DoorSnapshot>,
    room_a: RoomId,
    room_b: RoomId,
    position: [i32; 3],
    half_extents: [i32; 3],
) {
    let index = u64::try_from(doors.len()).expect("dungeon door count must fit u64");
    doors.push(DoorSnapshot {
        id: DOOR_BODY_BASE + index,
        room_a,
        room_b,
        position,
        half_extents,
        locked: false,
    });
}

fn push_vertical_wall_with_door(
    colliders: &mut Vec<StaticColliderSnapshot>,
    x: i32,
    z_min: i32,
    z_max: i32,
    doorway_z: i32,
) {
    push_vertical_wall_segment(colliders, x, z_min, doorway_z - DOOR_HALF_WIDTH);
    push_vertical_wall_segment(colliders, x, doorway_z + DOOR_HALF_WIDTH, z_max);
}

fn push_vertical_wall_segment(
    colliders: &mut Vec<StaticColliderSnapshot>,
    x: i32,
    z_min: i32,
    z_max: i32,
) {
    if z_max <= z_min {
        return;
    }
    let half_depth = (z_max - z_min) / 2;
    if half_depth == 0 {
        return;
    }
    push_wall(
        colliders,
        [x, PLAYER_Y, z_min + half_depth],
        [WALL_HALF_THICKNESS, WALL_HALF_HEIGHT, half_depth],
    );
}

fn push_horizontal_wall_with_door(
    colliders: &mut Vec<StaticColliderSnapshot>,
    z: i32,
    x_min: i32,
    x_max: i32,
    doorway_x: i32,
) {
    push_horizontal_wall_segment(colliders, z, x_min, doorway_x - DOOR_HALF_WIDTH);
    push_horizontal_wall_segment(colliders, z, doorway_x + DOOR_HALF_WIDTH, x_max);
}

fn push_horizontal_wall_segment(
    colliders: &mut Vec<StaticColliderSnapshot>,
    z: i32,
    x_min: i32,
    x_max: i32,
) {
    if x_max <= x_min {
        return;
    }
    let half_width = (x_max - x_min) / 2;
    if half_width == 0 {
        return;
    }
    push_wall(
        colliders,
        [x_min + half_width, PLAYER_Y, z],
        [half_width, WALL_HALF_HEIGHT, WALL_HALF_THICKNESS],
    );
}

fn push_wall(
    colliders: &mut Vec<StaticColliderSnapshot>,
    position: [i32; 3],
    half_extents: [i32; 3],
) {
    let index = u64::try_from(colliders.len()).expect("dungeon collider count must fit u64");
    colliders.push(StaticColliderSnapshot {
        id: STATIC_BODY_BASE + index,
        position,
        half_extents,
        kind: StaticColliderKind::Wall,
    });
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
    fn movement_speed_is_tuned_for_precise_room_navigation() {
        let cardinal = ArpgGame::movement_velocity(PlayerState {
            movement_x: 1,
            movement_z: 0,
            facing_x: 1,
            facing_z: 0,
            action: None,
            hurt_ticks_remaining: 0,
            health: BASE_MAX_HEALTH,
            experience: 0,
            gold: 0,
        });
        let diagonal = ArpgGame::movement_velocity(PlayerState {
            movement_x: 1,
            movement_z: 1,
            facing_x: 1,
            facing_z: 1,
            action: None,
            hurt_ticks_remaining: 0,
            health: BASE_MAX_HEALTH,
            experience: 0,
            gold: 0,
        });
        assert_eq!(cardinal, Vec3i::new(7, 0, 0));
        assert_eq!(diagonal, Vec3i::new(5, 0, 5));
    }

    fn run_action(game: &mut ArpgGame, player_id: PlayerId, sequence: u32, command: ArpgCommand) {
        game.apply_command(PlayerCommand::new(player_id, sequence, command).unwrap())
            .unwrap();
        while game.players.get(&player_id).unwrap().action.is_some() {
            game.advance_tick().unwrap();
        }
    }

    #[test]
    fn progression_is_derived_from_experience_and_changes_combat_stats() {
        let mut game = ArpgGame::new().unwrap();
        game.add_player(1).unwrap();
        game.award_experience(1, EXPERIENCE_PER_LEVEL).unwrap();

        let player = &game.snapshot().unwrap().players[0];
        assert_eq!(player.experience, EXPERIENCE_PER_LEVEL);
        assert_eq!(player.level, 2);
        assert_eq!(player.max_health, 110);
        assert_eq!(player.health, 110);
        assert_eq!(player.attack_damage, 30);
        assert_eq!(player.experience_into_level, 0);
        assert_eq!(player.experience_for_next_level, EXPERIENCE_PER_LEVEL);
    }

    #[test]
    fn killing_blow_gets_experience_once_in_coop() {
        let mut game = ArpgGame::new_with_seed(42).unwrap();
        let room_id = 2;
        let (center_x, center_z) = game
            .rooms
            .iter()
            .find(|room| room.id == room_id)
            .unwrap()
            .center();
        game.player_spawns[0] = Vec3i::new(center_x, PLAYER_Y, center_z);
        game.player_spawns[1] = Vec3i::new(center_x + 20, PLAYER_Y, center_z);
        game.add_player(1).unwrap();
        game.add_player(2).unwrap();
        game.reconcile_encounters().unwrap();
        let monster = game
            .monsters
            .iter_mut()
            .find(|monster| monster.room_id == room_id)
            .unwrap();
        monster.position = Vec3i::new(center_x + 100, PLAYER_Y, center_z);

        for sequence in 1..=3 {
            run_action(&mut game, 1, sequence, ArpgCommand::PrimaryAttack);
        }
        run_action(&mut game, 2, 1, ArpgCommand::PrimaryAttack);

        let snapshot = game.snapshot().unwrap();
        let first = snapshot
            .players
            .iter()
            .find(|player| player.id == 1)
            .unwrap();
        let second = snapshot
            .players
            .iter()
            .find(|player| player.id == 2)
            .unwrap();
        assert_eq!(first.experience, 0);
        assert_eq!(second.experience, MONSTER_EXPERIENCE_REWARD);
        assert_eq!(snapshot.ground_loot.len(), 1);

        run_action(&mut game, 2, 2, ArpgCommand::PrimaryAttack);
        assert_eq!(
            game.snapshot()
                .unwrap()
                .players
                .iter()
                .find(|player| player.id == 2)
                .unwrap()
                .experience,
            MONSTER_EXPERIENCE_REWARD
        );
    }

    #[test]
    fn level_damage_is_used_by_authoritative_attack() {
        let mut game = ArpgGame::new_with_seed(42).unwrap();
        let room_id = 2;
        let (center_x, center_z) = game
            .rooms
            .iter()
            .find(|room| room.id == room_id)
            .unwrap()
            .center();
        game.player_spawns[0] = Vec3i::new(center_x, PLAYER_Y, center_z);
        game.add_player(1).unwrap();
        game.award_experience(1, EXPERIENCE_PER_LEVEL).unwrap();
        game.reconcile_encounters().unwrap();
        let monster = game
            .monsters
            .iter_mut()
            .find(|monster| monster.room_id == room_id)
            .unwrap();
        monster.position = Vec3i::new(center_x + 100, PLAYER_Y, center_z);
        monster.health = 30;

        run_action(&mut game, 1, 1, ArpgCommand::PrimaryAttack);
        assert_eq!(
            game.monsters
                .iter()
                .find(|monster| monster.room_id == room_id)
                .unwrap()
                .health,
            0
        );
        assert_eq!(
            game.players.get(&1).unwrap().experience,
            EXPERIENCE_PER_LEVEL + MONSTER_EXPERIENCE_REWARD
        );
    }

    #[test]
    fn secondary_attack_trades_reach_for_more_damage() {
        let mut game = ArpgGame::new_with_seed(42).unwrap();
        let room_id = 2;
        let (center_x, center_z) = game
            .rooms
            .iter()
            .find(|room| room.id == room_id)
            .unwrap()
            .center();
        game.player_spawns[0] = Vec3i::new(center_x, PLAYER_Y, center_z);
        game.add_player(1).unwrap();
        game.reconcile_encounters().unwrap();

        let monster = game
            .monsters
            .iter_mut()
            .find(|monster| monster.room_id == room_id)
            .unwrap();
        monster.position = Vec3i::new(center_x + 180, PLAYER_Y, center_z);
        monster.health = 100;

        run_action(&mut game, 1, 1, ArpgCommand::SecondaryAttack);
        assert_eq!(
            game.monsters
                .iter()
                .find(|monster| monster.room_id == room_id)
                .unwrap()
                .health,
            100
        );

        run_action(&mut game, 1, 2, ArpgCommand::PrimaryAttack);
        assert_eq!(
            game.monsters
                .iter()
                .find(|monster| monster.room_id == room_id)
                .unwrap()
                .health,
            75
        );

        game.monsters
            .iter_mut()
            .find(|monster| monster.room_id == room_id)
            .unwrap()
            .position = Vec3i::new(center_x + 100, PLAYER_Y, center_z);
        run_action(&mut game, 1, 3, ArpgCommand::SecondaryAttack);
        assert_eq!(
            game.monsters
                .iter()
                .find(|monster| monster.room_id == room_id)
                .unwrap()
                .health,
            38
        );
    }

    #[test]
    fn monster_attack_is_telegraphed_before_damage() {
        let mut game = ArpgGame::new_with_seed(42).unwrap();
        let room_id = 2;
        let (center_x, center_z) = game
            .rooms
            .iter()
            .find(|room| room.id == room_id)
            .unwrap()
            .center();
        game.player_spawns[0] = Vec3i::new(center_x, PLAYER_Y, center_z);
        game.add_player(1).unwrap();
        game.reconcile_encounters().unwrap();
        let monster = game
            .monsters
            .iter_mut()
            .find(|monster| monster.room_id == room_id)
            .unwrap();
        monster.position = Vec3i::new(center_x + 100, PLAYER_Y, center_z);

        game.advance_tick().unwrap();

        let telegraph = game.snapshot().unwrap();
        assert_eq!(telegraph.players[0].health, BASE_MAX_HEALTH);
        let monster_action = telegraph
            .monsters
            .iter()
            .find(|monster| monster.room_id == room_id)
            .unwrap()
            .action
            .unwrap();
        assert_eq!(monster_action.phase, ActionPhase::Windup);
        assert_eq!(monster_action.ticks_remaining, MONSTER_ATTACK_WINDUP_TICKS);
        assert_eq!(monster_action.target_player_id, 1);
        assert_eq!(
            monster_action.range,
            i32::try_from(MONSTER_ATTACK_RANGE).unwrap()
        );

        for _ in 0..MONSTER_ATTACK_WINDUP_TICKS {
            game.advance_tick().unwrap();
        }

        let impact = game.snapshot().unwrap();
        assert_eq!(
            impact.players[0].health,
            BASE_MAX_HEALTH - MONSTER_ATTACK_DAMAGE
        );
        assert_eq!(
            impact.players[0].reaction.unwrap().kind,
            PlayerReactionKind::Hurt
        );
        assert_eq!(
            impact
                .monsters
                .iter()
                .find(|monster| monster.room_id == room_id)
                .unwrap()
                .action
                .unwrap()
                .phase,
            ActionPhase::Active
        );
    }

    #[test]
    fn moving_out_of_monster_telegraph_causes_a_miss() {
        let mut game = ArpgGame::new_with_seed(42).unwrap();
        let room_id = 2;
        let (center_x, center_z) = game
            .rooms
            .iter()
            .find(|room| room.id == room_id)
            .unwrap()
            .center();
        game.player_spawns[0] = Vec3i::new(center_x, PLAYER_Y, center_z);
        game.add_player(1).unwrap();
        game.reconcile_encounters().unwrap();
        game.monsters
            .iter_mut()
            .find(|monster| monster.room_id == room_id)
            .unwrap()
            .position = Vec3i::new(center_x + 100, PLAYER_Y, center_z);

        game.advance_tick().unwrap();
        game.apply_command(
            PlayerCommand::new(1, 1, ArpgCommand::SetMovement { x: -1, z: 0 }).unwrap(),
        )
        .unwrap();
        for _ in 0..MONSTER_ATTACK_WINDUP_TICKS {
            game.advance_tick().unwrap();
        }

        let snapshot = game.snapshot().unwrap();
        assert_eq!(snapshot.players[0].health, BASE_MAX_HEALTH);
        assert!(
            snapshot.players[0].position[0] <= center_x - 100,
            "player did not leave the telegraphed melee range"
        );
    }

    #[test]
    fn defeated_player_cannot_move_or_start_actions() {
        let mut game = ArpgGame::new_with_seed(42).unwrap();
        let room_id = 2;
        let (center_x, center_z) = game
            .rooms
            .iter()
            .find(|room| room.id == room_id)
            .unwrap()
            .center();
        game.player_spawns[0] = Vec3i::new(center_x, PLAYER_Y, center_z);
        game.add_player(1).unwrap();
        game.players.get_mut(&1).unwrap().health = MONSTER_ATTACK_DAMAGE;
        game.reconcile_encounters().unwrap();
        game.monsters
            .iter_mut()
            .find(|monster| monster.room_id == room_id)
            .unwrap()
            .position = Vec3i::new(center_x + 100, PLAYER_Y, center_z);

        game.advance_tick().unwrap();
        for _ in 0..MONSTER_ATTACK_WINDUP_TICKS {
            game.advance_tick().unwrap();
        }

        let defeated = game.snapshot().unwrap().players[0].clone();
        assert_eq!(defeated.health, 0);
        assert!(!defeated.alive);
        let position = defeated.position;

        game.apply_command(
            PlayerCommand::new(1, 1, ArpgCommand::SetMovement { x: -1, z: 0 }).unwrap(),
        )
        .unwrap();
        game.apply_command(PlayerCommand::new(1, 2, ArpgCommand::PrimaryAttack).unwrap())
            .unwrap();
        for _ in 0..PRIMARY_WINDUP_TICKS {
            game.advance_tick().unwrap();
        }

        let after = game.snapshot().unwrap().players[0].clone();
        assert_eq!(after.position, position);
        assert!(after.action.is_none());
        assert_eq!(after.health, 0);
    }

    #[test]
    fn player_stagger_interrupts_monster_windup() {
        let mut game = ArpgGame::new_with_seed(42).unwrap();
        let room_id = 2;
        let (center_x, center_z) = game
            .rooms
            .iter()
            .find(|room| room.id == room_id)
            .unwrap()
            .center();
        game.player_spawns[0] = Vec3i::new(center_x, PLAYER_Y, center_z);
        game.add_player(1).unwrap();
        game.reconcile_encounters().unwrap();
        game.monsters
            .iter_mut()
            .find(|monster| monster.room_id == room_id)
            .unwrap()
            .position = Vec3i::new(center_x + 100, PLAYER_Y, center_z);

        game.advance_tick().unwrap();
        game.apply_command(PlayerCommand::new(1, 1, ArpgCommand::PrimaryAttack).unwrap())
            .unwrap();
        for _ in 0..PRIMARY_WINDUP_TICKS {
            game.advance_tick().unwrap();
        }

        let monster = game
            .snapshot()
            .unwrap()
            .monsters
            .into_iter()
            .find(|monster| monster.room_id == room_id)
            .unwrap();
        assert_eq!(monster.health, 75);
        assert!(monster.action.is_none());
        assert_eq!(monster.reaction.unwrap().kind, MonsterReactionKind::Stagger);
    }

    #[test]
    fn kill_drop_pickup_requires_explicit_interaction() {
        let mut game = ArpgGame::new_with_seed(42).unwrap();
        let room_id = 2;
        let (center_x, center_z) = game
            .rooms
            .iter()
            .find(|room| room.id == room_id)
            .unwrap()
            .center();
        game.player_spawns[0] = Vec3i::new(center_x, PLAYER_Y, center_z);
        game.add_player(1).unwrap();
        game.reconcile_encounters().unwrap();
        let monster = game
            .monsters
            .iter_mut()
            .find(|monster| monster.room_id == room_id)
            .unwrap();
        monster.position = Vec3i::new(center_x + 100, PLAYER_Y, center_z);
        monster.health = BASE_ATTACK_DAMAGE;

        run_action(&mut game, 1, 1, ArpgCommand::PrimaryAttack);

        let after_kill = game.snapshot().unwrap();
        assert_eq!(after_kill.players[0].gold, 0);
        assert_eq!(after_kill.ground_loot.len(), 1);
        assert_eq!(after_kill.ground_loot[0].kind, LootKind::Gold);
        assert_eq!(after_kill.ground_loot[0].amount, GROUND_LOOT_GOLD_AMOUNT);
        assert_eq!(
            after_kill.ground_loot[0].position,
            [center_x + 100, PLAYER_Y, center_z]
        );

        run_action(&mut game, 1, 2, ArpgCommand::Interact);

        let after_pickup = game.snapshot().unwrap();
        assert!(after_pickup.ground_loot.is_empty());
        assert_eq!(after_pickup.players[0].gold, GROUND_LOOT_GOLD_AMOUNT);

        run_action(&mut game, 1, 3, ArpgCommand::Interact);
        assert_eq!(
            game.snapshot().unwrap().players[0].gold,
            GROUND_LOOT_GOLD_AMOUNT
        );
    }

    #[test]
    fn interaction_respects_pickup_range() {
        let mut game = ArpgGame::new_with_seed(42).unwrap();
        game.add_player(1).unwrap();
        let player_position = game
            .world
            .body(ArpgGame::player_body_id(1))
            .unwrap()
            .position();
        game.ground_loot.push(GroundLootState {
            id: GROUND_LOOT_ID_BASE,
            position: Vec3i::new(
                player_position.x + i32::try_from(INTERACT_RANGE).unwrap() + 1,
                PLAYER_Y,
                player_position.z,
            ),
            kind: LootKind::Gold,
            amount: GROUND_LOOT_GOLD_AMOUNT,
        });

        run_action(&mut game, 1, 1, ArpgCommand::Interact);

        assert_eq!(game.snapshot().unwrap().ground_loot.len(), 1);
        assert_eq!(game.snapshot().unwrap().players[0].gold, 0);
    }

    #[test]
    fn attacks_have_authoritative_commitment_active_and_recovery_phases() {
        let mut game = ArpgGame::new_with_seed(42).unwrap();
        let room_id = 2;
        let (center_x, center_z) = game
            .rooms
            .iter()
            .find(|room| room.id == room_id)
            .unwrap()
            .center();
        game.player_spawns[0] = Vec3i::new(center_x, PLAYER_Y, center_z);
        game.add_player(1).unwrap();
        game.reconcile_encounters().unwrap();
        let monster = game
            .monsters
            .iter_mut()
            .find(|monster| monster.room_id == room_id)
            .unwrap();
        monster.position = Vec3i::new(center_x + 100, PLAYER_Y, center_z);

        game.apply_command(
            PlayerCommand::new(1, 1, ArpgCommand::SetMovement { x: 1, z: 0 }).unwrap(),
        )
        .unwrap();
        game.apply_command(PlayerCommand::new(1, 2, ArpgCommand::PrimaryAttack).unwrap())
            .unwrap();

        let start_position = game.snapshot().unwrap().players[0].position;
        let action = game.snapshot().unwrap().players[0].action.unwrap();
        assert_eq!(action.kind, ActionKind::PrimaryAttack);
        assert_eq!(action.phase, ActionPhase::Windup);
        assert_eq!(action.ticks_remaining, PRIMARY_WINDUP_TICKS);

        for _ in 0..PRIMARY_WINDUP_TICKS {
            game.advance_tick().unwrap();
        }

        let active = game.snapshot().unwrap();
        assert_eq!(active.players[0].position, start_position);
        assert_eq!(active.players[0].action.unwrap().phase, ActionPhase::Active);
        assert_eq!(
            active
                .monsters
                .iter()
                .find(|monster| monster.room_id == room_id)
                .unwrap()
                .health,
            75
        );
        assert_eq!(
            active
                .monsters
                .iter()
                .find(|monster| monster.room_id == room_id)
                .unwrap()
                .reaction
                .unwrap()
                .kind,
            MonsterReactionKind::Stagger
        );

        game.advance_tick().unwrap();
        assert_eq!(
            game.snapshot().unwrap().players[0].action.unwrap().phase,
            ActionPhase::Recovery
        );
        for _ in 0..PRIMARY_RECOVERY_TICKS {
            game.advance_tick().unwrap();
        }
        assert!(game.snapshot().unwrap().players[0].action.is_none());
        game.advance_tick().unwrap();
        assert!(game.snapshot().unwrap().players[0].position[0] > start_position[0]);
    }

    #[test]
    fn attack_targeting_respects_committed_facing() {
        let mut game = ArpgGame::new_with_seed(42).unwrap();
        let room_id = 2;
        let (center_x, center_z) = game
            .rooms
            .iter()
            .find(|room| room.id == room_id)
            .unwrap()
            .center();
        game.player_spawns[0] = Vec3i::new(center_x, PLAYER_Y, center_z);
        game.add_player(1).unwrap();
        game.reconcile_encounters().unwrap();
        let monster = game
            .monsters
            .iter_mut()
            .find(|monster| monster.room_id == room_id)
            .unwrap();
        monster.position = Vec3i::new(center_x - 100, PLAYER_Y, center_z);
        monster.health = 100;

        run_action(&mut game, 1, 1, ArpgCommand::PrimaryAttack);
        assert_eq!(
            game.monsters
                .iter()
                .find(|monster| monster.room_id == room_id)
                .unwrap()
                .health,
            100
        );

        game.apply_command(
            PlayerCommand::new(1, 2, ArpgCommand::SetMovement { x: -1, z: 0 }).unwrap(),
        )
        .unwrap();
        run_action(&mut game, 1, 3, ArpgCommand::PrimaryAttack);
        assert_eq!(
            game.monsters
                .iter()
                .find(|monster| monster.room_id == room_id)
                .unwrap()
                .health,
            75
        );
    }

    #[test]
    fn generated_rooms_are_large_enough_for_arpg_combat() {
        for seed in 0..64 {
            let dungeon = generate_dungeon(seed);
            assert!(
                dungeon.rooms.iter().all(|room| {
                    room.max_x - room.min_x >= 1_400 && room.max_z - room.min_z >= 1_400
                }),
                "seed {seed} generated a cramped room"
            );
        }
    }

    #[test]
    fn procedural_dungeon_is_seeded_and_deterministic() {
        let first = generate_dungeon(42);
        let replay = generate_dungeon(42);
        let different_seed = generate_dungeon(43);

        assert_eq!(first.rooms, replay.rooms);
        assert_eq!(first.doors, replay.doors);
        assert_eq!(first.static_colliders, replay.static_colliders);
        assert_eq!(first.player_spawns, replay.player_spawns);
        assert_eq!(
            monster_layout(&first.monsters),
            monster_layout(&replay.monsters)
        );
        assert_ne!(first.rooms, different_seed.rooms);
        assert!(
            first.static_colliders.len() > 4,
            "expected generated internal room walls"
        );
    }

    #[test]
    fn generated_room_graph_is_connected_symmetric_and_backed_by_doors() {
        let dungeon = generate_dungeon(42);
        assert_eq!(dungeon.rooms.len(), 6);
        assert_eq!(dungeon.doors.len(), 7);

        let mut seen = BTreeSet::new();
        let mut pending = vec![dungeon.rooms[0].id];
        while let Some(room_id) = pending.pop() {
            if !seen.insert(room_id) {
                continue;
            }
            let room = dungeon
                .rooms
                .iter()
                .find(|room| room.id == room_id)
                .expect("neighbor must reference an existing room");
            for &neighbor_id in &room.neighbors {
                let neighbor = dungeon
                    .rooms
                    .iter()
                    .find(|candidate| candidate.id == neighbor_id)
                    .expect("neighbor must reference an existing room");
                assert!(
                    neighbor.neighbors.contains(&room.id),
                    "room {} -> {} connection must be symmetric",
                    room.id,
                    neighbor_id
                );
                assert!(dungeon.doors.iter().any(|door| {
                    (door.room_a == room.id && door.room_b == neighbor_id)
                        || (door.room_b == room.id && door.room_a == neighbor_id)
                }));
                pending.push(neighbor_id);
            }
        }
        assert_eq!(seen.len(), dungeon.rooms.len());
        assert!(dungeon.doors.iter().all(|door| !door.locked));
    }

    #[test]
    fn generated_spawns_stay_inside_their_rooms() {
        let dungeon = generate_dungeon(0xC0FF_EE11);
        let start_room = dungeon
            .rooms
            .iter()
            .find(|room| room.kind == RoomKind::Start)
            .unwrap();
        for spawn in dungeon.player_spawns {
            assert!(start_room.contains_xz_with_margin(spawn, 0));
        }
        for monster in &dungeon.monsters {
            let room = dungeon
                .rooms
                .iter()
                .find(|room| room.id == monster.room_id)
                .unwrap();
            assert_eq!(room.kind, RoomKind::Combat);
            assert!(room.contains_xz_with_margin(monster.position, 0));
        }
    }

    #[test]
    fn snapshot_carries_run_seed_room_door_and_progression_semantics_for_replay() {
        let mut game = ArpgGame::new_with_seed(0xDEAD_BEEF).unwrap();
        game.add_player(1).unwrap();
        let snapshot = game.snapshot().unwrap();
        let generated = generate_dungeon(snapshot.run_seed);
        assert_eq!(snapshot.schema_version, 8);
        assert_eq!(snapshot.run_seed, 0xDEAD_BEEF);
        assert_eq!(game.run_seed(), snapshot.run_seed);
        assert_eq!(snapshot.rooms, generated.rooms);
        assert_eq!(snapshot.doors, generated.doors);
        assert_eq!(snapshot.static_colliders, generated.static_colliders);
        assert_eq!(snapshot.monsters.len(), generated.monsters.len());
        assert!(snapshot.ground_loot.is_empty());
        assert!(snapshot.monsters.iter().all(|monster| monster.room_id > 1));
        assert_eq!(snapshot.players[0].level, 1);
        assert_eq!(snapshot.players[0].experience, 0);
        assert_eq!(snapshot.players[0].attack_damage, BASE_ATTACK_DAMAGE);
    }

    #[test]
    fn entering_combat_room_locks_connected_doors_until_encounter_is_cleared() {
        let mut game = ArpgGame::new_with_seed(42).unwrap();
        let room_id = 2;
        let (center_x, center_z) = game
            .rooms
            .iter()
            .find(|room| room.id == room_id)
            .unwrap()
            .center();
        game.player_spawns[0] = Vec3i::new(center_x, PLAYER_Y, center_z);
        game.add_player(1).unwrap();
        game.reconcile_encounters().unwrap();

        assert_eq!(room_state(&game, room_id), RoomEncounterState::Active);
        let connected_door_ids = game
            .doors
            .iter()
            .filter(|door| door.room_a == room_id || door.room_b == room_id)
            .map(|door| door.id)
            .collect::<Vec<_>>();
        assert!(!connected_door_ids.is_empty());
        for door_id in &connected_door_ids {
            let door = game.doors.iter().find(|door| door.id == *door_id).unwrap();
            assert!(door.locked);
            assert!(game.world.body(BodyId(*door_id)).is_some());
        }

        let monster = game
            .monsters
            .iter_mut()
            .find(|monster| monster.room_id == room_id)
            .unwrap();
        monster.position = Vec3i::new(center_x + 100, PLAYER_Y, center_z);
        for sequence in 1..=4 {
            run_action(&mut game, 1, sequence, ArpgCommand::PrimaryAttack);
        }

        assert_eq!(room_state(&game, room_id), RoomEncounterState::Cleared);
        for door_id in connected_door_ids {
            let door = game.doors.iter().find(|door| door.id == door_id).unwrap();
            assert!(!door.locked);
            assert!(game.world.body(BodyId(door_id)).is_none());
        }
        assert_eq!(
            game.players.get(&1).unwrap().experience,
            MONSTER_EXPERIENCE_REWARD
        );
        assert!(
            game.snapshot()
                .unwrap()
                .static_colliders
                .iter()
                .all(|collider| collider.kind != StaticColliderKind::Door)
        );
    }

    #[test]
    fn dormant_room_monsters_cannot_be_attacked_before_entry() {
        let mut game = ArpgGame::new_with_seed(42).unwrap();
        game.add_player(1).unwrap();
        let player_position = game
            .world
            .body(ArpgGame::player_body_id(1))
            .unwrap()
            .position();
        let monster = game
            .monsters
            .iter_mut()
            .find(|monster| monster.room_id == 2)
            .unwrap();
        monster.position = Vec3i::new(player_position.x + 100, PLAYER_Y, player_position.z);

        for sequence in 1..=4 {
            run_action(&mut game, 1, sequence, ArpgCommand::PrimaryAttack);
        }
        assert_eq!(
            game.monsters
                .iter()
                .find(|monster| monster.room_id == 2)
                .unwrap()
                .health,
            100
        );
        assert_eq!(game.players.get(&1).unwrap().experience, 0);
        assert_eq!(room_state(&game, 2), RoomEncounterState::Dormant);
    }

    #[test]
    fn active_room_doors_are_projected_as_static_door_colliders() {
        let mut game = ArpgGame::new_with_seed(42).unwrap();
        let (center_x, center_z) = game
            .rooms
            .iter()
            .find(|room| room.id == 2)
            .unwrap()
            .center();
        game.player_spawns[0] = Vec3i::new(center_x, PLAYER_Y, center_z);
        game.add_player(1).unwrap();
        game.reconcile_encounters().unwrap();
        let snapshot = game.snapshot().unwrap();
        let locked_count = snapshot.doors.iter().filter(|door| door.locked).count();
        let projected_count = snapshot
            .static_colliders
            .iter()
            .filter(|collider| collider.kind == StaticColliderKind::Door)
            .count();
        assert_eq!(locked_count, projected_count);
        assert!(locked_count > 0);
    }

    #[test]
    fn procedural_dungeon_keeps_outer_boundary_stable() {
        let first = generate_dungeon(1).static_colliders;
        let second = generate_dungeon(2).static_colliders;
        assert_eq!(&first[..4], &second[..4]);
        assert_eq!(first[0].position, [0, PLAYER_Y, -ARENA_HALF_DEPTH]);
        assert_eq!(first[1].position, [0, PLAYER_Y, ARENA_HALF_DEPTH]);
        assert_eq!(first[2].position, [-ARENA_HALF_WIDTH, PLAYER_Y, 0]);
        assert_eq!(first[3].position, [ARENA_HALF_WIDTH, PLAYER_Y, 0]);
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
            PlayerCommand::new(1, 1, ArpgCommand::SetMovement { x: -1, z: 0 }).unwrap(),
        )
        .unwrap();
        for _ in 0..800 {
            game.advance_tick().unwrap();
        }
        let x = game.snapshot().unwrap().players[0].position[0];
        assert!(x >= -2_945, "player crossed the west wall: {x}");
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

    fn room_state(game: &ArpgGame, room_id: RoomId) -> RoomEncounterState {
        game.rooms
            .iter()
            .find(|room| room.id == room_id)
            .unwrap()
            .encounter_state
    }

    fn monster_layout(monsters: &[MonsterState]) -> Vec<(u32, RoomId, [i32; 3])> {
        monsters
            .iter()
            .map(|monster| (monster.id, monster.room_id, vec_to_array(monster.position)))
            .collect()
    }
    #[test]
    fn save_state_round_trip_preserves_authoritative_state_and_continuation() {
        let mut game = ArpgGame::new_with_seed(0x51A7_E123).unwrap();
        game.add_player(1).unwrap();
        game.apply_command(
            PlayerCommand::new(1, 1, ArpgCommand::SetMovement { x: 1, z: -1 }).unwrap(),
        )
        .unwrap();
        for _ in 0..17 {
            game.advance_tick().unwrap();
        }
        game.apply_command(PlayerCommand::new(1, 2, ArpgCommand::PrimaryAttack).unwrap())
            .unwrap();
        for _ in 0..3 {
            game.advance_tick().unwrap();
        }

        let save = game.save_state().unwrap();
        let mut restored = ArpgGame::from_save_state(save).unwrap();
        assert_eq!(restored.snapshot().unwrap(), game.snapshot().unwrap());

        let next = PlayerCommand::new(1, 3, ArpgCommand::SetMovement { x: 0, z: 1 }).unwrap();
        game.apply_command(next.clone()).unwrap();
        restored.apply_command(next).unwrap();
        for _ in 0..25 {
            game.advance_tick().unwrap();
            restored.advance_tick().unwrap();
        }
        assert_eq!(restored.snapshot().unwrap(), game.snapshot().unwrap());
    }

    #[test]
    fn save_state_restores_command_sequence_fence() {
        let mut game = ArpgGame::new_with_seed(17).unwrap();
        game.add_player(1).unwrap();
        game.apply_command(PlayerCommand::new(1, 9, ArpgCommand::PrimaryAttack).unwrap())
            .unwrap();

        let mut restored = ArpgGame::from_save_state(game.save_state().unwrap()).unwrap();
        let stale = restored
            .apply_command(PlayerCommand::new(1, 9, ArpgCommand::Interact).unwrap())
            .unwrap_err();
        assert_eq!(stale.message(), "command sequence is stale");
        restored
            .apply_command(PlayerCommand::new(1, 10, ArpgCommand::Interact).unwrap())
            .unwrap();
    }

    #[test]
    fn save_state_rejects_unknown_schema_and_tampered_seed_state() {
        let mut game = ArpgGame::new_with_seed(91).unwrap();
        game.add_player(1).unwrap();
        let mut save = game.save_state().unwrap();

        save.schema_version += 1;
        assert!(
            ArpgGame::from_save_state(save)
                .unwrap_err()
                .message()
                .contains("unsupported ARPG save schema version")
        );

        let mut save = game.save_state().unwrap();
        save.rooms.pop();
        assert_eq!(
            ArpgGame::from_save_state(save).unwrap_err().message(),
            "save room set does not match generated dungeon"
        );
    }

}
