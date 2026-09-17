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

const publicKeyPem = execFileSync("openssl", ["x509", "-in", certificatePem, "-pubkey", "-noout"]);
const publicKeyDer = execFileSync("openssl", ["pkey", "-pubin", "-outform", "DER"], {
  input: publicKeyPem,
});
const spkiHash = createHash("sha256").update(publicKeyDer).digest("base64");

process.env.ARPG_E2E_CERT_PEM = certificatePem;
process.env.ARPG_E2E_KEY_PEM = privateKeyPem;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 180_000,
  expect: { timeout: 20_000 },
  use: {
    baseURL: "http://127.0.0.1:4173",
    headless: true,
    ignoreHTTPSErrors: true,
    launchOptions: {
      args: [
        `--ignore-certificate-errors-spki-list=${spkiHash}`,
        "--enable-unsafe-webgpu",
      ],
    },
  },
  webServer: {
    command: "bunx vite preview --host 127.0.0.1 --port 4173",
    port: 4173,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
