/**
 * Vitest config for the grand-dream dual-layer suites (step 2: the shared
 * node graph). Boots real PopuSim + cell-systems engines headless, so it
 * reuses PopuSim's document shim and the same aliases as vite.config.ts.
 *
 * Run from repo root: `npm run test:grand-dream`
 */

import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  resolve: {
    alias: {
      "@shared": path.resolve(__dirname, "..", "..", "shared"),
      "@popusim": path.resolve(__dirname, "..", "popusim", "src"),
      "@cells": path.resolve(__dirname, "..", "..", "shared", "engine", "cells"),
    },
  },
  test: {
    environment: "node",
    setupFiles: [path.resolve(__dirname, "..", "popusim", "src", "sim", "documentShim.ts")],
    include: ["src/__tests__/**/*.test.ts"],
    testTimeout: 60000,
  },
});
