import { defineConfig } from "vite";
import path from "path";

const GAME_NAME = "seagull-dream";

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
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, "index.html"),
        // Creature lab — dev/debug page for the creature generator
        // (instructions/creatures.md). Served at /lab.html.
        lab: path.resolve(__dirname, "lab.html"),
        // Cloud lab — scenario viewer for the cloud/weather system
        // (instructions/clouds.md). Served at /cloud-lab.html.
        cloudlab: path.resolve(__dirname, "cloud-lab.html"),
      },
    },
  },
  server: {
    port: 5184,
    host: "0.0.0.0",
  },
});
