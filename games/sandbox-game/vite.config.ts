import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

const GAME_NAME = "sandbox-game";

export default defineConfig({
  plugins: [react()],
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
    port: 5182,
    host: "0.0.0.0",
  },
});
