/**
 * Vitest config for world-lab's headless suites (nations P0: the civ-tier
 * boot). Mirrors grand-dream's vitest setup — real PopuSim + cell-systems
 * engines, node environment, same aliases as vite.config.ts.
 *
 * Run from repo root: `npm run test:world-lab`
 */

import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  resolve: {
    alias: {
      "@shared": path.resolve(__dirname, "..", "..", "shared"),
      "@client-shared": path.resolve(__dirname, "..", "..", "client-shared", "src"),
      "@popusim": path.resolve(__dirname, "..", "popusim", "src"),
    },
  },
  test: {
    environment: "node",
    include: ["src/__tests__/**/*.test.ts"],
    testTimeout: 60000,
  },
});
