import { expect, test } from "bun:test";

import {
  DEFAULT_TRAINING_SEED,
  parseRunSeed,
  parseWorkbenchInteger,
  readTrainingRequest,
  spawnOperation,
  trainingTicksForFrame,
  tuningOperation,
  withTrainingRequest,
} from "./training-arena.js";

test("reads a deterministic training request from the URL", () => {
  expect(readTrainingRequest("?scenario=training&seed=42")).toEqual({
    requested: true,
    seed: 42,
    fixture: "dungeon",
    unknownFixture: null,
  });
  expect(readTrainingRequest("?scenario=training&seed=invalid&fixture=enemy")).toEqual({
    requested: true,
    seed: DEFAULT_TRAINING_SEED,
    fixture: "enemy",
    unknownFixture: null,
  });
  expect(readTrainingRequest("?seed=7&fixture=lava")).toEqual({
    requested: false,
    seed: 7,
    fixture: "dungeon",
    unknownFixture: "lava",
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

test("preserves fractional clock carry across paused frames", () => {
  let carry = 0;
  let ticks = 0;

  for (let frame = 0; frame < 3; frame += 1) {
    const next = trainingTicksForFrame(0.25, carry);
    ticks += next.ticks;
    carry = next.carry;
  }

  const carryWhilePaused = carry;

  for (let frame = 0; frame < 3; frame += 1) {
    const next = trainingTicksForFrame(0.25, carry);
    ticks += next.ticks;
    carry = next.carry;
  }

  expect(carryWhilePaused).toBe(0.75);
  expect(ticks).toBe(1);
  expect(carry).toBe(0.5);
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

test("writes the named scenario only when it is not the plain dungeon", () => {
  const archery = new URL(withTrainingRequest("https://example.test/game", true, 5, "archery"));
  expect(archery.searchParams.get("fixture")).toBe("archery");
  expect(readTrainingRequest(archery.search).fixture).toBe("archery");
  const plain = new URL(withTrainingRequest(archery.toString(), true, 5, "dungeon"));
  expect(plain.searchParams.has("fixture")).toBe(false);
  const left = new URL(withTrainingRequest(archery.toString(), false, 5));
  expect(left.searchParams.has("fixture")).toBe(false);
});

test("workbench inputs accept only exact whole numbers", () => {
  expect(parseWorkbenchInteger("40")).toBe(40);
  expect(parseWorkbenchInteger(" -250 ")).toBe(-250);
  for (const invalid of ["", "1.5", "1e3", "0x10", "abc", "99999999999999999999", null]) {
    expect(parseWorkbenchInteger(invalid)).toBeNull();
  }
  expect(spawnOperation("monster.brute", "100", "-40")).toEqual({
    operation: {
      type: "spawnMonster",
      definition: "monster.brute",
      offset: [100, -40],
    },
  });
  expect(spawnOperation("monster.brute", "1.5", "0").error).toMatch("whole numbers");
  expect(tuningOperation("guard.maxPoints", "30")).toEqual({
    operation: { type: "setTuning", parameter: "guard.maxPoints", value: 30 },
  });
  expect(tuningOperation("guard.maxPoints", "").error).toBe(
    "guard.maxPoints: enter a whole number",
  );
});
