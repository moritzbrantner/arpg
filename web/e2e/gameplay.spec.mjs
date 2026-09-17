import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { expect, test } from "@playwright/test";

const DEDICATED_PORT = 4443;
const DEDICATED_ENDPOINT = `https://localhost:${DEDICATED_PORT}/arpg`;

function delay(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function startDedicatedServer() {
  const binary =
    process.env.ARPG_E2E_SERVER_BIN ?? resolve(process.cwd(), "../target/debug/server");
  if (!existsSync(binary)) {
    throw new Error(`Dedicated acceptance server binary is missing: ${binary}`);
  }

  const child = spawn(binary, [], {
    cwd: resolve(process.cwd(), ".."),
    env: {
      ...process.env,
      ARPG_RUN_SEED: "42",
      ARPG_SERVER_PORT: String(DEDICATED_PORT),
      ARPG_SERVER_CERT_PEM: process.env.ARPG_E2E_CERT_PEM,
      ARPG_SERVER_KEY_PEM: process.env.ARPG_E2E_KEY_PEM,
      ARPG_SERVER_SESSION_PATH: "/arpg",
      ARPG_SERVER_DRAIN_GRACE_MS: "20",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  const ready = new Promise((resolveReady, rejectReady) => {
    const timeout = setTimeout(() => {
      rejectReady(new Error(`Dedicated server did not start. stderr:\n${stderr}`));
    }, 10_000);
    const poll = setInterval(() => {
      if (stderr.includes("ARPG run seed: 42")) {
        clearInterval(poll);
        clearTimeout(timeout);
        resolveReady();
      }
    }, 25);
    child.once("exit", (code, signal) => {
      clearInterval(poll);
      clearTimeout(timeout);
      rejectReady(
        new Error(
          `Dedicated server exited before readiness (code=${code}, signal=${signal}). stderr:\n${stderr}`,
        ),
      );
    });
  });

  await ready;
  await delay(250);
  return child;
}

async function stopDedicatedServer(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([once(child, "exit"), delay(5_000)]);
  if (child.exitCode === null) {
    child.kill("SIGKILL");
    await once(child, "exit");
  }
}

async function expectCanvasChanged(page, canvas, action, message) {
  const before = await canvas.screenshot();
  await action();
  await page.waitForTimeout(100);
  const after = await canvas.screenshot();
  expect(before.equals(after), message).toBe(false);
}

async function openSettings(page) {
  const settings = page.locator('[aria-label="Settings menu"]');
  await page.locator(".game-header").getByRole("button", { name: "Settings", exact: true }).click();
  await expect(settings).toBeVisible();
  return settings;
}

test.beforeEach(async ({ page }) => {
  page.on("pageerror", (error) => {
    console.error(`BROWSER PAGE ERROR: ${error.stack ?? error.message}`);
  });
  page.on("console", (message) => {
    if (message.type() === "error") console.error(`BROWSER CONSOLE ERROR: ${message.text()}`);
  });
});

test("built browser game composes Wasm authority, input, renderer, HUD, and settings", async ({
  page,
}) => {
  await page.goto("/?seed=42");

  const hud = page.locator('[aria-label="Player status"]');
  const status = hud.locator("p").first();
  const canvas = page.getByLabel("ARPG game world");

  await expect(status).toHaveText("Local Rust/Wasm authority");
  await expect(page.getByLabel("Character progression")).toContainText("Level 1");
  await expect(page.getByLabel("Character progression")).toContainText("Damage 25");

  await expectCanvasChanged(
    page,
    canvas,
    async () => {
      await page.keyboard.down("w");
      await page.waitForTimeout(500);
      await page.keyboard.up("w");
    },
    "moving the authoritative player should change the rendered world",
  );

  await page.keyboard.press("Space");
  await expect(status).not.toContainText(/failed|rejected|stopped|error/i);

  const settings = await openSettings(page);
  await expect(settings).toContainText("Current mode: local · player 1 · run seed 42");
  await settings.getByLabel("Pixel ratio limit").selectOption("1");
  await settings.getByRole("button", { name: "Close" }).click();
  await expect(settings).toBeHidden();
  await expect(status).toHaveText("Local Rust/Wasm authority");
});

test("mobile pointer controls move and attack through the same local authority", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?seed=42");

  const status = page.locator('[aria-label="Player status"] p').first();
  const canvas = page.getByLabel("ARPG game world");
  const joystick = page.getByLabel("Movement joystick");
  const attack = page.getByRole("button", { name: "Primary attack" });

  await expect(status).toHaveText("Local Rust/Wasm authority");
  await expect(joystick).toBeVisible();
  await expect(attack).toBeVisible();

  const box = await joystick.boundingBox();
  expect(box).not.toBeNull();
  const centerX = box.x + box.width / 2;
  const centerY = box.y + box.height / 2;
  const forwardY = box.y + box.height * 0.2;

  await expectCanvasChanged(
    page,
    canvas,
    async () => {
      await page.mouse.move(centerX, centerY);
      await page.mouse.down();
      await page.mouse.move(centerX, forwardY, { steps: 4 });
      await page.waitForTimeout(500);
      await page.mouse.up();
    },
    "pointer joystick movement should change the authoritative rendered world",
  );

  await attack.click();
  await expect(status).not.toContainText(/failed|rejected|stopped|error/i);
});

test("reusable keybinding editor persists and applies a changed movement binding", async ({ page }) => {
  await page.goto("/?seed=42");
  const canvas = page.getByLabel("ARPG game world");

  const settings = await openSettings(page);
  const moveForwardRow = settings.getByRole("row").filter({ hasText: "Move forward" });
  await moveForwardRow.getByRole("button", { name: "Edit" }).click();

  const recorder = settings.locator(".ib-recorder");
  await expect(recorder.getByRole("heading", { name: "Edit binding for Move forward" })).toBeVisible();
  await recorder.getByRole("button", { name: "Clear" }).click();
  await recorder.getByRole("button", { name: "Focus recorder" }).click();
  await page.keyboard.press("ArrowUp");
  await expect(recorder.getByRole("button", { name: "Save" })).toBeEnabled();
  await recorder.getByRole("button", { name: "Save" }).click();

  const profile = await page.evaluate(() => JSON.parse(localStorage.getItem("arpg-input-profile-v1")));
  expect(profile.patches.length).toBeGreaterThan(0);
  expect(JSON.stringify(profile)).toContain("ArrowUp");

  await settings.getByRole("button", { name: "Close" }).click();
  await expectCanvasChanged(
    page,
    canvas,
    async () => {
      await page.keyboard.down("ArrowUp");
      await page.waitForTimeout(500);
      await page.keyboard.up("ArrowUp");
    },
    "the newly rebound physical key should drive movement",
  );
});

test("real browser WebTransport resumes the dedicated ARPG authority after an outage", async ({
  context,
  page,
}) => {
  const server = await startDedicatedServer();
  try {
    await page.goto("/?seed=999");
    const hud = page.locator('[aria-label="Player status"]');
    const status = hud.locator("p").first();
    await expect(status).toHaveText("Local Rust/Wasm authority");

    let settings = await openSettings(page);
    await settings.getByLabel("WebTransport endpoint").fill(DEDICATED_ENDPOINT);
    await settings.getByRole("button", { name: "Connect dedicated server" }).click();
    await expect(status).toContainText("Dedicated authority · player 1 · 60 Hz", {
      timeout: 30_000,
    });
    await settings.getByRole("button", { name: "Close" }).click();
    await expect(settings).toBeHidden();

    await page.keyboard.down("w");
    await page.waitForTimeout(250);
    await page.keyboard.up("w");

    await context.setOffline(true);
    await expect(status).toHaveText("Connecting to dedicated authority…", {
      timeout: 15_000,
    });
    await context.setOffline(false);

    await expect(status).toContainText("Dedicated authority · player 1 · 60 Hz", {
      timeout: 30_000,
    });

    settings = await openSettings(page);
    await expect(settings).toContainText("Current mode: dedicated · player 1 · run seed 42");
  } finally {
    try {
      if (!page.isClosed()) await context.setOffline(false);
    } catch {
      // Preserve the real assertion failure if the browser has already torn down.
    }
    await stopDedicatedServer(server);
  }
});
