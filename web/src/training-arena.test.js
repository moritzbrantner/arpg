import { expect, test } from "bun:test";

import {
  DEFAULT_TRAINING_SEED,
  parseRunSeed,
  readTrainingRequest,
  trainingTicksForFrame,
  withTrainingRequest,
} from "./training-arena.js";

test("reads a deterministic training request from the URL", () => {
  expect(readTrainingRequest("?scenario=training&seed=42")).toEqual({
    requested: true,
    seed: 42,
  });
  expect(readTrainingRequest("?scenario=training&seed=invalid")).toEqual({
    requested: true,
    seed: DEFAULT_TRAINING_SEED,
  });
  expect(readTrainingRequest("?seed=7")).toEqual({
    requested: false,
    seed: 7,
  });
});

test("accepts only unsigned 32-bit integer seeds", () => {
  expect(parseRunSeed("0")).toBe(0);
  expect(parseRunSeed("4294967295")).toBe(0xffff_ffff);
  expect(parseRunSeed("-1")).toBeNull();
  expect(parseRunSeed("4294967296")).toBeNull();
  expect(parseRunSeed("1.5")).toBeNull();
});

test("schedules fractional and accelerated simulation speeds deterministically", () => {
  let carry = 0;
  let ticks = 0;
  for (let frame = 0; frame < 4; frame += 1) {
    const next = trainingTicksForFrame(0.25, carry);
    ticks += next.ticks;
    carry = next.carry;
  }
  expect(ticks).toBe(1);
  expect(carry).toBe(0);

  expect(trainingTicksForFrame(2, 0)).toEqual({ ticks: 2, carry: 0 });
});

test("writes and removes the training scenario without discarding other query state", () => {
  const enabled = new URL(withTrainingRequest("https://example.test/game?join=ABCD", true, 99));
  expect(enabled.searchParams.get("scenario")).toBe("training");
  expect(enabled.searchParams.get("seed")).toBe("99");
  expect(enabled.searchParams.get("join")).toBe("ABCD");

  const disabled = new URL(withTrainingRequest(enabled.toString(), false, 99));
  expect(disabled.searchParams.has("scenario")).toBe(false);
  expect(disabled.searchParams.get("seed")).toBe("99");
  expect(disabled.searchParams.get("join")).toBe("ABCD");
});
