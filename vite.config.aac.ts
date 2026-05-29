import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "client-aac", "src"),
      "@shared": path.resolve(import.meta.dirname, "shared"),
      "@client-shared": path.resolve(import.meta.dirname, "client-shared", "src"),
      "@assets": path.resolve(import.meta.dirname, "attached_assets"),
    },
  },
  root: path.resolve(import.meta.dirname, "client-aac"),
  // Electron build uses relative paths; web production uses /aac/; dev uses /
  base: process.env.ELECTRON_BUILD === "1" ? "./" : process.env.NODE_ENV === "production" ? "/aac/" : "/",
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/public-aac"),
    emptyOutDir: true,
  },
  server: {
    port: 5174,
    host: "0.0.0.0",
    // Standalone vite dev mode for the AAC client (`npm run client-aac:dev`)
    // runs on its own port — proxy backend traffic to the Express server so
    // /ws/* upgrades and /api/* requests actually reach the running server.
    // Without this, /ws/social-bot (and /ws/live) just hang in CONNECTING
    // because vite doesn't know what to do with them.
    proxy: {
      "/ws":   { target: "ws://localhost:5000", ws: true, changeOrigin: true },
      "/api":  { target: "http://localhost:5000", changeOrigin: true },
      "/auth": { target: "http://localhost:5000", changeOrigin: true },
    },
  },
});
