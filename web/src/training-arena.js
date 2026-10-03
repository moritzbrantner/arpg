export const TRAINING_SCENARIO = "training";
export const DEFAULT_TRAINING_SEED = 0xa4200916;
export const TRAINING_SPEEDS = Object.freeze([0.25, 0.5, 1, 2]);

export function parseRunSeed(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 0xffff_ffff ? parsed : null;
}

export function readTrainingRequest(search) {
  const params = new URLSearchParams(search);
  const requested = params.get("scenario") === TRAINING_SCENARIO;
  const requestedSeed = parseRunSeed(params.get("seed"));
  return {
    requested,
    seed: requestedSeed ?? DEFAULT_TRAINING_SEED,
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

export function withTrainingRequest(href, enabled, seed) {
  const url = new URL(href);
  if (enabled) {
    url.searchParams.set("scenario", TRAINING_SCENARIO);
    url.searchParams.set("seed", String(seed));
  } else {
    url.searchParams.delete("scenario");
  }
  return url.toString();
}
