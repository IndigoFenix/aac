// Vendors a frozen copy of shared/world-engine (plus its few shared-root
// dependencies) into games/<game>/engine/, regenerates the game's spec
// JSON from the world-lab preset named in games/<game>/engine.sync.json,
// then builds the game from the fresh snapshot (build:games <game>).
//
// Usage: `npm run sync:game-engine -- <game>`   (e.g. dollhouse)
//
// Run EXPLICITLY only. This is deliberately not part of build:games — routine
// builds compile a shipped game from its last synced snapshot, so engine
// experiments in shared/world-engine (tested via the world-lab) can never
// change a live game unexpectedly. Re-sync when the engine state is one you
// want the game to ship. (The reverse coupling DOES hold: a sync always
// builds, since an unbuilt snapshot ships nothing — the iframes serve the
// pre-built bundles in dist/public-games/.)

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { execSync } from "node:child_process";

const ROOT = resolve(import.meta.dirname, "..");
const SHARED = join(ROOT, "shared");

// The engine's only imports outside shared/world-engine, verified by grep
// (`from "@shared/..."` inside shared/world-engine). If the engine gains a new
// @shared dependency, add it here — the game's vite aliases must cover it too.
const SHARED_ROOT_DEPS = [
  "prng.ts",
  "glyph-compositor.ts",
  "glyph-compositor.tsx",
  "glyph-registry.ts",
  "glyph-place-art.ts",
  "emoji-registry.ts",
  "numeral-glyph.ts",
];

interface EngineSyncManifest {
  /** world-lab preset id (games/world-lab/src/worlds.ts) the spec JSON is lowered from */
  worldId: string;
  /** where to write the lowered aivota-world document, relative to the game folder */
  specOut: string;
}

const game = process.argv[2];
if (!game) {
  console.error("Usage: npm run sync:game-engine -- <game>");
  process.exit(1);
}

const GAME_DIR = join(ROOT, "games", game);
const syncManifestPath = join(GAME_DIR, "engine.sync.json");
if (!existsSync(syncManifestPath)) {
  console.error(`games/${game}/engine.sync.json not found — this game doesn't take an engine snapshot.`);
  process.exit(1);
}
const syncManifest = JSON.parse(readFileSync(syncManifestPath, "utf8")) as EngineSyncManifest;

// ── 1. Snapshot the engine ──────────────────────────────────────────────────
const ENGINE_DIR = join(GAME_DIR, "engine");
rmSync(ENGINE_DIR, { recursive: true, force: true });
mkdirSync(ENGINE_DIR, { recursive: true });

const skip = (src: string) => src.endsWith(".bak") || src.endsWith(".test.ts");
cpSync(join(SHARED, "world-engine"), join(ENGINE_DIR, "world-engine"), {
  recursive: true,
  filter: (src) => !skip(src),
});
for (const f of SHARED_ROOT_DEPS) cpSync(join(SHARED, f), join(ENGINE_DIR, f));

// ── 2. Lower the game's world spec from the world-lab preset ────────────────
// THE SAME fold the world-lab's own "run" button uses — one function, because
// this used to be a hand-copied duplicate of it and a session field added to
// the form was silently dropped from every generated spec.
const { TEST_WORLDS } = await import("../games/world-lab/src/worlds.ts");
const { lowerTreeWorld } = await import("../games/world-lab/src/lower-world.ts");
const { parseGameSettings } = await import("../shared/world-engine/kernel/manifest.ts");

const preset = TEST_WORLDS.find((w: { id: string }) => w.id === syncManifest.worldId);
if (!preset) {
  console.error(`world id "${syncManifest.worldId}" not found in games/world-lab/src/worlds.ts`);
  process.exit(1);
}

type Dict = Record<string, unknown>;
const doc = lowerTreeWorld(preset.world) as Dict;

// Fail the sync, not the game boot, on a document the engine won't accept.
parseGameSettings(doc.game as Dict, "game");

const specPath = join(GAME_DIR, syncManifest.specOut);
mkdirSync(dirname(specPath), { recursive: true });
writeFileSync(specPath, JSON.stringify(doc, null, 2) + "\n");

// ── 3. Stamp the snapshot for traceability ──────────────────────────────────
let gitRev = "unknown";
try {
  gitRev = execSync("git rev-parse --short HEAD", { cwd: ROOT }).toString().trim();
} catch {
  // not fatal — a snapshot without a rev is still usable
}
writeFileSync(
  join(ENGINE_DIR, "SNAPSHOT.json"),
  JSON.stringify(
    { game, worldId: syncManifest.worldId, gitRev, syncedAt: new Date().toISOString() },
    null,
    2,
  ) + "\n",
);

console.log(
  `Synced engine snapshot for "${game}" (${gitRev}); wrote ${syncManifest.specOut} from preset "${syncManifest.worldId}".`,
);

// ── 4. Build the game from the fresh snapshot ───────────────────────────────
// A sync that isn't built ships nothing — the iframe serves dist/public-games/,
// so without this the game keeps running the previous bundle.
execSync(`npm run build:games -- ${game}`, { cwd: ROOT, stdio: "inherit" });
