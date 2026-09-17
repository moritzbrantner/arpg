import { describe, expect, test } from "bun:test";

import {
  VIRTUAL_STICK_TRAVEL_RATIO,
  sampleVirtualStick,
} from "./virtual-stick.js";

const rect = { left: 100, top: 50, width: 200, height: 200 };
const center = { x: 200, y: 150 };

describe("sampleVirtualStick", () => {
  test("keeps the centered stick neutral", () => {
    expect(sampleVirtualStick(center.x, center.y, rect)).toEqual({
      x: 0,
      z: 0,
      visualX: 0,
      visualY: 0,
    });
  });

  test("maps screen directions to authoritative movement axes", () => {
    expect(sampleVirtualStick(center.x + 80, center.y, rect)).toMatchObject({ x: 1, z: 0 });
    expect(sampleVirtualStick(center.x - 80, center.y, rect)).toMatchObject({ x: -1, z: 0 });
    expect(sampleVirtualStick(center.x, center.y - 80, rect)).toMatchObject({ x: 0, z: -1 });
    expect(sampleVirtualStick(center.x, center.y + 80, rect)).toMatchObject({ x: 0, z: 1 });
  });

  test("supports diagonal movement while preserving a center dead zone", () => {
    expect(sampleVirtualStick(center.x + 10, center.y - 10, rect)).toMatchObject({ x: 0, z: 0 });
    expect(sampleVirtualStick(center.x + 80, center.y - 80, rect)).toMatchObject({ x: 1, z: -1 });
  });

  test("clamps knob travel inside the visual base", () => {
    const sample = sampleVirtualStick(center.x + 1000, center.y + 1000, rect);
    const maxTravel = (rect.width / 2) * VIRTUAL_STICK_TRAVEL_RATIO;
    expect(Math.hypot(sample.visualX, sample.visualY)).toBeCloseTo(maxTravel, 8);
    expect(sample).toMatchObject({ x: 1, z: 1 });
  });
});
