import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  // The vision worker (src/workers/vision.worker.ts) dynamically imports MediaPipe,
  // so its bundle is code-split — which needs the ES module worker format (the
  // default "iife" can't code-split). Module workers are supported by the Electron
  // Chromium and all target browsers.
  worker: { format: "es" },
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
    // The games under /games/ are independent Vite projects served as pre-built
    // static assets; never let edits there trigger an HMR reload of the AAC
    // client. (Edits to shared/ still reload, since both consume it via @shared.)
    watch: {
      ignored: ["**/games/**", "**/dist/**"],
    },
    // Standalone vite dev mode for the AAC client (`npm run client-aac:dev`)
    // runs on its own port — proxy backend traffic to the Express server so
    // /ws/* upgrades and /api/* requests actually reach the running server.
    // Without this, /ws/social-bot (and /ws/live) just hang in CONNECTING
    // because vite doesn't know what to do with them.
    proxy: {
      "/ws":    { target: "ws://localhost:5000", ws: true, changeOrigin: true },
      "/api":   { target: "http://localhost:5000", changeOrigin: true },
      "/auth":  { target: "http://localhost:5000", changeOrigin: true },
      // Pre-built games are served by Express, not vite — without this every
      // embedded game iframe (bubbles, quest player, …) 404s in standalone dev.
      "/games": { target: "http://localhost:5000", changeOrigin: true },
    },
  },
});
