//! Immutable, validated gameplay definitions.
//!
//! Definitions select supported behaviour; executable rules stay in Rust. A bundle is
//! canonicalised (arrays ordered by id), validated once at load, and identified by a
//! content revision so saves and sessions cannot silently mix bundles. Appearance and audio
//! never live here: loading another mesh cannot change reach, timing or rewards.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};

use crate::{ActionKind, ComboInput};

pub const CONTENT_FORMAT_VERSION: u16 = 4;
/// Touching monster and player bodies keep their centres up to √2 times their
/// combined XZ half extents apart (85 units), and pursuit stops one navigation
/// cell inside strike reach, so a monster strike must reach past both.
pub(crate) const MIN_MONSTER_STRIKE_REACH: i64 = {
    let monster = crate::MONSTER_BODY_HALF_EXTENTS;
    let player = crate::PLAYER_HALF_EXTENTS;
    let combined = (max_i32(monster.x, monster.z) + max_i32(player.x, player.z)) as i64;
    let squared = 2 * combined * combined;
    let root = squared.isqrt();
    let touching = if root * root == squared {
        root
    } else {
        root + 1
    };
    touching + crate::navigation::NAV_CELL_SIZE as i64
};

const fn max_i32(a: i32, b: i32) -> i32 {
    if a > b { a } else { b }
}
/// Longest definition id; matches the browser projection's bound on published ids.
pub const MAX_DEFINITION_ID_LENGTH: usize = 64;

const BASE_BUNDLE: &str = include_str!("../content/base.json");

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContentBundle {
    pub format_version: u16,
    /// Ticks a successful block keeps the counter opportunity open.
    pub counter_window_ticks: u64,
    pub strikes: Vec<StrikeData>,
    pub actions: Vec<ActionData>,
    pub combos: Vec<ComboData>,
    pub monsters: Vec<MonsterData>,
    /// Monster definition of each combat room, in generation order. Rooms beyond the list
    /// repeat it from the start. Order is authored, so it is not canonicalised.
    pub room_monsters: Vec<String>,
    pub guard: GuardData,
    pub bow: BowData,
    pub progression: ProgressionData,
    pub loot: LootData,
}

/// Shield guard tuning.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GuardData {
    /// Ticks between pressing guard and the shield protecting.
    pub raise_ticks: u8,
    pub max_points: u16,
    /// Guard regenerates only while lowered and not broken.
    pub regen_per_tick: u16,
    pub block_reaction_ticks: u8,
    /// Ticks a broken guard cannot be raised.
    pub break_ticks: u8,
}

/// Bow draw and arrow tuning. Speeds are world units per tick.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BowData {
    /// Draw ticks below which a release does not shoot.
    pub min_draw_ticks: u8,
    /// Draw ticks at which an arrow reaches full speed and damage.
    pub full_draw_ticks: u8,
    pub arrow_min_speed: u16,
    pub arrow_full_speed: u16,
    pub arrow_min_damage: u16,
    pub arrow_full_damage: u16,
    pub arrow_lifetime_ticks: u8,
    pub arrow_stagger_ticks: u8,
    /// Launching beyond this many live arrows retires the oldest.
    pub max_live_arrows: u8,
}

/// Character level curve.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProgressionData {
    pub experience_per_level: u32,
    pub base_max_health: u16,
    pub max_health_per_level: u16,
    pub base_attack_damage: u16,
    pub attack_damage_per_level: u16,
}

/// Gold rewards.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LootData {
    /// Gold a defeated monster drops.
    pub monster_gold: u32,
    /// Gold a reward chest holds.
    pub chest_gold: u32,
}

/// Authored melee strike geometry on the gameplay plane.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StrikeData {
    pub id: String,
    /// Maximum centre-to-centre reach in world units.
    pub reach: i64,
    /// Frontal strikes only contact targets within 60 degrees of the committed facing.
    pub frontal: bool,
    /// Maximum targets connected; `null` means every eligible target.
    pub max_targets: Option<u32>,
    pub blockable: bool,
    pub guard_cost: u16,
}

/// One supported player action. `kind` binds the definition to the Rust behaviour.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ActionData {
    pub id: String,
    pub kind: ActionKind,
    pub windup_ticks: u8,
    pub active_ticks: u8,
    pub recovery_ticks: u8,
    pub strike: Option<String>,
    pub damage_numerator: u16,
    pub damage_denominator: u16,
    pub stagger_ticks: u8,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ComboData {
    pub from: String,
    pub input: ComboInput,
    pub opens_at: u8,
    pub closes_at: u8,
    pub requires_hit: bool,
    pub to: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MonsterData {
    pub id: String,
    pub health: u16,
    pub strike: String,
    pub windup_ticks: u8,
    pub active_ticks: u8,
    pub recovery_ticks: u8,
    pub damage: u16,
    pub experience_reward: u32,
    /// Pursuit speed in world units per tick.
    pub pursuit_speed: u8,
    /// A monster at rest engages a living player of its room within this distance.
    pub aggro_range: u16,
    /// An engaged monster farther than this from its post breaks off and returns.
    pub leash_range: u16,
    /// A competing player must be this much nearer than the current target to take over.
    pub target_switch_margin: u16,
    /// Ticks a monster that lost its target holds before it looks for another.
    pub reacquire_ticks: u8,
    /// Moving monsters steer apart from other monsters within this centre distance.
    pub separation_range: u16,
}

/// One invariant violation, with the definition path that broke it.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ContentError {
    pub path: String,
    pub message: String,
}

impl fmt::Display for ContentError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}: {}", self.path, self.message)
    }
}

/// Resolved strike parameters used by the hot path.
#[derive(Clone, Copy, Debug)]
pub(crate) struct StrikeDefinition {
    pub id: &'static str,
    pub reach: i64,
    pub frontal: bool,
    pub max_targets: usize,
    pub blockable: bool,
    pub guard_cost: u16,
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct ActionDefinition {
    pub windup_ticks: u8,
    pub active_ticks: u8,
    pub recovery_ticks: u8,
    pub strike: Option<StrikeDefinition>,
    pub damage_numerator: u16,
    pub damage_denominator: u16,
    pub stagger_ticks: u8,
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct ComboTransition {
    pub from: ActionKind,
    pub input: ComboInput,
    pub opens_at: u8,
    pub closes_at: u8,
    pub requires_hit: bool,
    pub to: ActionKind,
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct MonsterDefinition {
    pub id: &'static str,
    pub health: u16,
    pub strike: StrikeDefinition,
    pub windup_ticks: u8,
    pub active_ticks: u8,
    pub recovery_ticks: u8,
    pub damage: u16,
    pub experience_reward: u32,
    pub pursuit_speed: i32,
    pub aggro_range: i64,
    pub leash_range: i64,
    pub target_switch_margin: i64,
    pub reacquire_ticks: u8,
    pub separation_range: i64,
}

/// A validated bundle with resolved references.
#[derive(Debug)]
pub(crate) struct Content {
    pub revision: String,
    pub counter_window_ticks: u64,
    actions: BTreeMap<ActionKind, ActionDefinition>,
    pub combos: Vec<ComboTransition>,
    /// Canonical (id) order; monsters refer to their definition by index.
    pub monsters: Vec<MonsterDefinition>,
    /// Index into `monsters` for each combat room, in generation order (repeating).
    pub room_monsters: Vec<usize>,
    pub guard: GuardData,
    pub bow: BowData,
    pub progression: ProgressionData,
    pub loot: LootData,
}

impl Content {
    pub fn action(&self, kind: ActionKind) -> ActionDefinition {
        *self
            .actions
            .get(&kind)
            .expect("validation requires one definition per action kind")
    }

    /// Longest stagger any player action or arrow applies.
    pub fn max_stagger_ticks(&self) -> u8 {
        self.actions
            .values()
            .map(|action| action.stagger_ticks)
            .max()
            .unwrap_or(0)
            .max(self.bow.arrow_stagger_ticks)
    }

    pub fn monster(&self, definition: usize) -> &MonsterDefinition {
        &self.monsters[definition]
    }

    /// The monster definition generated into the combat room at `combat_room_index`.
    pub fn room_monster(&self, combat_room_index: usize) -> usize {
        self.room_monsters[combat_room_index % self.room_monsters.len()]
    }
}

const ALL_ACTION_KINDS: [ActionKind; 8] = [
    ActionKind::PrimaryAttack,
    ActionKind::SecondaryAttack,
    ActionKind::Interact,
    ActionKind::Counter,
    ActionKind::LightFollowUp,
    ActionKind::LightFinisher,
    ActionKind::HeavyFinisher,
    ActionKind::Shoot,
];

/// Kinds whose behaviour resolves a melee strike and therefore need one.
fn strikes(kind: ActionKind) -> bool {
    !matches!(kind, ActionKind::Interact | ActionKind::Shoot)
}

impl ContentBundle {
    /// Parses JSON and orders every collection canonically, so source order never matters.
    pub fn from_json(json: &str) -> Result<Self, Vec<ContentError>> {
        // Read the format first: an older bundle should report its version, not the
        // first field the current format added.
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Format {
            format_version: Option<u16>,
        }
        if let Ok(Format {
            format_version: Some(version),
        }) = serde_json::from_str::<Format>(json)
            && version != CONTENT_FORMAT_VERSION
        {
            return Err(vec![ContentError {
                path: "formatVersion".into(),
                message: format!(
                    "unsupported content format version {version}; expected {CONTENT_FORMAT_VERSION}"
                ),
            }]);
        }
        let mut bundle: Self = serde_json::from_str(json).map_err(|error| {
            vec![ContentError {
                path: "$".into(),
                message: format!("invalid content JSON: {error}"),
            }]
        })?;
        bundle.canonicalize();
        Ok(bundle)
    }

    fn canonicalize(&mut self) {
        self.strikes.sort_by(|left, right| left.id.cmp(&right.id));
        self.actions.sort_by(|left, right| left.id.cmp(&right.id));
        self.monsters.sort_by(|left, right| left.id.cmp(&right.id));
        self.combos.sort_by(|left, right| {
            (&left.from, left.input as u8).cmp(&(&right.from, right.input as u8))
        });
    }

    /// FNV-1a over the canonical JSON: a stable identity for saves and sessions.
    pub fn revision(&self) -> String {
        let canonical = serde_json::to_vec(self).expect("bundle serialises");
        let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
        for byte in canonical {
            hash ^= u64::from(byte);
            hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
        }
        format!("{hash:016x}")
    }

    /// Validates every reference and numeric bound, collecting all violations.
    pub(crate) fn validate(&'static self) -> Result<Content, Vec<ContentError>> {
        let mut errors = Vec::new();
        let mut fail = |path: String, message: &str| {
            errors.push(ContentError {
                path,
                message: message.into(),
            });
        };
        if self.format_version != CONTENT_FORMAT_VERSION {
            fail("formatVersion".into(), "unsupported content format version");
        }
        if self.counter_window_ticks == 0 || self.counter_window_ticks > 600 {
            fail("counterWindowTicks".into(), "must be within 1..=600");
        }

        // Definition ids are published to clients (for example as strike event definitions),
        // so they must stay within what the browser projection admits.
        let ids = self
            .strikes
            .iter()
            .map(|strike| ("strikes", &strike.id))
            .chain(self.actions.iter().map(|action| ("actions", &action.id)))
            .chain(
                self.monsters
                    .iter()
                    .map(|monster| ("monsters", &monster.id)),
            );
        for (collection, id) in ids {
            if id.is_empty() || id.len() > MAX_DEFINITION_ID_LENGTH || !id.is_ascii() {
                fail(
                    format!("{collection} {id:?}"),
                    "ids must be 1..=64 ASCII characters",
                );
            }
        }

        let mut strike_by_id = BTreeMap::new();
        for (index, strike) in self.strikes.iter().enumerate() {
            let path = format!("strikes[{index}] {}", strike.id);
            if strike_by_id.insert(strike.id.as_str(), strike).is_some() {
                fail(path.clone(), "duplicate strike id");
            }
            if !(1..=1_000).contains(&strike.reach) {
                fail(path.clone(), "reach must be within 1..=1000");
            }
            if strike.max_targets == Some(0) {
                fail(path, "maxTargets must be positive or null");
            }
        }
        let resolve_strike = |strike: &'static StrikeData| StrikeDefinition {
            id: strike.id.as_str(),
            reach: strike.reach,
            frontal: strike.frontal,
            max_targets: strike.max_targets.map_or(usize::MAX, |count| {
                usize::try_from(count).unwrap_or(usize::MAX)
            }),
            blockable: strike.blockable,
            guard_cost: strike.guard_cost,
        };

        let mut action_ids = BTreeMap::new();
        let mut actions = BTreeMap::new();
        for (index, action) in self.actions.iter().enumerate() {
            let path = format!("actions[{index}] {}", action.id);
            if action_ids.insert(action.id.as_str(), action.kind).is_some() {
                fail(path.clone(), "duplicate action id");
            }
            if action.windup_ticks == 0 || action.active_ticks == 0 || action.recovery_ticks == 0 {
                fail(path.clone(), "every phase needs at least one tick");
            }
            if action.damage_denominator == 0 {
                fail(path.clone(), "damageDenominator must be positive");
            }
            let strike = match (&action.strike, strikes(action.kind)) {
                (Some(id), true) => match strike_by_id.get(id.as_str()) {
                    Some(strike) => Some(resolve_strike(strike)),
                    None => {
                        fail(path.clone(), "references an unknown strike");
                        None
                    }
                },
                (None, true) => {
                    fail(path.clone(), "this action kind needs a strike");
                    None
                }
                (Some(_), false) => {
                    fail(path.clone(), "this action kind cannot strike");
                    None
                }
                (None, false) => None,
            };
            let definition = ActionDefinition {
                windup_ticks: action.windup_ticks,
                active_ticks: action.active_ticks,
                recovery_ticks: action.recovery_ticks,
                strike,
                damage_numerator: action.damage_numerator,
                damage_denominator: action.damage_denominator.max(1),
                stagger_ticks: action.stagger_ticks,
            };
            if actions.insert(action.kind, definition).is_some() {
                fail(path, "a second definition for the same action kind");
            }
        }
        for kind in ALL_ACTION_KINDS {
            if !actions.contains_key(&kind) {
                fail(
                    format!("actions ({kind:?})"),
                    "missing the definition for a supported action kind",
                );
            }
        }

        let mut combos = Vec::new();
        let mut combo_keys = BTreeSet::new();
        for (index, combo) in self.combos.iter().enumerate() {
            let path = format!("combos[{index}] {}→{}", combo.from, combo.to);
            let from = action_ids.get(combo.from.as_str()).copied();
            let to = action_ids.get(combo.to.as_str()).copied();
            if from.is_none() || to.is_none() {
                fail(path.clone(), "references an unknown action");
            }
            if !combo_keys.insert((combo.from.as_str(), combo.input as u8)) {
                fail(
                    path.clone(),
                    "duplicate transition for the same action and input",
                );
            }
            if combo.opens_at >= combo.closes_at {
                fail(path.clone(), "opensAt must be before closesAt");
            }
            if let (Some(from), Some(to)) = (from, to) {
                let recovery = actions.get(&from).map_or(0, |action| action.recovery_ticks);
                if combo.closes_at > recovery {
                    fail(
                        path.clone(),
                        "closesAt must be within the predecessor's recovery",
                    );
                }
                if !strikes(from) || !strikes(to) {
                    fail(path.clone(), "combos connect striking actions only");
                }
                combos.push(ComboTransition {
                    from,
                    input: combo.input,
                    opens_at: combo.opens_at,
                    closes_at: combo.closes_at,
                    requires_hit: combo.requires_hit,
                    to,
                });
            }
        }

        let mut monsters = Vec::new();
        let mut monster_index = BTreeMap::new();
        for (index, monster) in self.monsters.iter().enumerate() {
            let path = format!("monsters[{index}] {}", monster.id);
            if monster_index
                .insert(monster.id.as_str(), monsters.len())
                .is_some()
            {
                fail(path.clone(), "duplicate monster id");
            }
            if monster.health == 0 {
                fail(path.clone(), "health must be positive");
            }
            if monster.windup_ticks == 0 || monster.active_ticks == 0 || monster.recovery_ticks == 0
            {
                fail(path.clone(), "every phase needs at least one tick");
            }
            if monster.pursuit_speed == 0 {
                fail(path.clone(), "pursuit speed must be positive");
            }
            let reach = strike_by_id
                .get(monster.strike.as_str())
                .map_or(0, |strike| strike.reach);
            if i64::from(monster.aggro_range) < reach {
                fail(
                    path.clone(),
                    "aggroRange must reach at least as far as the strike",
                );
            }
            if monster.leash_range <= monster.aggro_range {
                fail(path.clone(), "leashRange must exceed aggroRange");
            }
            if monster.target_switch_margin > monster.aggro_range {
                fail(
                    path.clone(),
                    "targetSwitchMargin must not exceed aggroRange",
                );
            }
            if monster.reacquire_ticks == 0 {
                fail(path.clone(), "reacquireTicks must be positive");
            }
            if monster.separation_range > 400 {
                fail(path.clone(), "separationRange must be within 0..=400");
            }
            match strike_by_id.get(monster.strike.as_str()) {
                Some(strike) => {
                    if strike.reach < MIN_MONSTER_STRIKE_REACH {
                        fail(
                            path.clone(),
                            &format!(
                                "monster strike reach must be at least {MIN_MONSTER_STRIKE_REACH} units for pursuit"
                            ),
                        );
                    }
                    monsters.push(MonsterDefinition {
                        id: monster.id.as_str(),
                        health: monster.health,
                        strike: resolve_strike(strike),
                        windup_ticks: monster.windup_ticks,
                        active_ticks: monster.active_ticks,
                        recovery_ticks: monster.recovery_ticks,
                        damage: monster.damage,
                        experience_reward: monster.experience_reward,
                        pursuit_speed: i32::from(monster.pursuit_speed),
                        aggro_range: i64::from(monster.aggro_range),
                        leash_range: i64::from(monster.leash_range),
                        target_switch_margin: i64::from(monster.target_switch_margin),
                        reacquire_ticks: monster.reacquire_ticks,
                        separation_range: i64::from(monster.separation_range),
                    });
                }
                None => fail(path, "references an unknown strike"),
            }
        }
        if monsters.is_empty() {
            fail(
                "monsters".into(),
                "at least one monster definition is required",
            );
        }

        let mut room_monsters = Vec::new();
        for (index, id) in self.room_monsters.iter().enumerate() {
            match monster_index.get(id.as_str()) {
                Some(&definition) => room_monsters.push(definition),
                None => fail(
                    format!("roomMonsters[{index}] {id}"),
                    "references an unknown monster",
                ),
            }
        }
        if self.room_monsters.is_empty() {
            fail(
                "roomMonsters".into(),
                "at least one combat room monster is required",
            );
        }

        let guard = self.guard;
        if !(1..=60).contains(&guard.raise_ticks) {
            fail("guard.raiseTicks".into(), "must be within 1..=60");
        }
        if !(1..=1_000).contains(&guard.max_points) {
            fail("guard.maxPoints".into(), "must be within 1..=1000");
        }
        if guard.regen_per_tick > guard.max_points {
            fail("guard.regenPerTick".into(), "must not exceed maxPoints");
        }
        if guard.block_reaction_ticks == 0 || guard.break_ticks == 0 {
            fail(
                "guard".into(),
                "blockReactionTicks and breakTicks must be positive",
            );
        }

        let bow = self.bow;
        if bow.min_draw_ticks == 0 || bow.min_draw_ticks >= bow.full_draw_ticks {
            fail(
                "bow.minDrawTicks".into(),
                "must be positive and below fullDrawTicks",
            );
        }
        if bow.full_draw_ticks > 120 {
            fail("bow.fullDrawTicks".into(), "must be at most 120");
        }
        if bow.arrow_min_speed == 0
            || bow.arrow_min_speed > bow.arrow_full_speed
            || bow.arrow_full_speed > 200
        {
            fail(
                "bow.arrowMinSpeed".into(),
                "speeds must satisfy 1 <= arrowMinSpeed <= arrowFullSpeed <= 200",
            );
        }
        if bow.arrow_min_damage > bow.arrow_full_damage {
            fail(
                "bow.arrowMinDamage".into(),
                "must not exceed arrowFullDamage",
            );
        }
        if bow.arrow_lifetime_ticks == 0 {
            fail("bow.arrowLifetimeTicks".into(), "must be positive");
        }
        if !(1..=64).contains(&bow.max_live_arrows) {
            fail("bow.maxLiveArrows".into(), "must be within 1..=64");
        }

        let progression = self.progression;
        if progression.experience_per_level == 0 {
            fail("progression.experiencePerLevel".into(), "must be positive");
        }
        if progression.base_max_health == 0 {
            fail("progression.baseMaxHealth".into(), "must be positive");
        }

        let loot = self.loot;
        if loot.monster_gold == 0 || loot.chest_gold == 0 {
            fail("loot".into(), "gold rewards must be positive");
        }

        if errors.is_empty() {
            Ok(Content {
                revision: self.revision(),
                counter_window_ticks: self.counter_window_ticks,
                actions,
                combos,
                monsters,
                room_monsters,
                guard,
                bow,
                progression,
                loot,
            })
        } else {
            Err(errors)
        }
    }
}

static BASE: OnceLock<(ContentBundle, Content)> = OnceLock::new();

fn base() -> &'static (ContentBundle, Content) {
    BASE.get_or_init(|| {
        let bundle: &'static ContentBundle = Box::leak(Box::new(
            ContentBundle::from_json(BASE_BUNDLE).expect("built-in content parses"),
        ));
        let content = bundle.validate().unwrap_or_else(|errors| {
            panic!("built-in content is invalid: {errors:?}");
        });
        (bundle.clone(), content)
    })
}

/// The validated built-in content every authority runs.
pub(crate) fn content() -> &'static Content {
    &base().1
}

/// The canonical built-in bundle.
pub fn base_bundle() -> &'static ContentBundle {
    &base().0
}

/// Revision of the built-in content, recorded in snapshots and saves.
pub fn content_revision() -> &'static str {
    &content().revision
}

#[cfg(test)]
mod tests {
    use super::*;

    fn leak(bundle: ContentBundle) -> &'static ContentBundle {
        Box::leak(Box::new(bundle))
    }

    fn errors(mutate: impl FnOnce(&mut ContentBundle)) -> Vec<String> {
        let mut bundle = base_bundle().clone();
        mutate(&mut bundle);
        leak(bundle)
            .validate()
            .expect_err("mutated bundle must be rejected")
            .into_iter()
            .map(|error| error.to_string())
            .collect()
    }

    #[test]
    fn source_order_does_not_change_canonical_content_or_revision() {
        let mut shuffled: serde_json::Value = serde_json::from_str(BASE_BUNDLE).unwrap();
        for key in ["strikes", "actions", "combos", "monsters"] {
            shuffled[key].as_array_mut().unwrap().reverse();
        }
        let reparsed = ContentBundle::from_json(&shuffled.to_string()).unwrap();
        assert_eq!(&reparsed, base_bundle());
        assert_eq!(reparsed.revision(), content_revision());
        assert_eq!(content_revision().len(), 16);

        // Room assignment is authored order, so reordering it is a different bundle.
        let mut reassigned = base_bundle().clone();
        reassigned.room_monsters.reverse();
        assert_ne!(reassigned.room_monsters, base_bundle().room_monsters);
        assert_ne!(reassigned.revision(), content_revision());
    }

    #[test]
    fn invalid_bundles_report_the_definition_path_and_invariant() {
        let duplicate = errors(|bundle| {
            let copy = bundle.strikes[0].clone();
            bundle.strikes.push(copy);
        });
        assert!(
            duplicate
                .iter()
                .any(|error| error.contains("duplicate strike id"))
        );

        let unknown = errors(|bundle| {
            let light = bundle
                .actions
                .iter_mut()
                .find(|action| action.id == "sword.light")
                .unwrap();
            light.strike = Some("sword.missing".into());
        });
        assert!(
            unknown
                .iter()
                .any(|error| error.contains("sword.light") && error.contains("unknown strike"))
        );

        let missing = errors(|bundle| {
            bundle
                .actions
                .retain(|action| action.kind != ActionKind::Shoot)
        });
        assert!(missing.iter().any(|error| error.contains("Shoot")));

        let zero = errors(|bundle| bundle.actions[1].windup_ticks = 0);
        assert!(zero.iter().any(|error| error.contains("at least one tick")));

        let late = errors(|bundle| bundle.combos[0].closes_at = 200);
        assert!(
            late.iter()
                .any(|error| error.contains("within the predecessor's recovery"))
        );

        let twin = errors(|bundle| {
            let copy = bundle.monsters[0].clone();
            bundle.monsters.push(copy);
        });
        assert!(
            twin.iter()
                .any(|error| error.contains("duplicate monster id"))
        );

        let unknown_room_monster = errors(|bundle| {
            bundle.room_monsters[1] = "monster.missing".into();
        });
        assert!(unknown_room_monster.iter().any(|error| {
            error.starts_with("roomMonsters[1] monster.missing")
                && error.contains("unknown monster")
        }));
        assert!(
            errors(|bundle| bundle.room_monsters.clear())
                .iter()
                .any(|error| error.starts_with("roomMonsters"))
        );

        let tuning = errors(|bundle| {
            bundle.bow.min_draw_ticks = bundle.bow.full_draw_ticks;
            bundle.bow.arrow_min_damage = bundle.bow.arrow_full_damage + 1;
            bundle.guard.raise_ticks = 0;
            bundle.progression.experience_per_level = 0;
            bundle.loot.chest_gold = 0;
        });
        for path in [
            "bow.minDrawTicks",
            "bow.arrowMinDamage",
            "guard.raiseTicks",
            "progression.experiencePerLevel",
            "loot",
        ] {
            assert!(
                tuning.iter().any(|error| error.starts_with(path)),
                "{path}: {tuning:?}"
            );
        }

        let short_reach = errors(|bundle| {
            let claw = bundle
                .strikes
                .iter_mut()
                .find(|strike| strike.id == "monster.claw")
                .unwrap();
            claw.reach = MIN_MONSTER_STRIKE_REACH - 1;
        });
        assert_eq!(MIN_MONSTER_STRIKE_REACH, 105);
        assert!(
            short_reach
                .iter()
                .any(|error| error.contains("at least 105 units"))
        );

        let tethered = errors(|bundle| {
            let brute = &mut bundle.monsters[0];
            brute.aggro_range = 100;
            brute.leash_range = 100;
            brute.reacquire_ticks = 0;
            brute.target_switch_margin = 101;
        });
        for invariant in [
            "leashRange must exceed aggroRange",
            "reacquireTicks must be positive",
            "aggroRange must reach at least as far as the strike",
            "targetSwitchMargin must not exceed aggroRange",
        ] {
            assert!(
                tethered.iter().any(|error| error.contains(invariant)),
                "{invariant}: {tethered:?}"
            );
        }

        let long = errors(|bundle| bundle.strikes[0].id = "s".repeat(65));
        assert!(long.iter().any(|error| error.contains("1..=64 ASCII")));

        let format = errors(|bundle| bundle.format_version = 99);
        assert!(
            format
                .iter()
                .any(|error| error.starts_with("formatVersion"))
        );

        assert!(ContentBundle::from_json("{\"formatVersion\": 1, \"surprise\": true}").is_err());
    }

    #[test]
    fn an_older_format_bundle_reports_its_version_before_missing_fields() {
        let mut previous: serde_json::Value = serde_json::from_str(BASE_BUNDLE).unwrap();
        previous["formatVersion"] = 3.into();
        let fields = previous.as_object_mut().unwrap();
        for added in ["roomMonsters", "guard", "bow", "progression", "loot"] {
            fields.remove(added);
        }

        let errors = ContentBundle::from_json(&previous.to_string()).unwrap_err();

        assert_eq!(errors.len(), 1);
        assert_eq!(errors[0].path, "formatVersion");
        assert!(
            errors[0]
                .message
                .contains("unsupported content format version 3")
        );
    }
}
