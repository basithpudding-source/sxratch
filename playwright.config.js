import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";

const repoRoot = fileURLToPath(new URL(".", import.meta.url));
const host = process.env.PLAYWRIGHT_HOST || "127.0.0.1";

function portFromEnv(name, fallback) {
  const value = Number.parseInt(process.env[name] || String(fallback), 10);
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`${name} must be a valid TCP port`);
  }
  return value;
}

const sourcePort = portFromEnv("PLAYWRIGHT_SOURCE_PORT", 5173);
const distPort = portFromEnv("PLAYWRIGHT_DIST_PORT", 5174);
const sourceURL = process.env.PLAYWRIGHT_SOURCE_URL || `http://${host}:${sourcePort}`;
const distURL = process.env.PLAYWRIGHT_DIST_URL || `http://${host}:${distPort}`;

export default defineConfig({
  testDir: "./test/e2e",
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? "dot" : "list",
  outputDir: process.env.PLAYWRIGHT_OUTPUT_DIR || join(tmpdir(), "sxratch-playwright-results"),
  use: {
    browserName: "chromium",
    headless: true,
    serviceWorkers: "block",
    storageState: { cookies: [], origins: [] },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "source",
      grep: /@source/,
      use: { baseURL: sourceURL },
    },
    {
      name: "dist",
      grep: /@dist/,
      use: { baseURL: distURL },
    },
  ],
  webServer: [
    {
      command: "node server.js",
      cwd: repoRoot,
      url: sourceURL,
      env: { HOST: host, PORT: String(sourcePort) },
      reuseExistingServer: !process.env.CI,
      timeout: 15_000,
    },
    {
      command: "node server.js --dist",
      cwd: repoRoot,
      url: distURL,
      env: { HOST: host, PORT: String(distPort) },
      reuseExistingServer: !process.env.CI,
      timeout: 15_000,
    },
  ],
});
