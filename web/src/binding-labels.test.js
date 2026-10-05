import { expect, test } from "bun:test";
import { keyLabelForAction } from "./binding-labels.js";

const binding = (id, action, value, modifiers = {}) => ({
  id,
  action,
  sequence: [{ key: { kind: "physical", value }, modifiers }],
});

test("labels follow the effective binding, not the default key", () => {
  expect(keyLabelForAction([binding("a", "game.interact", "KeyE")], "game.interact")).toBe("E");
  expect(keyLabelForAction([binding("a", "game.interact", "KeyR")], "game.interact")).toBe("R");
  expect(keyLabelForAction([binding("a", "game.interact", "Digit4")], "game.interact")).toBe("4");
  expect(
    keyLabelForAction([binding("a", "game.interact", "KeyE", { shift: true })], "game.interact"),
  ).toBe("Shift+E");
  expect(keyLabelForAction([binding("a", "game.primaryAttack", "Space")], "game.interact")).toBe(
    null,
  );
});
