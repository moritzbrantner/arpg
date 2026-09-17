import { describe, expect, test } from "bun:test";

import {
  VIRTUAL_STICK_DEAD_ZONE,
  VIRTUAL_STICK_DIAGONAL_RATIO,
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

  test("requires deliberate travel before movement activates", () => {
    const maxTravel = (rect.width / 2) * VIRTUAL_STICK_TRAVEL_RATIO;
    const insideDeadZone = maxTravel * (VIRTUAL_STICK_DEAD_ZONE - 0.05);
    const outsideDeadZone = maxTravel * (VIRTUAL_STICK_DEAD_ZONE + 0.05);

    expect(sampleVirtualStick(center.x + insideDeadZone, center.y, rect)).toMatchObject({
      x: 0,
      z: 0,
    });
    expect(sampleVirtualStick(center.x + outsideDeadZone, center.y, rect)).toMatchObject({
      x: 1,
      z: 0,
    });
  });

  test("maps deliberate cardinal directions to authoritative movement axes", () => {
    expect(sampleVirtualStick(center.x + 80, center.y, rect)).toMatchObject({ x: 1, z: 0 });
    expect(sampleVirtualStick(center.x - 80, center.y, rect)).toMatchObject({ x: -1, z: 0 });
    expect(sampleVirtualStick(center.x, center.y - 80, rect)).toMatchObject({ x: 0, z: -1 });
    expect(sampleVirtualStick(center.x, center.y + 80, rect)).toMatchObject({ x: 0, z: 1 });
  });

  test("does not turn small off-axis thumb drift into a diagonal", () => {
    const maxTravel = (rect.width / 2) * VIRTUAL_STICK_TRAVEL_RATIO;
    const x = maxTravel * 0.9;
    const z = x * (VIRTUAL_STICK_DIAGONAL_RATIO - 0.08);
    expect(sampleVirtualStick(center.x + x, center.y - z, rect)).toMatchObject({ x: 1, z: 0 });
  });

  test("still supports deliberate diagonal movement", () => {
    expect(sampleVirtualStick(center.x + 80, center.y - 80, rect)).toMatchObject({ x: 1, z: -1 });
  });

  test("clamps knob travel inside the visual base", () => {
    const sample = sampleVirtualStick(center.x + 1000, center.y + 1000, rect);
    const maxTravel = (rect.width / 2) * VIRTUAL_STICK_TRAVEL_RATIO;
    expect(Math.hypot(sample.visualX, sample.visualY)).toBeCloseTo(maxTravel, 8);
    expect(sample).toMatchObject({ x: 1, z: 1 });
  });
});
