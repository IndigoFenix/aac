import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import { createRequire } from "module";

const pkg = createRequire(import.meta.url)("./package.json") as { version: string };

export default defineConfig({
  plugins: [react()],
  // Expose the app version to the client at build time so the web build can
  // show it too (the Electron build reads it live via electronAPI.getVersion()).
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
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
  // Native shells (Electron's app:// protocol, Capacitor's capacitor://
  // scheme) serve the bundle from a filesystem root, so asset URLs must be
  // RELATIVE — an absolute /aac/ base 404s under both. Web production is
  // served under /aac/; dev is served from /.
  //
  // NATIVE_BUILD is the general flag; ELECTRON_BUILD is still honoured so the
  // existing electron:build script and any local muscle memory keep working.
  base:
    process.env.NATIVE_BUILD === "1" || process.env.ELECTRON_BUILD === "1"
      ? "./"
      : process.env.NODE_ENV === "production"
        ? "/aac/"
        : "/",
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
