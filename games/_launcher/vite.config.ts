// Launcher Vite config. The launcher serves /games/ itself, so its build
// output lands DIRECTLY in dist/public-games/ (not a subfolder). emptyOutDir
// is false so this build doesn't wipe the game subfolders that already built.
//
// Note: scripts/build-games.ts builds individual games first, then runs this
// last, so any leftover launcher artifacts from a previous run are still
// overwritten in place — only the game subfolders are preserved.

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  root: __dirname,
  base: process.env.NODE_ENV === "production" ? "/games/" : "/",
  build: {
    outDir: path.resolve(__dirname, "..", "..", "dist", "public-games"),
    emptyOutDir: false,
    assetsDir: "_launcher_assets",
  },
  server: {
    port: 5179,
    host: "0.0.0.0",
  },
});
