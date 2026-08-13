// scripts/wide-tick-ab.ts
//
// ⏩ THE WIDE-TICK A/B COMPARATOR — stage W2 of
// planning-docs/games/world-engine/wide-tick-round.md.
//
// Boots the SAME world + seed + command script twice through `bootTextQuest`,
// once at the baseline dt (1/20) and once at a WIDE dt, and answers the only
// question law W-④ asks: did the town do the same THINGS?
//
//   npx tsx scripts/wide-tick-ab.ts                                  # dollhouse, 0.5
//   npx tsx scripts/wide-tick-ab.ts --wide 0.25
//   npx tsx scripts/wide-tick-ab.ts --world scripts/worlds/frontier.spec.json --seed 11
//   npx tsx scripts/wide-tick-ab.ts --script transcripts/dx-doll-bench.txt
//
// ⚖️ W-④ — ACCEPTANCE IS A BEAT COMPARISON, NEVER BYTE IDENTITY. A wide tick
// makes coarser DECISIONS (one pass per frame instead of ten), so positions,
// orderings and timings legitimately drift. What may not drift is WHAT
// HAPPENED: the same activities entered, the same arrivals seen, the same
// toasts raised, the same goods on the books at each day close. A beat present
// in one run and absent in the other FAILS.
//
// What is deliberately NOT a beat: the ORDER things happened in, the sim second
// they happened at, and any count of how many times (the recorded divergences —
// need-arbitration order at a crossing tick, ritual phase overshoot ≤ dt, the
// text settle window quantizing to dt — all move those and none of them mean
// the town behaved differently).
//
// 🔧 THE `act` CHANNEL IS NARROWED TO COMPLETIONS (W4b, wide-tick-round.md) —
// it used to record every (body, activity) pair a body ever wore, including
// the TRANSIENT waypoint a body wears mid-errand ("go home" while walking
// there, never a completion) — `creatureActivity`'s fallback to
// `creatureGoing` when a body has no live activity of its own, always
// `verb === "go"`. Which waypoint a run is caught wearing depends on when its
// decision pass lands, so that half of the channel differed between ANY two
// dts, seam or no seam, and could never read PASS across a dt change on its
// own terms — a floor recorded at the time (dollhouse seed 12, 93 s arc, both
// dts BELOW the seam: dt 1/30 vs 1/20 → 3 one-sided beats of 111; 1/20 vs 0.5
// → 14 of 196). `verb === "go"` beats are now skipped before being recorded,
// so the channel counts only what a body SETTLES into. What still gates the
// round: a one-sided beat in `toast` / `goal` / `won` / `act` (post-narrowing)
// / `depart` / `arrive` (a completion, or a genuine visibility event, that
// only happened in one run), or a ledger row outside its band.

import * as fs from "node:fs";
import * as path from "node:path";
import { bootTextQuest } from "../shared/world-engine/headless/text-quest.ts";
import { createTextModeSession } from "../shared/world-engine/interaction/text/index.ts";
import { FOOD_DAY_SEC } from "../shared/world-engine/kernel/town/goods.ts";
import type { BuilderNounEntry } from "../shared/world-engine/interaction/intent/builder-surface.ts";

// ── TOLERANCE BANDS (law W-④ says "within tolerance"; here is the tolerance) ──
/** Per-glyph day-close ledger slack: a count may differ by this many UNITS… */
const LEDGER_TOL_UNITS = 2;
/** …or by this FRACTION of the baseline count, whichever is the larger band. A
 *  wide tick can have a body arrive one tick late at a store, which moves a
 *  single haul across a day edge; it may not move a stockpile. */
const LEDGER_TOL_FRAC = 0.1;
/** Ledger snapshots are taken on a sim-time GRID as well as at every
 *  economy-day edge, and compared BY LABEL. Two runs never end on the same
 *  townClock — each command's settle rounds up to a whole frame, so the wide
 *  run overshoots — and a row only one run reached is skipped, not failed. */
const LEDGER_SAMPLE_S = 60;
/** How many one-sided beats to print per channel before eliding. */
const DIFF_PRINT_MAX = 12;

/** The default script: the standard dollhouse bench arc (transcripts/dx-doll-*). */
const DEFAULT_SCRIPT = [
  "wait 10", "scene", "say make workbench", "wait 30", "scene", "wait 30",
  "scene", "wait 40", "scene", "wait 40", "scene", "wait 40", "scene",
  "wait 40", "scene", "self",
];

interface RunResult {
  dt: number;
  frames: number;
  simS: number;
  wallS: number;
  /** townClock when the script ran out. The two runs do NOT cover the same span
   *  — every command's settle rounds up to a whole frame, so a wide run
   *  overshoots — and beats past the shorter run's end are compared against
   *  nothing. The diff truncates both to the shorter span. */
  endClock: number;
  /** Beats by channel: payload → the townClock it FIRST fired at. */
  byChannel: Map<string, Map<string, number>>;
  /** Label (`t=60s`, `day 1`) → glyph → count, at the moment that label passed. */
  ledgers: Map<string, Record<string, number>>;
}

function parseDt(raw: string): number {
  const m = /^(\d+)\s*\/\s*(\d+)$/.exec(raw);
  return m ? Number(m[1]) / Number(m[2]) : Number(raw);
}

/** `> `-prefixed lines of a transcript, else every non-comment line. Cheats are
 *  dropped: they need the cheat host and read the world rather than move it. */
function scriptCommands(file: string): string[] {
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  const echoed = lines.filter((l) => l.startsWith("> ")).map((l) => l.slice(2));
  const all = echoed.length ? echoed : lines.filter((l) => l.trim() && !l.startsWith("#"));
  return all.filter((c) => !c.trim().startsWith("/"));
}

function runOnce(
  raw: Record<string, unknown>,
  seed: number | undefined,
  commands: string[],
  dt: number,
  innerStepS: number,
): RunResult {
  const byChannel = new Map<string, Map<string, number>>();
  const beat = (channel: string, payload: string): void => {
    let set = byChannel.get(channel);
    if (!set) byChannel.set(channel, (set = new Map()));
    if (!set.has(payload)) set.set(payload, run.session.townClock);
  };

  const run = bootTextQuest({ world: raw, ...(seed !== undefined ? { seed } : {}), dt, innerStepS });
  const ledgers: RunResult["ledgers"] = new Map();

  // ── THE ACTIVITY CHANNEL: what each body is DOING, read EVERY FRAME. Not on
  //    a sim-time grid: a grid coarser than the decision pass misses whichever
  //    transitions fall between its samples, and it misses DIFFERENT ones in
  //    each run — which manufactures beat diffs out of the sampler rather than
  //    the sim. Every frame is every decision pass, in both runs, by
  //    construction. This is where meals, work and sleep land, and unlike the
  //    text view's DOING event it does not depend on who is in frame.
  //
  //    W4b — NARROWED to errand COMPLETIONS: `creatureActivity` (quest-host.ts)
  //    answers with either the body's OWN activity (a live goal/need step —
  //    `make workbench`, `eat`, `sleep`, …) or, failing that, falls back to
  //    `creatureGoing`'s travel tail — `{verb:"go", object: home/room/place}`
  //    — the waypoint label a body wears WHILE it walks there. `verb==="go"`
  //    is exactly and only that tail (home/room/place all route through it);
  //    it is never a real activity's own verb. Excluding it is what turns
  //    "go there"/"go home"/"go work" — the transients W2 found one-sided at
  //    both wide dts — from noise into signal: which waypoint a run catches a
  //    body wearing depends on when a coarse tick's decision pass lands
  //    (recorded divergence e3), but the activity a body actually SETTLES
  //    into does not.
  const lastAct = new Map<string, string>();
  let day = Math.floor(run.session.townClock / FOOD_DAY_SEC);
  let grid = Math.floor(run.session.townClock / LEDGER_SAMPLE_S);
  let frames = 0;
  const step = (): void => {
    run.stepFrame();
    frames++;
    for (const id of Object.keys(run.state.avatars)) {
      const a = run.host.activityOf(id);
      if (!a) continue;
      const act = a.object ? `${a.verb} ${a.object}` : a.verb;
      if (lastAct.get(id) !== act) {
        lastAct.set(id, act);
        if (a.verb !== "go") beat("act", `${id} → ${act}`);
      }
    }
    // THE BOOKS, on a shared grid and at every economy-day edge.
    const g = Math.floor(run.session.townClock / LEDGER_SAMPLE_S);
    if (g !== grid) {
      grid = g;
      ledgers.set(`t=${g * LEDGER_SAMPLE_S}s`, run.host.stockAudit());
    }
    const d = Math.floor(run.session.townClock / FOOD_DAY_SEC);
    if (d !== day) {
      day = d;
      ledgers.set(`day ${d}`, run.host.stockAudit());
    }
  };

  run.addPresenterTap({
    toast: (text) => beat("toast", text),
    objectives: (list) => {
      for (const o of list ?? []) beat("goal", typeof o === "string" ? o : JSON.stringify(o));
    },
    won: () => beat("won", "won"),
  });

  const liveNouns: BuilderNounEntry[] = [];
  run.addPresenterTap({
    nouns: (list) => {
      liveNouns.length = 0;
      for (const n of list ?? []) liveNouns.push(n);
    },
  });
  const spirit = (raw.game as { avatar?: unknown } | undefined)?.avatar === "spirit";
  const session = createTextModeSession({
    host: run.host,
    view: run.view,
    stepFrame: step,
    frameDt: run.frameDt,
    addPresenterTap: (p) => run.addPresenterTap(p),
    locale: "en",
    grid: 8,
    spirit,
    look: (x, y) => run.look(x, y),
    clearLook: () => run.clearLook(),
    addresseeOf: () => run.host.localAddressee(),
    nameOf: (cid) => run.host.nameOf(cid),
    activityOf: (cid) => run.host.activityOf(cid),
    nouns: liveNouns,
  });

  const t0 = performance.now();
  step(); // the warm-up frame the CLI also runs before the first command
  for (const cmd of commands) {
    const frame = session.command(cmd);
    for (const ev of frame.events) {
      // The PLAYER-VISIBLE beats: who showed up, who left, what changed hands,
      // what the world said. Everything else in the stream is a QUERY ANSWER
      // (SCENE/SELF/BOARD/TICK) — a description of a moment, not a thing that
      // happened, and its wording is expected to differ.
      switch (ev.tag) {
        case "ENTER": beat("arrive", ev.who); break;
        case "EXIT": beat("depart", ev.who); break;
        case "DOING": beat("doing", `${ev.who} → ${ev.activity}`); break;
        case "HOLD": beat("hold", `${ev.who} → ${ev.what ?? "(empty)"}`); break;
        case "OPEN": beat("open", `${ev.what} ${ev.open ? "open" : "shut"}`); break;
        case "WON": beat("won", "won"); break;
        default: break;
      }
    }
  }
  const wallS = (performance.now() - t0) / 1000;
  const endClock = run.session.townClock;
  run.dispose();
  return { dt, frames, simS: frames * dt, wallS, endClock, byChannel, ledgers };
}

/** The beats of one channel that fired at or before `cutoff`. */
function upTo(r: RunResult, channel: string, cutoff: number): Set<string> {
  const out = new Set<string>();
  for (const [payload, at] of r.byChannel.get(channel) ?? []) if (at <= cutoff) out.add(payload);
  return out;
}

function diffChannels(
  a: RunResult,
  b: RunResult,
  cutoff: number,
): { channel: string; na: number; nb: number; onlyA: string[]; onlyB: string[] }[] {
  const channels = [...new Set([...a.byChannel.keys(), ...b.byChannel.keys()])].sort();
  return channels.map((channel) => {
    const sa = upTo(a, channel, cutoff);
    const sb = upTo(b, channel, cutoff);
    return {
      channel,
      na: sa.size,
      nb: sb.size,
      onlyA: [...sa].filter((v) => !sb.has(v)).sort(),
      onlyB: [...sb].filter((v) => !sa.has(v)).sort(),
    };
  });
}

/** Is this glyph's count within the stated band? */
function withinBand(base: number, wide: number): boolean {
  const band = Math.max(LEDGER_TOL_UNITS, Math.abs(base) * LEDGER_TOL_FRAC);
  return Math.abs(wide - base) <= band;
}

function main(): void {
  const argv = process.argv.slice(2);
  let world = "games/dollhouse/src/game.spec.json";
  let seed: number | undefined = 12;
  let scriptFile: string | null = null;
  let base = 1 / 20;
  // Comma-separated: the BASELINE run is the expensive half and one of them
  // serves every wide dt, so `--wide 0.25,0.5` costs far less than two runs.
  let wides = [0.5];
  let inner = 0.05;
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const next = () => argv[++i];
    if (k === "--world") world = next();
    else if (k === "--seed") seed = Number(next());
    else if (k === "--script") scriptFile = next();
    else if (k === "--base") base = parseDt(next());
    else if (k === "--wide") wides = next().split(",").map(parseDt);
    else if (k === "--inner") inner = Number(next());
    else {
      console.error(`unknown flag ${k}`);
      process.exit(2);
    }
  }
  const worldPath = path.resolve(process.cwd(), world);
  const raw = JSON.parse(fs.readFileSync(worldPath, "utf8")) as Record<string, unknown>;
  const commands = scriptFile ? scriptCommands(scriptFile) : DEFAULT_SCRIPT;

  // The sim's own diagnostics would drown the report; stdout here IS the report.
  const noop = (() => {}) as typeof console.log;
  const realLog = console.log;
  console.log = noop;
  console.info = noop;
  console.warn = noop;
  console.debug = noop;
  const say = (line = "") => realLog(line);

  say(`⏩ WIDE-TICK A/B — ${path.basename(worldPath)}  seed=${seed ?? "(spec)"}  innerStepS=${inner}`);
  say(`   script: ${scriptFile ?? "(built-in dollhouse bench arc)"}  (${commands.length} commands)`);

  const a = runOnce(raw, seed, commands, base, inner);
  const bs = wides.map((w) => runOnce(raw, seed, commands, w, inner));

  say();
  say("WALL CLOCK");
  say("  run        dt      frames    sim s    wall s   sim/wall   speedup");
  const row = (name: string, r: RunResult, speed: string) =>
    say(
      `  ${name.padEnd(9)} ${r.dt.toFixed(4).padStart(6)} ${String(r.frames).padStart(9)} ` +
        `${r.simS.toFixed(1).padStart(8)} ${r.wallS.toFixed(1).padStart(9)} ` +
        `${(r.simS / r.wallS).toFixed(2).padStart(10)} ${speed.padStart(9)}`,
    );
  row("baseline", a, "1.00×");
  for (const b of bs) row(`wide ${b.dt}`, b, `${(a.wallS / b.wallS).toFixed(2)}×`);

  let fail = false;
  for (const b of bs) {
    say();
    say(`══════ dt ${a.dt.toFixed(4)} vs ${b.dt.toFixed(4)} ══════`);
    const cutoff = Math.min(a.endClock, b.endClock);
    const diffs = diffChannels(a, b, cutoff);
    const beatFail = diffs.some((d) => d.onlyA.length || d.onlyB.length);
    say(
      `BEATS  (a beat in one run and not the other FAILS — W-④; both truncated to ` +
        `townClock ≤ ${cutoff.toFixed(1)}s — baseline ended ${a.endClock.toFixed(1)}s, wide ${b.endClock.toFixed(1)}s)`,
    );
    say("  channel      baseline  wide   only-baseline  only-wide");
    for (const d of diffs) {
      say(
        `  ${d.channel.padEnd(12)} ${String(d.na).padStart(8)} ${String(d.nb).padStart(5)} ` +
          `${String(d.onlyA.length).padStart(14)} ${String(d.onlyB.length).padStart(10)}`,
      );
    }
    for (const d of diffs) {
      if (!d.onlyA.length && !d.onlyB.length) continue;
      say();
      say(`  ── ${d.channel} ──`);
      for (const v of d.onlyA.slice(0, DIFF_PRINT_MAX)) say(`    baseline only: ${v}`);
      if (d.onlyA.length > DIFF_PRINT_MAX) say(`    … ${d.onlyA.length - DIFF_PRINT_MAX} more`);
      for (const v of d.onlyB.slice(0, DIFF_PRINT_MAX)) say(`    wide only:     ${v}`);
      if (d.onlyB.length > DIFF_PRINT_MAX) say(`    … ${d.onlyB.length - DIFF_PRINT_MAX} more`);
    }
    say();

    say(`LEDGER  (band: ±${LEDGER_TOL_UNITS} units or ±${(LEDGER_TOL_FRAC * 100).toFixed(0)}%, whichever is larger)`);
    let ledgerFail = false;
    // BY LABEL, and only labels BOTH runs reached — a wide run overshoots the
    // script's span, so its extra rows have nothing to be compared against.
    const labels = [...a.ledgers.keys()].filter((k) => b.ledgers.has(k));
    const skipped = [...a.ledgers.keys(), ...b.ledgers.keys()].filter(
      (k) => !a.ledgers.has(k) || !b.ledgers.has(k),
    );
    if (!labels.length) say("  (no shared checkpoint — the arc is shorter than one sample)");
    for (const label of labels) {
      const la = a.ledgers.get(label)!;
      const lb = b.ledgers.get(label)!;
      const glyphs = [...new Set([...Object.keys(la), ...Object.keys(lb)])].sort();
      const bad = glyphs.filter((g) => !withinBand(la[g] ?? 0, lb[g] ?? 0));
      say(`  ${label}: ${glyphs.length} goods, ${bad.length} outside band`);
      for (const g of bad) {
        ledgerFail = true;
        say(`    ✗ ${g}: baseline ${(la[g] ?? 0).toFixed(2)}  wide ${(lb[g] ?? 0).toFixed(2)}`);
      }
    }
    if (skipped.length) say(`  (skipped, reached by one run only: ${[...new Set(skipped)].join(", ")})`);
    say();
    say(`VERDICT dt=${b.dt}  beats:${beatFail ? "FAIL" : "PASS"}  ledger:${ledgerFail ? "FAIL" : "PASS"}`);
    fail ||= beatFail || ledgerFail;
  }
  process.exitCode = fail ? 1 : 0;
}

main();
