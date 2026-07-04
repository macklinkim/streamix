import { defineConfig, devices } from "@playwright/test";

// The single required happy-path E2E (§1.3, Phase 4 DoD). The full stack + a
// seeded live channel are started externally (see e2e/README); this config just
// drives the browser against http://localhost:3000.
export default defineConfig({
  testDir: "./e2e",
  timeout: 45_000,
  fullyParallel: false,
  retries: 0,
  reporter: "list",
  use: {
    baseURL: "http://localhost:3000",
    ...devices["Desktop Chrome"],
    trace: "off",
  },
});
