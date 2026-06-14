import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import runtimeErrorOverlay from "@replit/vite-plugin-runtime-error-modal";

export default defineConfig({
  plugins: [
    react(),
    runtimeErrorOverlay(),
    ...(process.env.NODE_ENV !== "production" &&
    process.env.REPL_ID !== undefined
      ? [
          await import("@replit/vite-plugin-cartographer").then((m) =>
            m.cartographer(),
          ),
        ]
      : []),
  ],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "client", "src"),
      "@shared": path.resolve(import.meta.dirname, "shared"),
      "@client-shared": path.resolve(import.meta.dirname, "client-shared", "src"),
      "@assets": path.resolve(import.meta.dirname, "attached_assets"),
    },
  },
  root: path.resolve(import.meta.dirname, "client"),
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/public"),
    emptyOutDir: true,
  },
  server: {
    host: "127.0.0.1",
    fs: {
      strict: true,
      deny: ["**/.*"],
    },
    // Standalone vite dev (`npm run client:dev`): the pre-built games under
    // /games/* are served by the Express server, not vite — proxy them so
    // embedded game iframes (quest-game preview) work in this mode too.
    // The main client itself reaches the backend via the absolute VITE_API_URL,
    // so these /api + /auth proxies don't affect its own calls (absolute URLs
    // bypass the proxy). They exist for Express-served pages reached THROUGH
    // the /games proxy — e.g. the games login page POSTs a relative /auth/login,
    // which would otherwise resolve to the vite origin (:5173) and 404.
    proxy: {
      "/api":   { target: "http://localhost:5000", changeOrigin: true },
      "/auth":  { target: "http://localhost:5000", changeOrigin: true },
      "/games": { target: "http://localhost:5000", changeOrigin: true },
    },
    watch: {
      // The games under /games/ are independent Vite projects (own dev servers)
      // and are served to this client as pre-built static assets from
      // dist/public-games. Never let edits there trigger an HMR reload of this
      // client, so both can be worked on simultaneously. (Edits to shared/ still
      // reload, since both consume it via @shared.)
      ignored: ["**/games/**", "**/dist/**"],
    },
  },
});
