import { resolve } from "node:path";

import { defineConfig } from "@playwright/test";

// The visual sweep (sweep.spec.ts) against the mock build, on a port of its own.
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
    command: `corepack pnpm build:mock && corepack pnpm exec vite preview --mode mock --outDir dist-mock --port ${port} --strictPort`,
    cwd: resolve(import.meta.dirname, ".."),
    url: `http://localhost:${port}`,
    reuseExistingServer: false,
    timeout: 300_000,
  },
});
