//! Workbench-only authority operations (#126): bounded spawn/remove/reset of monsters in
//! the scenario room and exact tuning of the counter, guard and bow values.
//!
//! They are not [`ArpgCommand`]s, so no peer or dedicated client can send one: only a game
//! created with [`ArpgGame::new_scenario`] accepts them, and the browser exposes them only
//! in local training. Every accepted operation is recordable in a [`Reproduction`], so an
//! edited session still replays; it can no longer be saved.

use serde::{Deserialize, Serialize};

use crate::content::{BowData, GuardData, content, validate_tuning};
use crate::{
    ArpgGame, GameError, MONSTER_BODY_HALF_EXTENTS, MonsterState, PLAYER_HALF_EXTENTS, PLAYER_Y,
    RoomEncounterState, RoomId, RoomSnapshot, Vec3i, WALL_HALF_THICKNESS, vec_to_array,
};

/// Living monsters the workbench room may hold at once, spawned or generated.
pub const MAX_WORKBENCH_MONSTERS: usize = 12;

/// Monsters one workbench session may spawn in total (ids are never reused).
pub const MAX_WORKBENCH_SPAWNS: u32 = 1_000;

/// Largest accepted offset component; the room bounds reject most values far earlier.
const MAX_SPAWN_OFFSET: i32 = 10_000;

/// A spawned body keeps clear of the room's walls by this much beyond its half extent.
const SPAWN_WALL_CLEARANCE: i32 = WALL_HALF_THICKNESS + MONSTER_BODY_HALF_EXTENTS.x;

/// One workbench operation, applied by the local training authority between ticks.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub enum WorkbenchOperation {
    /// Spawns a monster of content definition `definition` (for example `monster.brute`)
    /// at `offset` `[x, z]` world units from the workbench room's centre.
    SpawnMonster {
        definition: String,
        offset: [i32; 2],
    },
    /// Removes a monster of the workbench room, spawned or generated, without a defeat
    /// (no reward, no loot).
    #[serde(rename_all = "camelCase")]
    RemoveMonster { monster_id: u32 },
    /// Restores the room's monsters to the scenario's arrangement: spawned monsters go,
    /// generated ones return to their authored placement at full health. Tuning stays.
    ResetArrangement,
    /// Sets one tuning parameter to an exact value, validated with the content bounds.
    SetTuning {
        parameter: TuningParameter,
        value: i64,
    },
}

/// The tuning values a workbench session can set, named by their content path.
#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd, Serialize, Deserialize)]
pub enum TuningParameter {
    #[serde(rename = "counterWindowTicks")]
    CounterWindowTicks,
    #[serde(rename = "guard.raiseTicks")]
    GuardRaiseTicks,
    #[serde(rename = "guard.maxPoints")]
    GuardMaxPoints,
    #[serde(rename = "guard.regenPerTick")]
    GuardRegenPerTick,
    #[serde(rename = "guard.blockReactionTicks")]
    GuardBlockReactionTicks,
    #[serde(rename = "guard.breakTicks")]
    GuardBreakTicks,
    #[serde(rename = "bow.minDrawTicks")]
    BowMinDrawTicks,
    #[serde(rename = "bow.fullDrawTicks")]
    BowFullDrawTicks,
    #[serde(rename = "bow.arrowMinSpeed")]
    BowArrowMinSpeed,
    #[serde(rename = "bow.arrowFullSpeed")]
    BowArrowFullSpeed,
    #[serde(rename = "bow.arrowMinDamage")]
    BowArrowMinDamage,
    #[serde(rename = "bow.arrowFullDamage")]
    BowArrowFullDamage,
    #[serde(rename = "bow.arrowLifetimeTicks")]
    BowArrowLifetimeTicks,
    #[serde(rename = "bow.arrowStaggerTicks")]
    BowArrowStaggerTicks,
}

impl TuningParameter {
    pub const ALL: [Self; 14] = [
        Self::CounterWindowTicks,
        Self::GuardRaiseTicks,
        Self::GuardMaxPoints,
        Self::GuardRegenPerTick,
        Self::GuardBlockReactionTicks,
        Self::GuardBreakTicks,
        Self::BowMinDrawTicks,
        Self::BowFullDrawTicks,
        Self::BowArrowMinSpeed,
        Self::BowArrowFullSpeed,
        Self::BowArrowMinDamage,
        Self::BowArrowFullDamage,
        Self::BowArrowLifetimeTicks,
        Self::BowArrowStaggerTicks,
    ];

    /// The content path, identical to the serialised form.
    pub const fn name(self) -> &'static str {
        match self {
            Self::CounterWindowTicks => "counterWindowTicks",
            Self::GuardRaiseTicks => "guard.raiseTicks",
            Self::GuardMaxPoints => "guard.maxPoints",
            Self::GuardRegenPerTick => "guard.regenPerTick",
            Self::GuardBlockReactionTicks => "guard.blockReactionTicks",
            Self::GuardBreakTicks => "guard.breakTicks",
            Self::BowMinDrawTicks => "bow.minDrawTicks",
            Self::BowFullDrawTicks => "bow.fullDrawTicks",
            Self::BowArrowMinSpeed => "bow.arrowMinSpeed",
            Self::BowArrowFullSpeed => "bow.arrowFullSpeed",
            Self::BowArrowMinDamage => "bow.arrowMinDamage",
            Self::BowArrowFullDamage => "bow.arrowFullDamage",
            Self::BowArrowLifetimeTicks => "bow.arrowLifetimeTicks",
            Self::BowArrowStaggerTicks => "bow.arrowStaggerTicks",
        }
    }
}

/// One tuning parameter and the value the game currently runs.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TuningValue {
    pub parameter: TuningParameter,
    pub value: i64,
}

/// The counter, guard and bow values a game runs.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct Tuning {
    pub counter_window_ticks: u64,
    pub guard: GuardData,
    pub bow: BowData,
}

impl Tuning {
    pub fn from_content() -> Self {
        let content = content();
        Self {
            counter_window_ticks: content.counter_window_ticks,
            guard: content.guard,
            bow: content.bow,
        }
    }

    pub fn value(&self, parameter: TuningParameter) -> i64 {
        let (guard, bow) = (&self.guard, &self.bow);
        match parameter {
            TuningParameter::CounterWindowTicks => {
                i64::try_from(self.counter_window_ticks).unwrap_or(i64::MAX)
            }
            TuningParameter::GuardRaiseTicks => guard.raise_ticks.into(),
            TuningParameter::GuardMaxPoints => guard.max_points.into(),
            TuningParameter::GuardRegenPerTick => guard.regen_per_tick.into(),
            TuningParameter::GuardBlockReactionTicks => guard.block_reaction_ticks.into(),
            TuningParameter::GuardBreakTicks => guard.break_ticks.into(),
            TuningParameter::BowMinDrawTicks => bow.min_draw_ticks.into(),
            TuningParameter::BowFullDrawTicks => bow.full_draw_ticks.into(),
            TuningParameter::BowArrowMinSpeed => bow.arrow_min_speed.into(),
            TuningParameter::BowArrowFullSpeed => bow.arrow_full_speed.into(),
            TuningParameter::BowArrowMinDamage => bow.arrow_min_damage.into(),
            TuningParameter::BowArrowFullDamage => bow.arrow_full_damage.into(),
            TuningParameter::BowArrowLifetimeTicks => bow.arrow_lifetime_ticks.into(),
            TuningParameter::BowArrowStaggerTicks => bow.arrow_stagger_ticks.into(),
        }
    }

    /// This tuning with `parameter` set to `value`, or every bound the result violates.
    pub fn with(mut self, parameter: TuningParameter, value: i64) -> Result<Self, GameError> {
        fn exact<T: TryFrom<i64>>(parameter: TuningParameter, value: i64) -> Result<T, GameError> {
            T::try_from(value).map_err(|_| {
                GameError::new(format!("{}: {value} is out of range", parameter.name()))
            })
        }
        let (guard, bow) = (&mut self.guard, &mut self.bow);
        match parameter {
            TuningParameter::CounterWindowTicks => {
                self.counter_window_ticks = exact(parameter, value)?;
            }
            TuningParameter::GuardRaiseTicks => guard.raise_ticks = exact(parameter, value)?,
            TuningParameter::GuardMaxPoints => guard.max_points = exact(parameter, value)?,
            TuningParameter::GuardRegenPerTick => guard.regen_per_tick = exact(parameter, value)?,
            TuningParameter::GuardBlockReactionTicks => {
                guard.block_reaction_ticks = exact(parameter, value)?;
            }
            TuningParameter::GuardBreakTicks => guard.break_ticks = exact(parameter, value)?,
            TuningParameter::BowMinDrawTicks => bow.min_draw_ticks = exact(parameter, value)?,
            TuningParameter::BowFullDrawTicks => bow.full_draw_ticks = exact(parameter, value)?,
            TuningParameter::BowArrowMinSpeed => bow.arrow_min_speed = exact(parameter, value)?,
            TuningParameter::BowArrowFullSpeed => bow.arrow_full_speed = exact(parameter, value)?,
            TuningParameter::BowArrowMinDamage => {
                bow.arrow_min_damage = exact(parameter, value)?;
            }
            TuningParameter::BowArrowFullDamage => {
                bow.arrow_full_damage = exact(parameter, value)?;
            }
            TuningParameter::BowArrowLifetimeTicks => {
                bow.arrow_lifetime_ticks = exact(parameter, value)?;
            }
            TuningParameter::BowArrowStaggerTicks => {
                bow.arrow_stagger_ticks = exact(parameter, value)?;
            }
        }
        let mut errors = Vec::new();
        validate_tuning(
            self.counter_window_ticks,
            self.guard,
            self.bow,
            &mut |path: String, message: &str| errors.push(format!("{path}: {message}")),
        );
        if errors.is_empty() {
            Ok(self)
        } else {
            Err(GameError::new(errors.join("; ")))
        }
    }
}

/// Workbench bookkeeping of a scenario game.
#[derive(Clone, Debug)]
pub(crate) struct Workbench {
    room_id: RoomId,
    center: (i32, i32),
    /// The room's monsters as the scenario arranged them, for `ResetArrangement`.
    arrangement: Vec<MonsterState>,
    next_monster_id: u32,
    spawned: u32,
    edited: bool,
}

impl Workbench {
    pub fn new(game: &ArpgGame) -> Result<Self, GameError> {
        let room_id = game.scenario.room(&game.monsters)?;
        let center = game
            .rooms
            .iter()
            .find(|room| room.id == room_id)
            .map(RoomSnapshot::center)
            .ok_or_else(|| GameError::new("scenario room is missing"))?;
        let next_monster_id = game
            .monsters
            .iter()
            .map(|monster| monster.id)
            .max()
            .unwrap_or(0)
            .checked_add(1)
            .ok_or_else(|| GameError::new("monster id overflow"))?;
        Ok(Self {
            room_id,
            center,
            arrangement: game
                .monsters
                .iter()
                .filter(|monster| monster.room_id == room_id)
                .copied()
                .collect(),
            next_monster_id,
            spawned: 0,
            edited: false,
        })
    }

    /// Whether any operation changed the session; such a session cannot be saved.
    pub fn edited(&self) -> bool {
        self.edited
    }
}

impl ArpgGame {
    /// Applies one workbench operation. Fails without changing anything for games that
    /// were not created as workbench scenarios and for invalid operations.
    pub fn apply_workbench(&mut self, operation: &WorkbenchOperation) -> Result<(), GameError> {
        let workbench = self.workbench.as_ref().ok_or_else(|| {
            GameError::new("workbench operations are only available in local training scenarios")
        })?;
        let (room_id, center) = (workbench.room_id, workbench.center);
        match operation {
            WorkbenchOperation::SpawnMonster { definition, offset } => {
                self.spawn_workbench_monster(room_id, center, definition, *offset)?;
            }
            WorkbenchOperation::RemoveMonster { monster_id } => {
                self.remove_workbench_monster(room_id, *monster_id)?;
            }
            WorkbenchOperation::ResetArrangement => self.reset_workbench_arrangement(room_id),
            WorkbenchOperation::SetTuning { parameter, value } => {
                self.tuning = self.tuning.with(*parameter, *value)?;
                self.clamp_to_tuning();
            }
        }
        self.workbench
            .as_mut()
            .expect("workbench presence checked")
            .edited = true;
        Ok(())
    }

    /// The room workbench operations arrange, for workbench sessions.
    pub fn workbench_room(&self) -> Option<RoomId> {
        self.workbench.as_ref().map(|workbench| workbench.room_id)
    }

    /// The tuning values this game runs, for workbench inputs.
    pub fn tuning_values(&self) -> Vec<TuningValue> {
        TuningParameter::ALL
            .into_iter()
            .map(|parameter| TuningValue {
                parameter,
                value: self.tuning.value(parameter),
            })
            .collect()
    }

    fn spawn_workbench_monster(
        &mut self,
        room_id: RoomId,
        (center_x, center_z): (i32, i32),
        definition: &str,
        [offset_x, offset_z]: [i32; 2],
    ) -> Result<(), GameError> {
        let definition_index = content()
            .monsters
            .iter()
            .position(|candidate| candidate.id == definition)
            .ok_or_else(|| GameError::new(format!("unknown monster definition {definition:?}")))?;
        let bounds = -MAX_SPAWN_OFFSET..=MAX_SPAWN_OFFSET;
        if !bounds.contains(&offset_x) || !bounds.contains(&offset_z) {
            return Err(GameError::new(
                "spawn offset lies outside the workbench room",
            ));
        }
        let position = Vec3i::new(center_x + offset_x, PLAYER_Y, center_z + offset_z);
        let room = self
            .rooms
            .iter()
            .find(|room| room.id == room_id)
            .ok_or_else(|| GameError::new("scenario room is missing"))?;
        let inside = (room.min_x + SPAWN_WALL_CLEARANCE..=room.max_x - SPAWN_WALL_CLEARANCE)
            .contains(&position.x)
            && (room.min_z + SPAWN_WALL_CLEARANCE..=room.max_z - SPAWN_WALL_CLEARANCE)
                .contains(&position.z);
        if !inside {
            return Err(GameError::new(
                "spawn offset lies outside the workbench room",
            ));
        }
        if !self.dungeon_contains(vec_to_array(position), MONSTER_BODY_HALF_EXTENTS) {
            return Err(GameError::new("spawn offset overlaps level geometry"));
        }
        let overlaps = |other: Vec3i, half: Vec3i| {
            (position.x - other.x).abs() < MONSTER_BODY_HALF_EXTENTS.x + half.x
                && (position.z - other.z).abs() < MONSTER_BODY_HALF_EXTENTS.z + half.z
        };
        let living_in_room = self
            .monsters
            .iter()
            .filter(|monster| monster.room_id == room_id && monster.health > 0);
        if living_in_room
            .clone()
            .any(|monster| overlaps(monster.position, MONSTER_BODY_HALF_EXTENTS))
            || self.players.keys().any(|&player_id| {
                self.world
                    .body(Self::player_body_id(player_id))
                    .is_some_and(|body| overlaps(body.position(), PLAYER_HALF_EXTENTS))
            })
        {
            return Err(GameError::new("spawn offset overlaps another body"));
        }
        if living_in_room.count() >= MAX_WORKBENCH_MONSTERS {
            return Err(GameError::new(format!(
                "the workbench room holds at most {MAX_WORKBENCH_MONSTERS} living monsters"
            )));
        }
        let workbench = self.workbench.as_mut().expect("workbench presence checked");
        if workbench.spawned >= MAX_WORKBENCH_SPAWNS {
            return Err(GameError::new(format!(
                "a workbench session spawns at most {MAX_WORKBENCH_SPAWNS} monsters"
            )));
        }
        let id = workbench.next_monster_id;
        workbench.next_monster_id = id
            .checked_add(1)
            .ok_or_else(|| GameError::new("monster id overflow"))?;
        workbench.spawned += 1;
        // Ids only grow, so pushing keeps the monster list in id order.
        self.monsters
            .push(MonsterState::new(id, definition_index, room_id, position));
        self.arrangement_changed(room_id);
        Ok(())
    }

    fn remove_workbench_monster(
        &mut self,
        room_id: RoomId,
        monster_id: u32,
    ) -> Result<(), GameError> {
        let index = self
            .monsters
            .iter()
            .position(|monster| monster.id == monster_id && monster.room_id == room_id)
            .ok_or_else(|| {
                GameError::new(format!("monster {monster_id} is not in the workbench room"))
            })?;
        self.monsters.remove(index);
        self.world.remove_body(Self::monster_body_id(monster_id));
        self.arrangement_changed(room_id);
        Ok(())
    }

    fn reset_workbench_arrangement(&mut self, room_id: RoomId) {
        for monster in self
            .monsters
            .iter()
            .filter(|monster| monster.room_id == room_id)
        {
            self.world.remove_body(Self::monster_body_id(monster.id));
        }
        self.monsters.retain(|monster| monster.room_id != room_id);
        let arrangement = &self
            .workbench
            .as_ref()
            .expect("workbench presence checked")
            .arrangement;
        self.monsters.extend(arrangement.iter().copied());
        self.monsters.sort_by_key(|monster| monster.id);
        self.arrangement_changed(room_id);
    }

    /// A cleared room holds no living monster: one that has them again waits dormant
    /// until occupied, as generated. Navigation is rebuilt from the new arrangement.
    fn arrangement_changed(&mut self, room_id: RoomId) {
        let living = self
            .monsters
            .iter()
            .any(|monster| monster.room_id == room_id && monster.health > 0);
        if let Some(room) = self.rooms.iter_mut().find(|room| room.id == room_id)
            && room.encounter_state == RoomEncounterState::Cleared
            && living
        {
            room.encounter_state = RoomEncounterState::Dormant;
        }
        self.navigation = Default::default();
    }

    /// Live state never exceeds the bounds of the current tuning.
    fn clamp_to_tuning(&mut self) {
        let Tuning {
            guard: tuning, bow, ..
        } = self.tuning;
        for player in self.players.values_mut() {
            let guard = &mut player.guard;
            guard.points = guard.points.min(tuning.max_points);
            guard.broken_ticks_remaining = guard.broken_ticks_remaining.min(tuning.break_ticks);
            guard.block_reaction_ticks_remaining = guard
                .block_reaction_ticks_remaining
                .min(tuning.block_reaction_ticks);
            if let Some(stance) = guard.stance.as_mut() {
                stance.ticks_remaining = stance.ticks_remaining.min(tuning.raise_ticks);
            }
            if let Some(drawn) = player.draw_ticks.as_mut() {
                *drawn = (*drawn).min(bow.full_draw_ticks);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        ArpgCommand, AuthoritativeGame, GuardPhase, PlayerCommand, Reproduction,
        ReproductionRecorder, ScenarioId, replay_reproduction,
    };

    fn dummy() -> ArpgGame {
        let mut game = ArpgGame::new_scenario(ScenarioId::Dummy, 42).unwrap();
        game.add_player(1).unwrap();
        game
    }

    fn spawn(definition: &str, x: i32, z: i32) -> WorkbenchOperation {
        WorkbenchOperation::SpawnMonster {
            definition: definition.into(),
            offset: [x, z],
        }
    }

    fn tune(parameter: TuningParameter, value: i64) -> WorkbenchOperation {
        WorkbenchOperation::SetTuning { parameter, value }
    }

    fn room_center(game: &ArpgGame) -> (i32, i32) {
        game.workbench.as_ref().unwrap().center
    }

    fn room_monsters(game: &ArpgGame) -> Vec<(u32, String, [i32; 3], u16)> {
        let room_id = game.workbench.as_ref().unwrap().room_id;
        game.snapshot()
            .unwrap()
            .monsters
            .into_iter()
            .filter(|monster| monster.room_id == room_id)
            .map(|monster| {
                (
                    monster.id,
                    monster.definition,
                    monster.position,
                    monster.health,
                )
            })
            .collect()
    }

    #[test]
    fn only_workbench_scenarios_accept_operations() {
        let operation = spawn("monster.brute", 0, 300);
        let mut ordinary = ArpgGame::new_with_seed(42).unwrap();
        assert!(ordinary.apply_workbench(&operation).is_err());
        let mut restored = ArpgGame::from_save_state(dummy().save_state().unwrap()).unwrap();
        assert!(restored.apply_workbench(&operation).is_err());
        assert!(dummy().apply_workbench(&operation).is_ok());
    }

    #[test]
    fn a_monster_spawns_at_the_exact_offset_and_joins_the_encounter() {
        let mut game = dummy();
        let (x, z) = room_center(&game);
        let before = room_monsters(&game);
        game.apply_workbench(&spawn("monster.skirmisher", -250, 180))
            .unwrap();
        let after = room_monsters(&game);
        assert_eq!(after.len(), before.len() + 1);
        let spawned = after.last().unwrap();
        assert!(before.iter().all(|monster| monster.0 < spawned.0));
        assert_eq!(spawned.1, "monster.skirmisher");
        assert_eq!(spawned.2, [x - 250, PLAYER_Y, z + 180]);
        assert_eq!(
            spawned.3,
            content().monsters[spawned_index("monster.skirmisher")].health
        );
        game.advance_tick().unwrap();
        game.advance_tick().unwrap();
        assert!(
            game.world
                .body(ArpgGame::monster_body_id(spawned.0))
                .is_some()
        );
    }

    fn spawned_index(definition: &str) -> usize {
        content()
            .monsters
            .iter()
            .position(|monster| monster.id == definition)
            .unwrap()
    }

    #[test]
    fn invalid_spawns_are_rejected_without_changing_the_game() {
        let mut game = dummy();
        let before = room_monsters(&game);
        for (operation, expected) in [
            (
                spawn("monster.dragon", 0, 300),
                "unknown monster definition",
            ),
            (
                spawn("monster.brute", 5_000, 0),
                "outside the workbench room",
            ),
            (
                spawn("monster.brute", i32::MAX, 0),
                "outside the workbench room",
            ),
            (
                spawn("monster.brute", 0, i32::MIN),
                "outside the workbench room",
            ),
            (spawn("monster.brute", 10, 0), "overlaps another body"),
            (spawn("monster.brute", 210, 20), "overlaps another body"),
        ] {
            let error = game.apply_workbench(&operation).unwrap_err().to_string();
            assert!(error.contains(expected), "{operation:?}: {error}");
        }
        assert_eq!(room_monsters(&game), before);
        assert!(!game.workbench.as_ref().unwrap().edited());

        let living = before.iter().filter(|monster| monster.3 > 0).count();
        for index in 0..MAX_WORKBENCH_MONSTERS - living {
            let x = -400 + 100 * i32::try_from(index % 6).unwrap();
            let z = if index < 6 { -250 } else { 250 };
            game.apply_workbench(&spawn("monster.brute", x, z)).unwrap();
        }
        let error = game
            .apply_workbench(&spawn("monster.brute", 0, 150))
            .unwrap_err();
        assert!(error.to_string().contains("at most"), "{error}");
    }

    #[test]
    fn removal_and_reset_restore_the_scenario_arrangement() {
        let mut game = dummy();
        let arranged = room_monsters(&game);
        let target = arranged[0].0;
        game.apply_workbench(&spawn("monster.archer", 0, -300))
            .unwrap();
        for _ in 0..30 {
            game.advance_tick().unwrap();
        }
        game.apply_workbench(&WorkbenchOperation::RemoveMonster { monster_id: target })
            .unwrap();
        assert!(
            room_monsters(&game)
                .iter()
                .all(|monster| monster.0 != target)
        );
        assert!(game.world.body(ArpgGame::monster_body_id(target)).is_none());
        let outside = game
            .monsters
            .iter()
            .find(|monster| monster.room_id != game.workbench.as_ref().unwrap().room_id)
            .unwrap()
            .id;
        assert!(
            game.apply_workbench(&WorkbenchOperation::RemoveMonster {
                monster_id: outside
            })
            .is_err()
        );

        game.apply_workbench(&WorkbenchOperation::ResetArrangement)
            .unwrap();
        assert_eq!(room_monsters(&game), arranged);
        game.advance_tick().unwrap();
        assert!(game.world.body(ArpgGame::monster_body_id(target)).is_some());
        // Spawned ids are never reused.
        game.apply_workbench(&spawn("monster.archer", 0, -300))
            .unwrap();
        assert_eq!(
            room_monsters(&game).last().unwrap().0,
            game.workbench.as_ref().unwrap().next_monster_id - 1
        );
        assert_eq!(game.workbench.as_ref().unwrap().spawned, 2);
    }

    #[test]
    fn a_cleared_room_reactivates_when_it_holds_monsters_again() {
        let mut game = dummy();
        let room_id = game.workbench.as_ref().unwrap().room_id;
        for monster in room_monsters(&game) {
            game.apply_workbench(&WorkbenchOperation::RemoveMonster {
                monster_id: monster.0,
            })
            .unwrap();
        }
        for _ in 0..3 {
            game.advance_tick().unwrap();
        }
        let state = |game: &ArpgGame| {
            game.rooms
                .iter()
                .find(|room| room.id == room_id)
                .unwrap()
                .encounter_state
        };
        assert_eq!(state(&game), RoomEncounterState::Cleared);
        game.apply_workbench(&spawn("monster.brute", 300, 0))
            .unwrap();
        assert_eq!(state(&game), RoomEncounterState::Dormant);
        game.advance_tick().unwrap();
        assert_eq!(state(&game), RoomEncounterState::Active);
    }

    #[test]
    fn exact_tuning_values_are_validated_with_the_content_bounds() {
        let mut game = dummy();
        let base = game.tuning_values();
        for (operation, expected) in [
            (
                tune(TuningParameter::GuardMaxPoints, 0),
                "guard.maxPoints: must be within 1..=1000",
            ),
            (
                tune(TuningParameter::GuardMaxPoints, 70_000),
                "guard.maxPoints: 70000 is out of range",
            ),
            (
                tune(TuningParameter::CounterWindowTicks, -1),
                "counterWindowTicks: -1 is out of range",
            ),
            (
                tune(TuningParameter::CounterWindowTicks, 601),
                "counterWindowTicks: must be within 1..=600",
            ),
            (
                tune(TuningParameter::BowMinDrawTicks, 30),
                "bow.minDrawTicks: must be positive and below fullDrawTicks",
            ),
            (
                tune(TuningParameter::BowArrowMinDamage, 36),
                "bow.arrowMinDamage: must not exceed arrowFullDamage",
            ),
        ] {
            let error = game.apply_workbench(&operation).unwrap_err().to_string();
            assert!(error.starts_with(expected), "{operation:?}: {error}");
        }
        assert_eq!(game.tuning_values(), base);

        game.apply_workbench(&tune(TuningParameter::GuardMaxPoints, 40))
            .unwrap();
        let player = &game.snapshot().unwrap().players[0];
        assert_eq!((player.guard_points, player.max_guard_points), (40, 40));
        assert!(game.tuning_values().contains(&TuningValue {
            parameter: TuningParameter::GuardMaxPoints,
            value: 40
        }));
        // Every parameter round-trips its current value.
        for value in game.tuning_values() {
            game.apply_workbench(&tune(value.parameter, value.value))
                .unwrap();
        }
    }

    #[test]
    fn tuned_values_drive_the_runtime() {
        let mut game = dummy();
        game.apply_workbench(&tune(TuningParameter::GuardRaiseTicks, 12))
            .unwrap();
        game.apply_command(
            PlayerCommand::new(1, 1, ArpgCommand::SetGuard { raised: true }).unwrap(),
        )
        .unwrap();
        for _ in 0..12 {
            game.advance_tick().unwrap();
            assert_eq!(
                game.players[&1].guard.stance.unwrap().phase,
                GuardPhase::Raising
            );
        }
        game.advance_tick().unwrap();
        assert_eq!(
            game.players[&1].guard.stance.unwrap().phase,
            GuardPhase::Raised
        );
        // Lowering the bound clamps the live stance.
        game.apply_workbench(&tune(TuningParameter::GuardRaiseTicks, 2))
            .unwrap();
        assert!(game.players[&1].guard.stance.unwrap().ticks_remaining <= 2);
    }

    #[test]
    fn an_edited_session_cannot_be_saved() {
        let mut game = dummy();
        assert!(game.save_state().is_ok());
        game.apply_workbench(&WorkbenchOperation::ResetArrangement)
            .unwrap();
        let error = game.save_state().unwrap_err();
        assert!(error.to_string().contains("workbench"), "{error}");
    }

    #[test]
    fn recorded_operations_replay_in_their_order_among_commands() {
        let mut game = ArpgGame::new_scenario(ScenarioId::Dummy, 42).unwrap();
        let mut recorder = ReproductionRecorder::start(&game).unwrap();
        game.add_player(1).unwrap();
        recorder.record_player_added(1);
        let mut sequence = 0;
        let mut live = Vec::new();
        let target = room_monsters(&game)[0].0;
        for tick in 0..90 {
            let mut steps: Vec<Result<ArpgCommand, WorkbenchOperation>> = Vec::new();
            match tick {
                0 => steps.push(Err(tune(TuningParameter::CounterWindowTicks, 12))),
                // Same tick: lock first, then remove the locked target, then spawn.
                5 => {
                    steps.push(Ok(ArpgCommand::CycleTarget));
                    steps.push(Err(WorkbenchOperation::RemoveMonster {
                        monster_id: target,
                    }));
                    steps.push(Err(spawn("monster.skirmisher", 150, 0)));
                    steps.push(Ok(ArpgCommand::CycleTarget));
                }
                20 => steps.push(Ok(ArpgCommand::PrimaryAttack)),
                50 => {
                    steps.push(Err(WorkbenchOperation::ResetArrangement));
                    steps.push(Ok(ArpgCommand::SetMovement { x: 1, z: 0 }));
                }
                60 => steps.push(Ok(ArpgCommand::SetMovement { x: 0, z: 0 })),
                _ => {}
            }
            for step in steps {
                match step {
                    Ok(command) => {
                        sequence += 1;
                        let command = PlayerCommand::new(1, sequence, command).unwrap();
                        game.apply_command(command.clone()).unwrap();
                        recorder.record_command(&command);
                    }
                    Err(operation) => {
                        game.apply_workbench(&operation).unwrap();
                        recorder.record_workbench(&operation);
                    }
                }
            }
            game.advance_tick().unwrap();
            recorder.record_tick();
            live.push(game.snapshot().unwrap());
        }
        // A pending operation after the last tick is left out like a pending command.
        game.apply_workbench(&WorkbenchOperation::ResetArrangement)
            .unwrap();
        recorder.record_workbench(&WorkbenchOperation::ResetArrangement);

        let reproduction = recorder.reproduction().unwrap();
        assert_eq!(reproduction.operations.len(), 4);
        assert_eq!(reproduction.operations[1].command_index, 1);
        assert_eq!(reproduction.operations[2].command_index, 1);
        let json = serde_json::to_string(&reproduction).unwrap();
        let decoded: Reproduction = serde_json::from_str(&json).unwrap();
        assert_eq!(replay_reproduction(&decoded).unwrap(), live);

        // An operation whose position does not match the command stream never applies.
        let mut misplaced = decoded.clone();
        misplaced.operations[1].command_index = 3;
        assert!(replay_reproduction(&misplaced).is_err());
        let mut late = decoded;
        late.operations[3].tick = 95;
        assert!(replay_reproduction(&late).is_err());
    }

    #[test]
    fn a_player_joining_after_an_operation_stops_the_recording() {
        let mut game = ArpgGame::new_scenario(ScenarioId::Dummy, 42).unwrap();
        let mut recorder = ReproductionRecorder::start(&game).unwrap();
        let operation = tune(TuningParameter::GuardMaxPoints, 200);
        game.apply_workbench(&operation).unwrap();
        recorder.record_workbench(&operation);
        game.add_player(1).unwrap();
        recorder.record_player_added(1);
        let error = recorder.reproduction().unwrap_err();
        assert!(error.to_string().contains("joined"), "{error}");
    }

    #[test]
    fn only_workbench_games_name_a_workbench_room() {
        assert_eq!(dummy().workbench_room(), Some(crate::SCENARIO_ROOM));
        assert_eq!(ArpgGame::new_with_seed(42).unwrap().workbench_room(), None);
    }

    #[test]
    fn reproductions_without_operations_keep_their_form() {
        let game = ArpgGame::new_scenario(ScenarioId::Dummy, 42).unwrap();
        let reproduction = ReproductionRecorder::start(&game)
            .unwrap()
            .reproduction()
            .unwrap();
        let json = serde_json::to_string(&reproduction).unwrap();
        assert!(!json.contains("operations"), "{json}");
        assert_eq!(
            serde_json::from_str::<Reproduction>(&json).unwrap(),
            reproduction
        );
    }

    #[test]
    fn operations_use_a_stable_wire_form() {
        let operations = [
            spawn("monster.brute", -20, 30),
            WorkbenchOperation::RemoveMonster { monster_id: 7 },
            WorkbenchOperation::ResetArrangement,
            tune(TuningParameter::BowFullDrawTicks, 40),
        ];
        let json = serde_json::to_string(&operations).unwrap();
        assert_eq!(
            json,
            r#"[{"type":"spawnMonster","definition":"monster.brute","offset":[-20,30]},{"type":"removeMonster","monsterId":7},{"type":"resetArrangement"},{"type":"setTuning","parameter":"bow.fullDrawTicks","value":40}]"#
        );
        for parameter in TuningParameter::ALL {
            assert_eq!(
                serde_json::to_string(&parameter).unwrap(),
                format!("\"{}\"", parameter.name())
            );
        }
        assert!(
            serde_json::from_str::<WorkbenchOperation>(
                r#"{"type":"removeMonster","monsterId":1,"extra":1}"#
            )
            .is_err()
        );
    }
}
