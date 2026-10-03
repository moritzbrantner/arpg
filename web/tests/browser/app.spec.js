import { expect, test } from "./fixtures.js";

test("combat buttons activate through the keyboard", async ({ page, appUrl }) => {
  await page.goto(`${appUrl}?scenario=training&seed=42`);
  await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  const attack = page.getByRole("button", { name: "Primary attack", exact: true });
  await attack.focus();
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "Step", exact: true }).click();
  await expect(attack).toHaveAttribute("data-phase", "windup");
});

test("settings own focus and restore the opener on dismissal", async ({ page, appUrl }) => {
  await page.goto(`${appUrl}?scenario=training&seed=42`);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  await expect(settings).toBeVisible();
  await expect(settings.getByRole("button", { name: "Close", exact: true })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(settings.getByRole("button", { name: "Close", exact: true })).not.toBeFocused();
  await page.keyboard.press("Tab");
  await expect(settings.getByRole("button", { name: "Close", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(settings).not.toBeVisible();
  await expect(page.getByRole("button", { name: "Settings", exact: true })).toBeFocused();
});

test("blocked storage does not break primary workflows", async ({ page, appUrl }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "localStorage", {
      get() {
        throw new DOMException("Blocked", "SecurityError");
      },
    });
  });
  await page.goto(appUrl);
  await page.getByRole("button", { name: "Enter World", exact: true }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByLabel("Enable shadows").uncheck();
  await expect(page.getByLabel("Enable shadows")).not.toBeChecked();
  await expect(page.getByRole("dialog", { name: "Settings", exact: true })).toBeVisible();
});

test("tick subscriptions update their view without rerendering the shell", async ({
  page,
  appUrl,
}) => {
  await page.goto(appUrl);
  const result = await page.evaluate(async () => {
    const { verifySnapshotUpdateDomain } = await import("/arpg/tests/browser/render-harness.jsx");
    const container = document.createElement("div");
    document.body.append(container);
    try {
      return verifySnapshotUpdateDomain(container);
    } finally {
      container.remove();
    }
  });
  expect(result).toEqual({ shellRenders: 1, text: "Tick 120" });
});

test("the browser projection accepts real WASM snapshots and rejects corrupt presentation data", async ({
  page,
  appUrl,
}) => {
  await page.goto(appUrl);
  const result = await page.evaluate(async () => {
    const wasm = await import("/arpg/src/wasm/arpg_web_wasm.js");
    const { decodeSnapshot } = await import("/arpg/src/wire-protocol.js");
    await wasm.default();
    const game = new wasm.WasmGame(42);
    try {
      game.addPlayer(1);
      const encoded = game.snapshotJson();
      const projected = decodeSnapshot(encoded);
      const corrupted = JSON.parse(encoded);
      corrupted.payload.players[0].position = [0, 0];
      let rejected = false;
      try {
        decodeSnapshot(JSON.stringify(corrupted));
      } catch {
        rejected = true;
      }
      return {
        matches: JSON.stringify(projected) === JSON.stringify(JSON.parse(encoded).payload),
        rejected,
      };
    } finally {
      game.free();
    }
  });
  expect(result).toEqual({ matches: true, rejected: true });
});

test("touch combat and settings remain usable on a phone viewport", async ({ browser, appUrl }) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });
  const page = await context.newPage();
  try {
    await page.goto(`${appUrl}?scenario=training&seed=42`);
    await page.getByRole("button", { name: "Pause", exact: true }).tap();
    const attack = page.getByRole("button", { name: "Primary attack", exact: true });
    await attack.tap();
    await page.getByRole("button", { name: "Step", exact: true }).tap();
    await expect(attack).toHaveAttribute("data-phase", "windup");
    await page.getByRole("button", { name: "Settings", exact: true }).tap();
    await expect(page.getByRole("dialog", { name: "Settings", exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  } finally {
    await context.close();
  }
});
