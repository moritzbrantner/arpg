import { expect, test } from "./fixtures.js";

// Workbench scenarios run the real WASM authority; these specs drive them through the
// normal controls and read authoritative evidence from the training panel.
async function openScenario(page, appUrl, fixture) {
  await page.goto(`${appUrl}?scenario=training&seed=42&fixture=${fixture}`);
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await page.evaluate(() => document.activeElement?.blur());
  const step = page.getByRole("button", { name: "Step", exact: true });
  const timeline = page.getByRole("region", { name: "Event timeline" });
  const diagnostics = page.locator(".training-diagnostics");
  const steps = async (count) => {
    for (let tick = 0; tick < count; tick += 1) await step.click();
  };
  const stepUntil = async (locator, text, limit = 60) => {
    for (let tick = 0; tick < limit; tick += 1) {
      if ((await locator.textContent()).includes(text)) return;
      await step.click();
    }
    throw new Error(`never saw ${text}`);
  };
  const press = async (key) => {
    await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.press(key);
  };
  return { timeline, diagnostics, steps, stepUntil, press };
}

test("an unknown scenario falls back to the generated dungeon", async ({ page, appUrl }) => {
  await page.goto(`${appUrl}?scenario=training&seed=42&fixture=lava`);
  await expect(
    page.getByText('Unknown scenario "lava"; using the generated dungeon'),
  ).toBeVisible();
  await expect(page.getByLabel("Scenario")).toHaveValue("dungeon");
});

test("melee scenarios show a forward hit, an aimed-away whiff, a blocked strike and an outrun one", async ({
  page,
  appUrl,
}) => {
  const dummy = await openScenario(page, appUrl, "dummy");
  await dummy.press("Space");
  await dummy.stepUntil(dummy.timeline, "sword.lightSwing · player 1 → monster 1 · hit 25");

  const whiff = await openScenario(page, appUrl, "dummy");
  await page.keyboard.down("a");
  await whiff.steps(1);
  await page.keyboard.up("a");
  await whiff.press("Space");
  await whiff.stepUntil(whiff.diagnostics, "primaryAttack · recovery");
  await expect(whiff.timeline).toContainText("No events yet");

  const blocked = await openScenario(page, appUrl, "obstructed");
  await blocked.press("Space");
  await blocked.stepUntil(blocked.timeline, "obstructed");
  await expect(blocked.timeline).not.toContainText("hit");

  // The archer starts inside the swing but backs out of reach during the wind-up.
  const retreat = await openScenario(page, appUrl, "retreating");
  await retreat.press("Space");
  await retreat.stepUntil(retreat.diagnostics, "primaryAttack · recovery");
  await expect(retreat.diagnostics).toContainText("Retreating1");
  await expect(retreat.timeline).toContainText("No events yet");
});

test("a block opens a counter window that expires", async ({ page, appUrl }) => {
  const arena = await openScenario(page, appUrl, "enemy");
  await page.keyboard.down("f");
  await arena.stepUntil(arena.timeline, "monster.claw · monster 1 → player 1 · blocked");
  await page.keyboard.up("f");
  await arena.press("Space");
  await arena.steps(1);
  await expect(arena.diagnostics).toContainText("counter · windup");
  // The counter continues into the declared combo follow-up (recovery tick 2 of 10).
  await arena.stepUntil(arena.diagnostics, "counter · recovery · 8t");
  await arena.press("Space");
  await arena.steps(1);
  await expect(arena.diagnostics).toContainText("lightFollowUp · windup");

  const late = await openScenario(page, appUrl, "enemy");
  await page.keyboard.down("f");
  await late.stepUntil(late.timeline, "blocked");
  await page.keyboard.up("f");
  await late.steps(31);
  await late.press("Space");
  await late.steps(1);
  await expect(late.diagnostics).toContainText("primaryAttack · windup");
});

test("archery scenarios show an arrow hit and an arrow stopped by a pillar", async ({
  page,
  appUrl,
}) => {
  for (const [fixture, hits] of [
    ["archery", true],
    ["archeryObstructed", false],
  ]) {
    const range = await openScenario(page, appUrl, fixture);
    await range.press("x");
    await range.steps(1);
    await page.keyboard.down("Space");
    await range.steps(32);
    await page.keyboard.up("Space");
    await range.stepUntil(range.diagnostics, "Arrows1");
    await range.stepUntil(range.diagnostics, "Arrows0");
    if (hits) await expect(range.timeline).toContainText("bow.arrow · player 1 → monster 1 · hit");
    else await expect(range.timeline).toContainText("No events yet");
  }
});

test("role scenarios show a ranged shot in flight and a heavy telegraphed slam", async ({
  page,
  appUrl,
}) => {
  const ranged = await openScenario(page, appUrl, "ranged");
  await ranged.stepUntil(ranged.diagnostics, "Arrows1", 80);
  await ranged.stepUntil(ranged.timeline, "monster.bolt · monster 2 → player 1 · hit 8", 80);

  const heavy = await openScenario(page, appUrl, "heavy");
  // The slam lands only after its 45-tick wind-up.
  await heavy.stepUntil(heavy.timeline, "monster.slam · monster 4 → player 1 · hit 28", 80);
  await expect(heavy.timeline).toContainText(/tick (4[5-9]|[5-9]\d) · monster\.slam/);
});

test("a defeated dummy drops gold that the authority prompts for and pays once", async ({
  page,
  appUrl,
}) => {
  const arena = await openScenario(page, appUrl, "dummy");
  for (let swing = 0; swing < 4; swing += 1) {
    await arena.press("Space");
    await arena.steps(1);
    await arena.stepUntil(arena.diagnostics, "Player actionidle");
  }
  await expect(arena.timeline).toContainText("defeated");
  // Walk towards the drop until the authority offers it.
  const hud = page.getByRole("region", { name: "Player status" });
  await page.keyboard.down("d");
  await arena.stepUntil(hud, "E · Pick up gold");
  await page.keyboard.up("d");
  await arena.steps(2);
  await arena.press("e");
  await arena.stepUntil(arena.timeline, "picked up loot");
  await expect(hud).toContainText("Gold 10");
  await arena.stepUntil(arena.diagnostics, "Player actionidle");
  await arena.press("e");
  await arena.stepUntil(arena.timeline, "interact refused · nothingInRange");
});
