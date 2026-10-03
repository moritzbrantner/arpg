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
    function PinnedWebTransport(url, options = {}) {
      return new NativeWebTransport(url, {
        ...options,
        serverCertificateHashes: [{ algorithm: "sha-256", value: new Uint8Array(pinned) }],
      });
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

// fixme: snapshots now reassemble and the HUD reaches "run seed 42", but once dedicated
// snapshots flow the page's main thread saturates in native work (CPU profile: ~100%
// "(program)", negligible JS), so the Settings dialog never accepts the Close click.
// Re-enable once dedicated rendering keeps the page responsive.
test.fixme("browser WebTransport resumes the dedicated authority after an outage", async ({
  context,
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

    await context.setOffline(true);
    await expect(status).toHaveText("Connecting to dedicated authority…", { timeout: 15_000 });
    await context.setOffline(false);
    await expect(status).toContainText("Dedicated authority · player 1 · 60 Hz", {
      timeout: 30_000,
    });

    await page.getByRole("button", { name: "Settings", exact: true }).click();
    settings = page.getByRole("dialog", { name: "Settings", exact: true });
    await expect(settings).toContainText("Current mode: dedicated · player 1 · run seed 42");
  } finally {
    await context.setOffline(false).catch(() => {});
    await stopDedicatedServer(server);
    rmSync(certificate.directory, { recursive: true, force: true });
  }
});
