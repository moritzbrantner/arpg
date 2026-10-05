import { expect, test } from "bun:test";
import { createActiveCueTracker } from "./frame-cues.js";

const snapshot = (playerPhase, monsterPhase) => ({
  tick: 1,
  players: [{ id: 1, action: playerPhase && { kind: "primaryAttack", phase: playerPhase } }],
  monsters: [{ id: 7, action: monsterPhase && { phase: monsterPhase, targetPlayerId: 1 } }],
});

test("an active phase coalesced away before a draw is still drawn once", () => {
  const tracker = createActiveCueTracker();
  const active = snapshot("active", "active");
  const recovery = snapshot("recovery", "recovery");
  tracker.observe(active);
  tracker.observe(recovery);
  const frame = tracker.take(recovery);
  expect(frame.players[0].action.phase).toBe("active");
  expect(frame.monsters[0].action.phase).toBe("active");
  expect(recovery.players[0].action.phase).toBe("recovery");

  tracker.observe(recovery);
  expect(tracker.take(recovery)).toBe(recovery);
});

test("entities whose action ended or that never acted are drawn as they are", () => {
  const tracker = createActiveCueTracker();
  tracker.observe(snapshot("active", null));
  const idle = snapshot(null, "windup");
  const frame = tracker.take(idle);
  expect(frame.players[0].action.phase).toBe("active");
  expect(frame.monsters[0].action.phase).toBe("windup");
});
