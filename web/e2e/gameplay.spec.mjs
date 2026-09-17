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

  const beforeMovement = await canvas.screenshot();
  await page.keyboard.down("w");
  await page.waitForTimeout(500);
  await page.keyboard.up("w");
  await page.waitForTimeout(100);
  const afterMovement = await canvas.screenshot();
  expect(
    beforeMovement.equals(afterMovement),
    "moving the authoritative player should change the rendered world",
  ).toBe(false);

  await page.keyboard.press("Space");
  await expect(status).not.toContainText(/failed|rejected|stopped|error/i);

  await page.getByRole("button", { name: "Settings" }).click();
  const settings = page.locator('[aria-label="Settings menu"]');
  await expect(settings).toBeVisible();
  await expect(settings).toContainText("Current mode: local · player 1 · run seed 42");
  await settings.getByLabel("Pixel ratio limit").selectOption("1");
  await settings.getByRole("button", { name: "Close" }).click();
  await expect(settings).toBeHidden();
  await expect(status).toHaveText("Local Rust/Wasm authority");
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

    await page.getByRole("button", { name: "Settings" }).click();
    const settings = page.locator('[aria-label="Settings menu"]');
    await settings.getByLabel("WebTransport endpoint").fill(DEDICATED_ENDPOINT);
    await settings.getByRole("button", { name: "Connect dedicated server" }).click();
    await expect(status).toContainText("Dedicated authority · player 1 · 60 Hz", {
      timeout: 30_000,
    });

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

    await page.getByRole("button", { name: "Settings" }).click();
    await expect(settings).toContainText("Current mode: dedicated · player 1 · run seed 42");
  } finally {
    await context.setOffline(false);
    await stopDedicatedServer(server);
  }
});
