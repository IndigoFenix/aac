// scripts/world-text.ts
//
// WORLD-ENGINE TEXT MODE — the stdio driver (design: planning-docs/games/
// world-engine/text-mode.md, §8 step ⑤). Boots the REAL quest-host headless
// (bootTextQuest — no GL, no DOM, sim untouched) and exposes the tester
// protocol over stdin/stdout: tagged lines out, commands in, echoed as `> `
// lines so the transcript is its own replay script (`--script` reads them
// back).
//
//   npm run world:text                          interactive REPL, dollhouse
//   npm run world:text -- --seed 41 --json      seeded run + event sidecar
//   npm run world:text -- --script run.txt      replay a transcript
//
// Determinism law (§5): a transcript is a pure function of (build, seed,
// command list). Everything above the `# ────` fence is run metadata and
// excluded from diffs; below it, same build + seed + commands ⇒ byte-identical.

import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { execSync } from "node:child_process";
import { bootTextQuest } from "../shared/world-engine/headless/text-quest.ts";
import { createTextModeSession } from "../shared/world-engine/interaction/text/index.ts";
import type { BuilderNounEntry } from "../shared/world-engine/interaction/intent/builder-surface.ts";

interface CliArgs {
  world: string;
  seed: number | null;
  locale: string | null;
  grid: number;
  dt: number;
  transcript: string | null;
  script: string | null;
  json: boolean;
  cheats: boolean;
}

/** `--dt` accepts `1/60`-style fractions or decimals. The world-host clamps a
 *  step at 0.05 s, so 1/20 is the largest lossless value — roughly 3× the sim
 *  per wall-second of a 1/60 run (the sim, not this layer, is the frame cost). */
function parseDt(raw: string): number {
  const m = /^(\d+)\s*\/\s*(\d+)$/.exec(raw);
  const v = m ? Number(m[1]) / Number(m[2]) : Number(raw);
  if (!Number.isFinite(v) || v <= 0 || v > 0.05) {
    console.error(`--dt must be in (0, 0.05] (got ${raw})`);
    process.exit(2);
  }
  return v;
}

function parseArgs(argv: string[]): CliArgs {
  const a: CliArgs = {
    world: "games/dollhouse/src/game.spec.json",
    seed: null,
    locale: null,
    grid: 8,
    dt: 1 / 60,
    transcript: null,
    script: null,
    json: false,
    cheats: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const next = () => argv[++i];
    if (k === "--world") a.world = next();
    else if (k === "--seed") a.seed = Number(next());
    else if (k === "--locale") a.locale = next();
    else if (k === "--grid") a.grid = Number(next());
    else if (k === "--dt") a.dt = parseDt(next());
    else if (k === "--transcript") a.transcript = next();
    else if (k === "--script") a.script = next();
    else if (k === "--json") a.json = true;
    else if (k === "--cheats") a.cheats = true;
    else {
      console.error(`unknown flag ${k}`);
      process.exit(2);
    }
  }
  return a;
}

function gitRev(): string {
  try {
    const rev = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
    const dirty = execSync("git status --porcelain", { encoding: "utf8" }).trim().length > 0;
    return dirty ? `${rev}+dirty` : rev;
  } catch {
    return "unknown";
  }
}

/** Commands extracted from a transcript/script file: `> `-prefixed lines, or —
 *  when the file has none — every non-comment, non-blank line. */
function scriptCommands(file: string): string[] {
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  const echoed = lines.filter((l) => l.startsWith("> ")).map((l) => l.slice(2));
  if (echoed.length > 0) return echoed;
  return lines.filter((l) => l.trim().length > 0 && !l.startsWith("#"));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const worldPath = path.resolve(process.cwd(), args.world);
  const raw = JSON.parse(fs.readFileSync(worldPath, "utf8")) as Record<string, unknown>;
  const game = (raw.game ?? {}) as { world?: { seed?: number; locale?: string } };
  const locale = args.locale ?? game.world?.locale ?? "en";

  const seed = args.seed ?? game.world?.seed ?? 0;
  const FENCE = "# " + "─".repeat(41);
  const worldName = path.basename(worldPath).replace(/\.json$/, "");
  const started = new Date().toISOString();
  const transcriptPath =
    args.transcript ??
    path.join("transcripts", `${worldName}-${seed}-${started.replace(/[:.]/g, "-")}.txt`);
  fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
  const out = fs.createWriteStream(transcriptPath, { encoding: "utf8" });
  const jsonl = args.json ? fs.createWriteStream(`${transcriptPath}.jsonl`, { encoding: "utf8" }) : null;

  const emit = (line: string) => {
    process.stdout.write(line + "\n");
    out.write(line + "\n");
  };

  // The sim's own console diagnostics (e.g. quest-host's `[doll]` heartbeat)
  // land in devtools under GL — invisible to a player. Here stdout IS the
  // tester channel (law ①: no sim internals), so console traffic is captured
  // to a sidecar instead. console.error stays on stderr for real failures.
  const consoleLog = fs.createWriteStream(`${transcriptPath}.console.log`, { encoding: "utf8" });
  const capture =
    (level: string) =>
    (...parts: unknown[]) =>
      consoleLog.write(`[${level}] ${parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join(" ")}\n`);
  console.log = capture("log");
  console.info = capture("info");
  console.warn = capture("warn");
  console.debug = capture("debug");

  // ── run metadata: ABOVE the fence, excluded from diffs (§10 of the design)
  emit(`# world-text v1   proto=1`);
  emit(`# world=${worldName}  seed=${seed}  locale=${locale}  grid=${args.grid}  dt=${args.dt.toFixed(4)}  settle=0.75s/8.0s`);
  emit(`# engine=${gitRev()}`);
  emit(`# started=${started}`);
  emit(FENCE);

  let frames = 0;
  const run = bootTextQuest({ world: raw, seed: args.seed ?? undefined, dt: args.dt });
  const countedStep = () => {
    frames++;
    run.stepFrame();
  };
  // Runtime proper nouns for the sentence builder: the presenter's `nouns`
  // pushes refresh this array IN PLACE (the session reads deps.nouns per
  // surface call, so the latest push is always what the builder sees).
  const liveNouns: BuilderNounEntry[] = [];
  run.addPresenterTap({
    nouns: (list) => {
      liveNouns.length = 0;
      for (const n of list ?? []) liveNouns.push(n);
    },
  });
  const spirit = (raw.game as { avatar?: unknown } | undefined)?.avatar === "spirit";
  const cheatsLog = args.cheats
    ? fs.createWriteStream(`${transcriptPath}.cheats.log`, { encoding: "utf8" })
    : null;
  const session = createTextModeSession({
    host: run.host,
    view: run.view,
    stepFrame: countedStep,
    frameDt: run.frameDt,
    addPresenterTap: (p) => run.addPresenterTap(p),
    locale,
    grid: args.grid,
    spirit,
    look: (x, y) => run.look(x, y),
    clearLook: () => run.clearLook(),
    addresseeOf: () => run.host.localAddressee(),
    // Law ⑤ ranks a body NAMED when it is known by name, and law ①'s activity
    // channel is what "3 townsfolk draw water" is made of. Both are host reads
    // a GL player has on screen (the family chips, the activity bubble) — a
    // transcript without them narrates a town of anonymous idlers.
    nameOf: (cid) => run.host.nameOf(cid),
    activityOf: (cid) => run.host.activityOf(cid),
    nouns: liveNouns,
    cheats: args.cheats,
    cheatHost: run.host,
  });

  // One warm-up frame before the first command: the view's reveal cache (and
  // the probe) fill on first render — a GL player likewise sees nothing until
  // frame 1. Without this, the run's first query answers "no world is loaded".
  countedStep();

  const counts = new Map<string, number>();
  const runCommand = (input: string) => {
    const trimmed = input.trim();
    if (!trimmed) return;
    emit(`> ${trimmed}`);
    const frame = session.command(trimmed);
    for (const ev of frame.events) counts.set(ev.tag, (counts.get(ev.tag) ?? 0) + 1);
    for (const line of frame.lines) emit(line);
    // Cheat output goes ONLY to the sidecar (law ⑦) — the transcript keeps the
    // CHEAT marker line the session already emitted.
    if (cheatsLog && frame.cheatLines) {
      cheatsLog.write(`> ${trimmed}\n`);
      for (const line of frame.cheatLines) cheatsLog.write(line + "\n");
    }
    if (jsonl) for (const ev of frame.events) jsonl.write(JSON.stringify(ev) + "\n");
  };

  const finish = () => {
    const simS = (frames * run.frameDt).toFixed(1);
    const stats = session.sessionStats();
    const tally = [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => `${k} ${n}`)
      .join("  ");
    emit(FENCE);
    emit(`# commands=${stats.commands}  presses=${stats.presses}  screens=${stats.screens}  sim=${simS}s`);
    if (tally) emit(`# events: ${tally}`);
    out.end();
    jsonl?.end();
    cheatsLog?.end();
    consoleLog.end();
    run.dispose();
    console.error(`transcript: ${transcriptPath}`);
  };

  if (args.script) {
    for (const cmd of scriptCommands(args.script)) runCommand(cmd);
    finish();
    return;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stderr, prompt: "> " });
  rl.prompt();
  rl.on("line", (line) => {
    if (line.trim() === "quit" || line.trim() === "exit") {
      rl.close();
      return;
    }
    try {
      runCommand(line);
    } catch (err) {
      emit(`ERR    ${err instanceof Error ? err.message : String(err)}`);
    }
    rl.prompt();
  });
  rl.on("close", finish);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
