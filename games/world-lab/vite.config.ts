import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

const GAME_NAME = "world-lab";

export default defineConfig({
  // React is used only for the response-board island (the real client-shared
  // BoardButtonVisual) — the rest of the lab is vanilla TS.
  plugins: [react()],
  resolve: {
    alias: {
      "@shared": path.resolve(__dirname, "..", "..", "shared"),
      "@client-shared": path.resolve(__dirname, "..", "..", "client-shared", "src"),
    },
  },
  root: __dirname,
  base: process.env.NODE_ENV === "production" ? `/games/${GAME_NAME}/` : "/",
  build: {
    outDir: path.resolve(__dirname, "..", "..", "dist", "public-games", GAME_NAME),
    emptyOutDir: true,
  },
  server: {
    port: 5189,
    host: "0.0.0.0",
  },
});
