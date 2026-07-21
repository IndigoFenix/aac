import { defineConfig } from "vite";
import path from "path";

const GAME_NAME = "grand-dream";

// The lab imports PopuSim engine source directly (../popusim/src). No React;
// plain TS + canvas. This is a developer testing harness for grand-dream
// step 1 (routes), not a packaged student game — it ships under /games for
// convenience but is not wired into the AAC host.
export default defineConfig({
  // REQUIRED: the PopuSim engine wires parent/world/system links by class
  // name (BWObj checks `this.constructor.name === 'World'`, and
  // PlayerAction/World.ts:1316 do the same for Site/World dispatch).
  // Default minification mangles class names, which silently leaves
  // `trait.world` null and crashes World.start (getCombos) in production
  // builds only. keepNames preserves `.name` through minification.
  esbuild: { keepNames: true },
  resolve: {
    alias: {
      "@shared": path.resolve(__dirname, "..", "..", "shared"),
      "@popusim": path.resolve(__dirname, "..", "popusim", "src"),
      "@cells": path.resolve(__dirname, "..", "..", "shared", "world-engine", "kernel", "cells"),
    },
  },
  root: __dirname,
  base: process.env.NODE_ENV === "production" ? `/games/${GAME_NAME}/` : "/",
  build: {
    outDir: path.resolve(__dirname, "..", "..", "dist", "public-games", GAME_NAME),
    emptyOutDir: true,
  },
  server: {
    port: 5183,
    host: "0.0.0.0",
  },
});
