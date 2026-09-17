import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defineConfig } from "@playwright/test";

const certificateDirectory = mkdtempSync(join(tmpdir(), "arpg-webtransport-"));
const certificatePem = join(certificateDirectory, "cert.pem");
const privateKeyPem = join(certificateDirectory, "key.pem");

execFileSync("openssl", [
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
]);

const certificateDer = execFileSync("openssl", [
  "x509",
  "-in",
  certificatePem,
  "-outform",
  "DER",
]);
const certificateSha256 = createHash("sha256").update(certificateDer).digest("hex");

process.env.ARPG_E2E_CERT_PEM = certificatePem;
process.env.ARPG_E2E_KEY_PEM = privateKeyPem;
process.env.ARPG_E2E_CERT_SHA256 = certificateSha256;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 180_000,
  expect: { timeout: 20_000 },
  use: {
    baseURL: "http://127.0.0.1:4173",
    headless: true,
    launchOptions: {
      args: ["--enable-unsafe-webgpu"],
    },
  },
  webServer: {
    command: "bunx vite preview --host 127.0.0.1 --port 4173",
    port: 4173,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
