import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createSocket } from "node:dgram";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { expect, test } from "./fixtures.js";

// Real dedicated-authority acceptance: the native arpg-game-server binary and Chromium's
// WebTransport stack. Build the server first with
// `cargo build --locked -p arpg-game-server --bin server` (ARPG_E2E_SERVER_BIN overrides it).
const repositoryRoot = resolve(import.meta.dirname, "../../..");
const serverBinary =
  process.env.ARPG_E2E_SERVER_BIN ??
  resolve(process.env.CARGO_TARGET_DIR ?? resolve(repositoryRoot, "target"), "debug/server");

function delay(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

// WebTransport runs over QUIC, so reserve a free UDP port for the server.
async function freeUdpPort() {
  const socket = createSocket("udp4");
  await new Promise((resolveBind) => socket.bind(0, "127.0.0.1", resolveBind));
  const { port } = socket.address();
  await new Promise((resolveClose) => socket.close(resolveClose));
  return port;
}

// Browsers accept serverCertificateHashes only for short-lived ECDSA certificates.
function createCertificate() {
  const directory = mkdtempSync(join(tmpdir(), "arpg-webtransport-"));
  const certificatePem = join(directory, "cert.pem");
  const privateKeyPem = join(directory, "key.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:P-256",
      "-nodes",
      "-keyout",
      privateKeyPem,
      "-out",
      certificatePem,
      "-days",
      "10",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  const certificateDer = execFileSync("openssl", [
    "x509",
    "-in",
    certificatePem,
    "-outform",
    "DER",
  ]);
  return {
    directory,
    certificatePem,
    privateKeyPem,
    hashBytes: [...createHash("sha256").update(certificateDer).digest()],
  };
}

async function installCertificatePin(page, hashBytes) {
  await page.addInitScript((pinned) => {
    const NativeWebTransport = globalThis.WebTransport;
    if (!NativeWebTransport) return;
    // Chromium's offline emulation does not reach QUIC, so the test simulates an outage at
    // the transport boundary: `__arpgOutage.begin()` drops the live transport and points new
    // attempts at an unreachable endpoint until `end()`.
    const live = new Set();
    let outage = false;
    globalThis.__arpgOutage = {
      begin() {
        outage = true;
        for (const transport of live) transport.close({ closeCode: 1, reason: "simulated outage" });
      },
      end() {
        outage = false;
      },
    };
    function PinnedWebTransport(url, options = {}) {
      const target = outage ? String(url).replace(/:\d+\//, ":9/") : url;
      const transport = new NativeWebTransport(target, {
        ...options,
        serverCertificateHashes: [{ algorithm: "sha-256", value: new Uint8Array(pinned) }],
      });
      live.add(transport);
      transport.closed.finally(() => live.delete(transport)).catch(() => {});
      return transport;
    }
    PinnedWebTransport.prototype = NativeWebTransport.prototype;
    Object.setPrototypeOf(PinnedWebTransport, NativeWebTransport);
    Object.defineProperty(globalThis, "WebTransport", {
      configurable: true,
      writable: true,
      value: PinnedWebTransport,
    });
  }, hashBytes);
}

async function startDedicatedServer(certificate, port) {
  const child = spawn(serverBinary, [], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      ARPG_RUN_SEED: "42",
      ARPG_SERVER_PORT: String(port),
      ARPG_SERVER_CERT_PEM: certificate.certificatePem,
      ARPG_SERVER_KEY_PEM: certificate.privateKeyPem,
      ARPG_SERVER_SESSION_PATH: "/arpg",
      ARPG_SERVER_DRAIN_GRACE_MS: "20",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  const deadline = Date.now() + 10_000;
  while (!stderr.includes("event=arpg_server_start run_seed=42")) {
    if (child.exitCode !== null) {
      throw new Error(`Dedicated server exited (code=${child.exitCode}). stderr:\n${stderr}`);
    }
    if (Date.now() > deadline) throw new Error(`Dedicated server did not start:\n${stderr}`);
    await delay(25);
  }
  // The start event precedes binding the QUIC endpoint.
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

test("browser WebTransport resumes the dedicated authority after an outage", async ({
  page,
  appUrl,
}) => {
  expect(
    existsSync(serverBinary),
    `build the dedicated server first: cargo build --locked -p arpg-game-server --bin server (looked for ${serverBinary})`,
  ).toBe(true);
  const certificate = createCertificate();
  const port = await freeUdpPort();
  await installCertificatePin(page, certificate.hashBytes);
  const server = await startDedicatedServer(certificate, port);
  try {
    await page.goto(appUrl);
    await page.getByRole("button", { name: "Enter World", exact: true }).click();
    const status = page.getByRole("region", { name: "Player status" }).locator("p").first();

    await page.getByRole("button", { name: "Settings", exact: true }).click();
    let settings = page.getByRole("dialog", { name: "Settings", exact: true });
    await settings.getByLabel("WebTransport endpoint").fill(`https://localhost:${port}/arpg`);
    await settings.getByRole("button", { name: "Connect dedicated server", exact: true }).click();
    await expect(status).toContainText("Dedicated authority · player 1 · 60 Hz", {
      timeout: 30_000,
    });
    await expect(settings).toContainText("Current mode: dedicated · player 1 · run seed 42");
    await settings.getByRole("button", { name: "Close", exact: true }).click();
    await expect(settings).not.toBeVisible();

    await page.evaluate(() => globalThis.__arpgOutage.begin());
    await expect(status).toHaveText("Connecting to dedicated authority…", { timeout: 15_000 });
    await page.evaluate(() => globalThis.__arpgOutage.end());
    await expect(status).toContainText("Dedicated authority · player 1 · 60 Hz", {
      timeout: 30_000,
    });

    await page.getByRole("button", { name: "Settings", exact: true }).click();
    settings = page.getByRole("dialog", { name: "Settings", exact: true });
    await expect(settings).toContainText("Current mode: dedicated · player 1 · run seed 42");
  } finally {
    await stopDedicatedServer(server);
    rmSync(certificate.directory, { recursive: true, force: true });
  }
});

// Reconnect mid-guard (#92): the resumed authority's guard follows the key the player
// actually holds. A key held through the outage keeps the shield raised (no phantom drop);
// a key released during the outage leaves it lowered after the resume (never stuck raised).
test("a dedicated resume keeps a held guard and lowers one released during the outage", async ({
  page,
  appUrl,
}) => {
  expect(
    existsSync(serverBinary),
    `build the dedicated server first: cargo build --locked -p arpg-game-server --bin server (looked for ${serverBinary})`,
  ).toBe(true);
  const certificate = createCertificate();
  const port = await freeUdpPort();
  await installCertificatePin(page, certificate.hashBytes);
  const server = await startDedicatedServer(certificate, port);
  try {
    await page.goto(appUrl);
    await page.getByRole("button", { name: "Enter World", exact: true }).click();
    const status = page.getByRole("region", { name: "Player status" }).locator("p").first();
    const guard = page.getByRole("button", { name: "Hold shield", exact: true });

    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const settings = page.getByRole("dialog", { name: "Settings", exact: true });
    await settings.getByLabel("WebTransport endpoint").fill(`https://localhost:${port}/arpg`);
    await settings.getByRole("button", { name: "Connect dedicated server", exact: true }).click();
    await expect(status).toContainText("Dedicated authority · player 1 · 60 Hz", {
      timeout: 30_000,
    });
    await settings.getByRole("button", { name: "Close", exact: true }).click();
    await expect(settings).not.toBeVisible();
    await page.evaluate(() => document.activeElement?.blur());

    // Held through the outage: the resumed authority still guards.
    await page.keyboard.down("f");
    await expect(guard).toHaveAttribute("data-guard", "raised");
    await page.evaluate(() => globalThis.__arpgOutage.begin());
    await expect(status).toHaveText("Connecting to dedicated authority…", { timeout: 15_000 });
    await page.evaluate(() => globalThis.__arpgOutage.end());
    await expect(status).toContainText("Dedicated authority · player 1 · 60 Hz", {
      timeout: 30_000,
    });
    // Snapshots from before the outage also read "raised": give the resumed authority
    // time to publish fresh ones, then require the guard to still be up.
    await page.waitForTimeout(500);
    await expect(guard).toHaveAttribute("data-guard", "raised");

    // Released during the outage: the resumed authority lowers the guard.
    await page.evaluate(() => globalThis.__arpgOutage.begin());
    await expect(status).toHaveText("Connecting to dedicated authority…", { timeout: 15_000 });
    await page.keyboard.up("f");
    await page.evaluate(() => globalThis.__arpgOutage.end());
    await expect(status).toContainText("Dedicated authority · player 1 · 60 Hz", {
      timeout: 30_000,
    });
    await expect(guard).not.toHaveAttribute("data-guard", /.+/);
  } finally {
    await stopDedicatedServer(server);
    rmSync(certificate.directory, { recursive: true, force: true });
  }
});
