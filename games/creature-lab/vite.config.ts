import { defineConfig } from "vite";
import path from "path";

const GAME_NAME = "creature-lab";

// The creature lab — a standalone tool for editing the world-engine creature
// models (blueprint / skeleton / gait / animation), migrated out of
// seagull-dream so the models it drives are the shared canonical ones. Pure
// three.js + vanilla TS (no React). Served at /games/creature-lab.
export default defineConfig({
  resolve: {
    alias: {
      "@shared": path.resolve(__dirname, "..", "..", "shared"),
    },
  },
  root: __dirname,
  base: process.env.NODE_ENV === "production" ? `/games/${GAME_NAME}/` : "/",
  build: {
    outDir: path.resolve(__dirname, "..", "..", "dist", "public-games", GAME_NAME),
    emptyOutDir: true,
  },
  server: {
    port: 5190,
    host: "0.0.0.0",
  },
});
