import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import { existsSync } from "fs";

const GAME_NAME = "dollhouse";

// This game builds against its VENDORED engine snapshot (games/dollhouse/engine),
// not live shared/world-engine — refresh it explicitly with
// `npm run sync:game-engine -- dollhouse`. The snapshot also carries the
// engine's shared-root deps (glyph compositor/registry, emoji/numeral, prng) so
// the lexicon the game parses with is the one it shipped with.
const ENGINE = path.resolve(__dirname, "engine");
if (!existsSync(ENGINE)) {
  throw new Error(
    "games/dollhouse/engine missing — run `npm run sync:game-engine -- dollhouse` first.",
  );
}

const snapshotRootDep = (name: string) =>
  [`@shared/${name}.js`, `@shared/${name}`].map((find) => ({
    find,
    replacement: path.resolve(ENGINE, `${name}.ts`),
  }));

export default defineConfig({
  // React is used only for the response-board island (the real client-shared
  // BoardButtonVisual) — the rest of the game is vanilla TS, like world-lab.
  plugins: [react()],
  resolve: {
    alias: [
      { find: "@shared/world-engine", replacement: path.resolve(ENGINE, "world-engine") },
      {
        find: "@shared/glyph-compositor.tsx",
        replacement: path.resolve(ENGINE, "glyph-compositor.tsx"),
      },
      ...snapshotRootDep("glyph-compositor"),
      ...snapshotRootDep("glyph-registry"),
      ...snapshotRootDep("emoji-registry"),
      ...snapshotRootDep("numeral-glyph"),
      ...snapshotRootDep("prng"),
      // Everything else (games-bridge, button-shape, board visuals…) tracks the
      // live platform — visual/protocol parity matters more than freezing it.
      { find: "@shared", replacement: path.resolve(__dirname, "..", "..", "shared") },
      {
        find: "@client-shared",
        replacement: path.resolve(__dirname, "..", "..", "client-shared", "src"),
      },
    ],
  },
  root: __dirname,
  base: process.env.NODE_ENV === "production" ? `/games/${GAME_NAME}/` : "/",
  build: {
    outDir: path.resolve(__dirname, "..", "..", "dist", "public-games", GAME_NAME),
    emptyOutDir: true,
  },
  server: {
    port: 5191,
    host: "0.0.0.0",
  },
});
