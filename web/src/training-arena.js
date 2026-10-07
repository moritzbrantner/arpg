export const TRAINING_SCENARIO = "training";
export const DEFAULT_TRAINING_SEED = 0xa4200916;
export const TRAINING_SPEEDS = Object.freeze([0.25, 0.5, 1, 2]);
// Named workbench scenarios owned by arpg-core (`ScenarioId`); the browser only selects one.
export const DEFAULT_SCENARIO = "dungeon";
export const SCENARIOS = Object.freeze([
  { id: "dungeon", label: "Generated dungeon" },
  { id: "dummy", label: "Target dummy" },
  { id: "enemy", label: "Active enemy" },
  { id: "obstructed", label: "Dummy behind a pillar" },
  { id: "archery", label: "Archery range" },
  { id: "archeryObstructed", label: "Archery behind a pillar" },
  { id: "ranged", label: "Ranged enemy" },
  { id: "heavy", label: "Heavy enemy" },
]);
const SCENARIO_IDS = new Set(SCENARIOS.map((scenario) => scenario.id));

export function parseRunSeed(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 0xffff_ffff ? parsed : null;
}

export function readTrainingRequest(search) {
  const params = new URLSearchParams(search);
  const requested = params.get("scenario") === TRAINING_SCENARIO;
  const requestedSeed = parseRunSeed(params.get("seed"));
  const fixture = params.get("fixture");
  return {
    requested,
    seed: requestedSeed ?? DEFAULT_TRAINING_SEED,
    // Unknown names fall back to the plain dungeon instead of breaking startup.
    fixture: fixture !== null && SCENARIO_IDS.has(fixture) ? fixture : DEFAULT_SCENARIO,
    unknownFixture: fixture !== null && !SCENARIO_IDS.has(fixture) ? fixture : null,
  };
}

export function trainingTicksForFrame(speed, carry = 0) {
  if (!Number.isFinite(speed) || speed <= 0) {
    return { ticks: 0, carry: 0 };
  }
  const total = carry + speed;
  const ticks = Math.floor(total);
  return { ticks, carry: total - ticks };
}

export function withTrainingRequest(href, enabled, seed, fixture = DEFAULT_SCENARIO) {
  const url = new URL(href);
  if (enabled) {
    url.searchParams.set("scenario", TRAINING_SCENARIO);
    url.searchParams.set("seed", String(seed));
    if (fixture === DEFAULT_SCENARIO) url.searchParams.delete("fixture");
    else url.searchParams.set("fixture", fixture);
  } else {
    url.searchParams.delete("scenario");
    url.searchParams.delete("fixture");
  }
  return url.toString();
}
