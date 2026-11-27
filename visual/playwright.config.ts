import { resolve } from "node:path";

import { defineConfig } from "@playwright/test";

import { project } from "./project.mjs";

// The visual sweep (sweep.spec.ts) against the app as project.json serves it, on a port of its own.
const port = 6590;

export default defineConfig({
  testDir: ".",
  testMatch: "sweep.spec.ts",
  fullyParallel: true,
  workers: Number(process.env.SWEEP_WORKERS ?? 4),
  reporter: "list",
  outputDir: "/tmp/sweep-results",
  use: { baseURL: `http://localhost:${port}` },
  webServer: {
    command: project.serve.replaceAll("{port}", String(port)),
    cwd: resolve(import.meta.dirname, ".."),
    url: `http://localhost:${port}`,
    reuseExistingServer: false,
    timeout: 300_000,
  },
});
