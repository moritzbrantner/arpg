import { expect, test } from "@playwright/test";

async function openSettings(page) {
  const settings = page.locator('[aria-label="Settings menu"]');
  await page
    .locator(".game-header")
    .getByRole("button", { name: "Settings", exact: true })
    .click();
  await expect(settings).toBeVisible();
  return settings;
}

async function editBinding(page, settings, actionName, key) {
  const row = settings.getByRole("row").filter({ hasText: actionName });
  await row.getByRole("button", { name: "Edit" }).click();

  const recorder = settings.locator(".ib-recorder");
  await expect(
    recorder.getByRole("heading", { name: `Edit binding for ${actionName}` }),
  ).toBeVisible();

  await recorder.getByRole("button", { name: "Clear" }).click();
  await recorder.getByRole("button", { name: "Focus recorder" }).click();
  await page.keyboard.press(key);
  await expect(recorder.getByRole("button", { name: "Save" })).toBeEnabled();
  await recorder.getByRole("button", { name: "Save" }).click();
}

async function savedProfile(page) {
  return page.evaluate(() => {
    const raw = localStorage.getItem("arpg-input-profile-v1");
    return raw ? JSON.parse(raw) : null;
  });
}

test.beforeEach(async ({ page }) => {
  page.on("pageerror", (error) => {
    console.error(`BROWSER PAGE ERROR: ${error.stack ?? error.message}`);
  });
});

test("changes and persists the movement hotkey", async ({ page }) => {
  await page.goto("?seed=42");
  await expect(page.locator('[aria-label="Player status"] p').first()).toHaveText(
    "Local Rust/Wasm authority",
  );

  let settings = await openSettings(page);
  await editBinding(page, settings, "Move forward", "ArrowUp");

  const profile = await savedProfile(page);
  expect(profile).not.toBeNull();
  expect(JSON.stringify(profile)).toContain("ArrowUp");

  await settings.getByRole("button", { name: "Close" }).click();
  await page.reload();
  await expect(page.locator('[aria-label="Player status"] p').first()).toHaveText(
    "Local Rust/Wasm authority",
  );

  settings = await openSettings(page);
  const moveForwardRow = settings.getByRole("row").filter({ hasText: "Move forward" });
  await expect(moveForwardRow).toContainText("[ArrowUp]");
  await settings.getByRole("button", { name: "Close" }).click();

  const canvas = page.getByLabel("ARPG game world");
  const before = await canvas.screenshot();
  await page.keyboard.down("ArrowUp");
  await page.waitForTimeout(500);
  await page.keyboard.up("ArrowUp");
  const after = await canvas.screenshot();

  expect(
    before.equals(after),
    "the persisted replacement movement hotkey should move the authoritative player",
  ).toBe(false);
});

test("replaces the primary-attack hotkey and disables the old binding", async ({ page }) => {
  await page.goto("?seed=42");
  const status = page.locator('[aria-label="Player status"] p').first();
  await expect(status).toHaveText("Local Rust/Wasm authority");

  let settings = await openSettings(page);
  await editBinding(page, settings, "Primary attack", "r");

  const profile = await savedProfile(page);
  expect(profile).not.toBeNull();
  expect(JSON.stringify(profile)).toContain("KeyR");

  await settings.getByRole("button", { name: "Close" }).click();
  await page.reload();
  await expect(status).toHaveText("Local Rust/Wasm authority");

  settings = await openSettings(page);
  const primaryRow = settings.getByRole("row").filter({ hasText: "Primary attack" });
  await expect(primaryRow).toContainText("[KeyR]");
  await settings.getByRole("button", { name: "Close" }).click();

  const actionStatus = page.locator(".action-status");

  await page.keyboard.press("Space");
  await page.waitForTimeout(150);
  await expect(actionStatus).toHaveCount(0);

  await page.keyboard.press("r");
  await expect(actionStatus).toContainText("Primary");
  await expect(status).not.toContainText(/failed|rejected|stopped|error/i);
});
