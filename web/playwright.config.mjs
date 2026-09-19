import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: "http://127.0.0.1:4173/arpg/",
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
