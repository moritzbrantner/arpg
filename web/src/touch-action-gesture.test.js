import { describe, expect, test } from "bun:test";

import { classifyActionButtonStroke, updateActionButtonStroke } from "./touch-action-gesture.js";

const stroke = (x, y, maxTravel = Math.hypot(x, y)) => ({
  startX: 50,
  startY: 50,
  endX: 50 + x,
  endY: 50 + y,
  maxTravel,
});

describe("action-button touch gesture", () => {
  test("a stationary tap or minor jitter is a primary action", () => {
    expect(classifyActionButtonStroke(stroke(0, 0))).toBe("tap");
    expect(classifyActionButtonStroke(stroke(7, -9))).toBe("tap");
  });

  test("deliberate swipes have one cardinal direction", () => {
    expect(classifyActionButtonStroke(stroke(0, -48))).toBe("up");
    expect(classifyActionButtonStroke(stroke(0, 48))).toBe("down");
    expect(classifyActionButtonStroke(stroke(48, 0))).toBe("right");
    expect(classifyActionButtonStroke(stroke(-48, 0))).toBe("left");
    expect(classifyActionButtonStroke(stroke(10, -45))).toBe("up");
  });

  test("ambiguous drags, diagonals, and out-and-back strokes dispatch nothing", () => {
    expect(classifyActionButtonStroke(stroke(20, 0))).toBeNull();
    expect(classifyActionButtonStroke(stroke(40, 40))).toBeNull();
    expect(classifyActionButtonStroke(stroke(0, 0, 55))).toBeNull();
    expect(classifyActionButtonStroke(stroke(10, 10, 40))).toBeNull();
  });
});

test("coalesced out-and-back samples cannot become a tap", () => {
  const pending = stroke(0, 0);
  updateActionButtonStroke(pending, [
    { clientX: 50, clientY: 2 },
    { clientX: 50, clientY: -12 },
    { clientX: 50, clientY: 50 },
  ]);
  expect(pending.maxTravel).toBe(62);
  expect(classifyActionButtonStroke(pending)).toBeNull();
});
