// Iterates every games/<name>/vite.config.ts (skipping folders that start with
// "_", which are templates / scaffolds) and runs `vite build` for each.
//
// Special case: `_launcher` IS built — last, after the games. Its Vite config
// writes directly to dist/public-games/ (with emptyOutDir:false), serving as
// the index of /games/. We build it last so leftover launcher artifacts from
// a previous run get overwritten in place while game subfolders are preserved.
//
// Usage:
//   `npm run build:games`              — build all games + launcher
//   `npm run build:games -- <name>`    — build just one target (game or `_launcher`)

import { spawnSync } from "node:child_process";
import { readdirSync, statSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const GAMES_DIR = join(ROOT, "games");

const LAUNCHER = "_launcher";

function gameFolders(): string[] {
  return readdirSync(GAMES_DIR)
    .filter(name => !name.startsWith("_") && !name.startsWith("."))
    .filter(name => statSync(join(GAMES_DIR, name)).isDirectory())
    .filter(name => existsSync(join(GAMES_DIR, name, "vite.config.ts")));
}

const onlyTarget = process.argv[2];

const games = gameFolders();
const launcherExists = existsSync(join(GAMES_DIR, LAUNCHER, "vite.config.ts"));
const allTargets = launcherExists ? [...games, LAUNCHER] : games;

let buildOrder: string[];
if (onlyTarget) {
  if (!existsSync(join(GAMES_DIR, onlyTarget, "vite.config.ts"))) {
    console.error(`No vite.config.ts found at games/${onlyTarget}/. Available: ${allTargets.join(", ")}`);
    process.exit(1);
  }
  buildOrder = onlyTarget === LAUNCHER || !launcherExists
    ? [onlyTarget]
    : [onlyTarget, LAUNCHER];
} else {
  buildOrder = allTargets;
}

if (buildOrder.length === 0) {
  console.log("No games to build (games/ contained no buildable folders).");
  process.exit(0);
}

console.log(`Building ${buildOrder.length} target(s): ${buildOrder.join(", ")}`);

for (const name of buildOrder) {
  const config = join("games", name, "vite.config.ts");
  console.log(`\n── ${name} ──`);
  const result = spawnSync(
    "npx",
    ["vite", "build", "--config", config],
    {
      cwd: ROOT,
      stdio: "inherit",
      shell: true,
      env: { ...process.env, NODE_ENV: "production" },
    },
  );
  if (result.status !== 0) {
    console.error(`Build failed for "${name}".`);
    process.exit(result.status ?? 1);
  }
}

console.log("\nAll games built successfully.");
