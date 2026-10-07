import { expect, test } from "bun:test";
import {
  GRAPHICS_KEY,
  MOUSE_AIM_KEY,
  loadGraphics,
  loadMouseAim,
  loadProfile,
  persistStoredValue,
  readStoredValue,
} from "./preferences.js";

test("storage failure leaves the current session usable", () => {
  const blocked = {
    getItem() {
      throw new Error("blocked");
    },
    setItem() {
      throw new Error("blocked");
    },
  };
  expect(readStoredValue("endpoint", "fallback", blocked)).toBe("fallback");
  expect(persistStoredValue("endpoint", "new-value", blocked)).toBe(false);
  expect(loadProfile(() => true, blocked)).toEqual({ id: "arpg-player", patches: [] });
});

test("graphics accepts only supported settings and discards unrelated persisted fields", () => {
  const storage = (value) => ({
    getItem: (key) => (key === GRAPHICS_KEY ? JSON.stringify(value) : null),
  });
  for (const pixelRatioLimit of [-1, 0, 100, "2", null]) {
    expect(loadGraphics(storage({ shadows: false, pixelRatioLimit }))).toEqual({
      shadows: true,
      pixelRatioLimit: 2,
    });
  }
  expect(
    loadGraphics(storage({ shadows: false, pixelRatioLimit: 1.5, other: "untrusted" })),
  ).toEqual({ shadows: false, pixelRatioLimit: 1.5 });
});

test("profiles are admitted only when the foundation validates them", () => {
  const parsed = { id: "player", patches: [] };
  const storage = { getItem: () => JSON.stringify(parsed) };
  expect(loadProfile(() => false, storage)).toEqual({ id: "arpg-player", patches: [] });
  expect(loadProfile(() => true, storage)).toEqual(parsed);
});

test("mouse aim is opt-in and only an explicit setting enables it", () => {
  const storage = (value) => ({ getItem: (key) => (key === MOUSE_AIM_KEY ? value : null) });
  expect(loadMouseAim(storage(null))).toBe(false);
  expect(loadMouseAim(storage("yes"))).toBe(false);
  expect(loadMouseAim(storage("on"))).toBe(true);
  expect(
    loadMouseAim({
      getItem: () => {
        throw new Error("blocked");
      },
    }),
  ).toBe(false);
});
