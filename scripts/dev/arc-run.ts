// scripts/dev/arc-run.ts — THE SHARED MEASUREMENT ARC RUNNER.
//
// Every lane that wanted ten play-days of numbers used to REBUILD a harness
// (three of them existed side by side in one scratchpad on 2026-09-09, each
// re-deriving the same regexes). This is that harness, once, in the tree.
//
//   npx tsx scripts/dev/arc-run.ts --world scripts/worlds/frontier-planet.spec.json \
//        --seed 11 --dt 1/2 --days 10 --out transcripts/arc-frontier-planet-s11
//   npx tsx scripts/dev/arc-run.ts --world scripts/worlds/frontier.spec.json \
//        --seed 11 --days 3 --script scripts/dev/arc-build-house.txt
//
// ⚖️ THE LAW THIS FILE KEEPS: **never instrument the engine for a metric.**
// Everything below is read from the SESSION (public fields the host already
// keeps) or parsed off the engine's OWN console/toast narration. If a number
// is not visible from outside, it does not belong here — it belongs in a
// ruling about what the engine should say.
//
// Outputs, into `--out <dir>` (default `transcripts/arc-<world>-s<seed>`):
//   arc.txt        the per-day transcript + the summary block (diffable)
//   metrics.json   the same numbers, machine-readable (bench/A-B consumers)
//   console.log    every captured engine line, sim-time prefixed
//
// `--script <file>` takes one command per line, run BEFORE the remaining days
// are stepped out; the time it consumes counts toward `--days`. The commands
// are TEXT MODE's own (`npm run world:text`), parsed by the same
// `createTextModeSession` — so `say build house` composes the sentence exactly
// as a player would and a transcript's `> ` lines replay here unchanged:
//   wait 12
//   say build house
//   # comment / blank lines are skipped

import * as fs from "node:fs";
import * as path from "node:path";
import { bootTextQuest } from "../../shared/world-engine/headless/text-quest.ts";
import { createTextModeSession } from "../../shared/world-engine/interaction/text/index.ts";
import type { BuilderNounEntry } from "../../shared/world-engine/interaction/intent/builder-surface.ts";
import { needRate } from "../../shared/world-engine/scale.ts";
import { bodyNeedLevel } from "../../shared/world-engine/interaction/behavior/body-needs.ts";
import {
  skillEffectiveLevel,
  skillMultiplier,
  type SkillCatalogue,
} from "../../shared/world-engine/kernel/town/skills.ts";

// ── CLI ─────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const arg = (k: string, d: string): string => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1]! : d;
};
const has = (k: string) => argv.includes(`--${k}`);
/** `1/2`-style fractions or decimals, the same grammar `world-text.ts` takes. */
const parseDt = (raw: string): number => {
  const m = /^(\d+)\s*\/\s*(\d+)$/.exec(raw);
  const v = m ? Number(m[1]) / Number(m[2]) : Number(raw);
  if (!Number.isFinite(v) || v <= 0 || v > 0.5) {
    console.error(`--dt must be in (0, 0.5] (got ${raw})`);
    process.exit(2);
  }
  return v;
};

const WORLD_PATH = arg("world", "scripts/worlds/frontier-planet.spec.json");
const SEED = Number(arg("seed", "11"));
const DT = parseDt(arg("dt", "1/2"));
const DAYS = Number(arg("days", "10"));
const SCRIPT = arg("script", "");
const QUIET = has("quiet");
const WORLD_TAG = path.basename(WORLD_PATH).replace(/\.spec\.json$/, "");
const OUT_DIR = arg("out", path.join("transcripts", `arc-${WORLD_TAG}-s${SEED}`));

// ── THE CONSOLE, CAPTURED (before the boot: the boot narrates too) ──────────
const conLines: string[] = [];
const realLog = console.log.bind(console);
const clock = { t: 0 };
const counts = new Map<string, number>();
const bump = (k: string, n = 1) => counts.set(k, (counts.get(k) ?? 0) + n);
console.log = (...a: unknown[]) => {
  const s = a.map((x) => (typeof x === "string" ? x : String(x))).join(" ");
  conLines.push(`t=${clock.t.toFixed(1)} ${s}`);
};

// `[needs] <cid> took <n>×<goodKey> from <objId>`  (quest-host.ts :18028)
const TAKE_RE = /\[needs\] (\S+) took ([\d.]+)×(\S+) from (\S+)/;
// 🪨 A STOW — a deposit that landed in a GROUND PILE (piles-not-boxes-round.md).
// ⚖️ NO NEW ENGINE LINE. The round's ruling 6 offered one; it is not needed and
// so is not taken: the deposit arm has ALWAYS narrated
// `[needs] <cid> deposited <n>×<good> into <id>` (quest-host, the deposit arm of
// `applyNeedStepEffect`), and the destination id is the whole discriminator. The
// harness reads the engine's own words — it never instruments it for a metric.
const DEPOSIT_RE = /\[needs\] (\S+) deposited ([\d.]+)×(\S*) into (\S+)/;
// 🪨 A COLLECT CLAIM — the `[pull]` claim line whose BILL is a collect
// (`collect:<dest>`, `collectSiteId`). The link word is `haul`, because a
// collect IS a haul; the site id is what says what kind of haul it is.
const COLLECT_RE = /\[pull\] (\S+) took \S+ ([\d.]+) (\S+) for collect:(\S+)/;
const PARK_RE = /blocked mid-flight.*\(route parked\)/;
const RESEL_RE = /blocked mid-flight.*re-deciding the row/;
const SLEPT_RE = / slept /;
const REAP_RE = /orphaned errand queue reaped/;
const HAUL_ABANDON_RE = /\[haul\] .*ABANDONED/;
const HAUL_REISSUE_RE = /\[haul\] .*RE-ISSUED/;

let takes = 0;
let takeUnitsFood = 0;
const takeHist = new Map<number, number>();
const takeByGood = new Map<string, number>();
const takeBySource = new Map<string, number>();
let zeroYield = 0;
let conCursor = 0;
let dayTakes = 0;
let dayRations = 0;
// 🪨 PILES (piles-not-boxes-round.md): what went INTO one, and what was carried
// OUT of one into a box. Both read off the engine's own narration.
let stows = 0;
let stowUnits = 0;
let dayStows = 0;
let collects = 0;
let collectUnits = 0;
let dayCollects = 0;
const stowByHead = new Map<string, number>();
const notable: string[] = [];

const drainConsole = () => {
  for (; conCursor < conLines.length; conCursor++) {
    const l = conLines[conCursor]!;
    const m = TAKE_RE.exec(l);
    if (m) {
      const q = Number(m[2]);
      const good = m[3]!;
      if (q === 0) {
        zeroYield++;
        continue;
      }
      takes++;
      dayTakes++;
      // Round the BUCKET, not the quantity: a take of 0.6000000000000001 units
      // is one bucket with 0.6, and a histogram keyed on raw floats scatters
      // one bucket across three.
      const bucket = Math.round(q * 100) / 100;
      takeHist.set(bucket, (takeHist.get(bucket) ?? 0) + 1);
      takeByGood.set(good, (takeByGood.get(good) ?? 0) + q);
      const src = m[4]!.replace(/^wild:area:/, "wild:").split(":").slice(0, 2).join(":");
      takeBySource.set(src, (takeBySource.get(src) ?? 0) + 1);
      if (good === "food") {
        takeUnitsFood += q;
        dayRations += q;
      }
      continue;
    }
    const dep = DEPOSIT_RE.exec(l);
    if (dep && dep[4]!.startsWith("pile:")) {
      stows++;
      dayStows++;
      const q = Number(dep[2]);
      stowUnits += q;
      const head = dep[3] || dep[4]!.slice("pile:".length);
      stowByHead.set(head, (stowByHead.get(head) ?? 0) + q);
      continue;
    }
    const col = COLLECT_RE.exec(l);
    if (col) {
      collects++;
      dayCollects++;
      collectUnits += Number(col[2]);
      continue;
    }
    if (PARK_RE.test(l)) bump("parked");
    else if (RESEL_RE.test(l)) bump("reselected");
    if (SLEPT_RE.test(l)) bump("sleeps");
    if (REAP_RE.test(l)) {
      bump("reaped");
      notable.push(l);
    }
    if (HAUL_ABANDON_RE.test(l)) {
      bump("haulAbandoned");
      notable.push(l);
    }
    if (HAUL_REISSUE_RE.test(l)) {
      bump("haulReissued");
      notable.push(l);
    }
  }
};

// ── BOOT ────────────────────────────────────────────────────────────────────
const wall0 = Date.now();
const world = JSON.parse(fs.readFileSync(WORLD_PATH, "utf8"));
const run = bootTextQuest({ world, seed: SEED, dt: DT });
const session = run.session as unknown as SessionView;
const dayS: number = session.scale.dayLengthS;
const HUNGER_RATE = needRate(session.scale as never, "hunger");

/** The public session surface this file reads. Structural, not a new contract:
 *  every field here is one the host already keeps for its own use. */
interface SessionView {
  townClock: number;
  scale: { dayLengthS: number; learning: number };
  bodyNeeds: Map<string, Map<string, { level: number; at: number }>>;
  /** ⚖️ THE PRACTICE LEDGER (skill-learning-round.md) — cid → skill → seconds.
   *  Read only; the harness never instruments the engine for a metric. */
  bodySkills: Map<string, Map<string, { practiceS: number }>>;
  /** The catalogue + the dial the curve is read against (`skillEffectiveLevel`
   *  is pure over these three fields). */
  skills: SkillCatalogue;
  /** 🪨 THE CONTAINER REGISTRY (piles-not-boxes-round.md) — read only, at each
   *  day edge, so `pileUnits` is the ENGINE's own ledger rather than a counter
   *  this harness asked the engine to keep. */
  containerRecords: Map<string, { stock?: Record<string, number> }>;
  npcTasks: Map<string, unknown[]>;
  pursuits: Map<string, unknown>;
  walk: Map<string, unknown>;
  needStep: Map<string, unknown>;
  /** ⚖️ THE INTERCITY LINE (trade-topology round) — `TownTrade` as the host
   *  holds it. Read only, at each caravan bucket edge: who the line is bound
   *  to, the road, the derived cargo and the per-visit split. */
  town?: { stage: { trade: TradeView | null } } | null;
}
interface TradeView {
  route: {
    partnerKey: string;
    distanceM: number;
    imports: readonly string[];
    exports: readonly string[];
    rare: { kind: string; perVisit: number };
    partnerAt?: { x: number; y: number };
  };
  tradeDay(t: number): number;
  importUnitsPerVisit(good: string): number;
}

// ── CONSTRUCTION BEATS (toasts, not console lines) ──────────────────────────
const BEATS: Array<{ key: string; re: RegExp }> = [
  { key: "materialsStaged", re: /materials staged/ },
  { key: "houseFinished", re: /the house is finished/ },
  { key: "anyFinished", re: /is finished/ },
  { key: "familyMovesIn", re: /a family moves into/ },
];
const beatAt: Record<string, number | null> = {};
for (const b of BEATS) beatAt[b.key] = null;
const buildToasts: string[] = [];
// ⚖️ TRADE LINES (trade-topology round): every toast the caravan/barter/fade
// surface speaks — `🐴 caravan from …`, `🐴 the caravan comes from … now`,
// `🧺 … grows here now`, `⏸ … paused`, `▶ … resumed`. Parsed off the toast
// channel exactly as the construction beats are; the engine is not touched.
const tradeToasts: string[] = [];
run.addPresenterTap({
  toast: (text: string) => {
    const t = session.townClock;
    for (const b of BEATS) if (b.re.test(text) && beatAt[b.key] === null) beatAt[b.key] = t;
    if (/🧱|🏛|🏠|staged|finished|moves into|raise/.test(text))
      buildToasts.push(`t=${t.toFixed(1)} ${text}`);
    if (/caravan|🧺|🐴|trade/.test(text)) tradeToasts.push(`t=${t.toFixed(1)} ${text}`);
  },
});

// ── THE INTERCITY LINE, PER CARAVAN BUCKET (trade-topology round) ───────────
//
// 🚨 READ OFF `session.town.stage.trade` — never instrumented. One row per
// visit bucket: the reading at the bucket EDGE (the first sample inside it,
// after the host's own sweep has re-derived the cargo) and, when the next edge
// arrives, the reading the bucket ENDED on. `partnerChanges` is the derived
// list of bind edges (a partner key differing from the previous sample's).
interface TradeReading {
  t: number;
  partnerKey: string;
  distanceM: number;
  bound: boolean;
  imports: string[];
  exports: string[];
  units: Record<string, number>;
  rare: { kind: string; perVisit: number };
}
const tradeReading = (): TradeReading | null => {
  const tr = session.town?.stage.trade;
  if (!tr) return null;
  const units: Record<string, number> = {};
  for (const g of tr.route.imports) units[g] = tr.importUnitsPerVisit(g);
  return {
    t: Number(session.townClock.toFixed(1)),
    partnerKey: tr.route.partnerKey,
    distanceM: Number(tr.route.distanceM.toFixed(1)),
    bound: tr.route.partnerAt !== undefined,
    imports: [...tr.route.imports],
    exports: [...tr.route.exports],
    units,
    rare: { kind: tr.route.rare.kind, perVisit: tr.importUnitsPerVisit(tr.route.rare.kind) },
  };
};
const tradeBuckets: Array<{ bucket: number; atEdge: TradeReading; atEnd: TradeReading | null }> = [];
const partnerChanges: Array<{ t: number; from: string; to: string }> = [];
let lastBucket: number | null = null;
let lastPartner: string | null = null;
const sampleTrade = () => {
  const tr = session.town?.stage.trade;
  if (!tr) return;
  const r = tradeReading()!;
  if (lastPartner !== null && r.partnerKey !== lastPartner) {
    partnerChanges.push({ t: r.t, from: lastPartner, to: r.partnerKey });
  }
  lastPartner = r.partnerKey;
  const bucket = tr.tradeDay(session.townClock);
  if (bucket !== lastBucket) {
    tradeBuckets.push({ bucket, atEdge: r, atEnd: null });
    lastBucket = bucket;
  } else {
    const cur = tradeBuckets[tradeBuckets.length - 1];
    if (cur) cur.atEnd = r; // the bucket's latest reading; overwritten until the edge
  }
};

// ── SAMPLED STATE ───────────────────────────────────────────────────────────
/** EVERY body the host keeps needs for — no name filter. A world names its
 *  bodies whatever it likes (`settler_3` on frontier-planet, a person's own id
 *  elsewhere); a harness that pattern-matches the names silently measures
 *  ZERO bodies on the next world it is pointed at. */
const bodyIds = (): string[] => [...session.bodyNeeds.keys()];
const hungerOf = (cid: string): number => {
  const row = session.bodyNeeds.get(cid)?.get("hunger:food");
  return row ? bodyNeedLevel(row as never, HUNGER_RATE, session.townClock) : 0;
};

const FROZEN_S = 60;
const streak = new Map<string, number>();
const episode = new Map<string, number>();
const frozen: Array<{ cid: string; fromS: number; forS: number }> = [];
let frozenBodySeconds = 0;
let starve15 = 0;
let starve3 = 0;
let samples = 0;
let nextSample = 1;
let dayIdx = 0;
// 🪨 …and `Record<string, number>` for `pileUnits` (piles-not-boxes): a day row
// may carry the per-HEAD pile reading, which is a small map rather than a scalar.
const perDay: Array<Record<string, number | string | Record<string, number>>> = [];
const lines: string[] = [];

const sampleOnce = () => {
  samples++;
  sampleTrade();
  for (const cid of bodyIds()) {
    const h = hungerOf(cid);
    if (h >= 1.5) starve15++;
    if (h >= 3) starve3++;
    const queued = session.npcTasks.get(`npc_${cid}`)?.length ?? 0;
    const driving =
      session.pursuits.has(cid) || session.walk.has(cid) || session.needStep.has(cid);
    if (queued > 0 && !driving) {
      const s = (streak.get(cid) ?? 0) + 1;
      streak.set(cid, s);
      frozenBodySeconds++;
      if (s === FROZEN_S) {
        frozen.push({ cid, fromS: session.townClock - FROZEN_S, forS: s });
        episode.set(cid, frozen.length - 1);
      } else if (s > FROZEN_S) frozen[episode.get(cid)!]!.forS = s;
    } else streak.set(cid, 0);
  }
};

/** 🪨 WHAT IS STANDING IN THE SETTLEMENT'S PILES RIGHT NOW — head → units, read
 *  straight off `containerRecords`. Absent piles are absent keys, so a world
 *  that has never put anything down samples `{}`. */
const pileSample = (): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const [id, rec] of session.containerRecords ?? []) {
    if (!id.startsWith("pile:") || !rec.stock) continue;
    let n = 0;
    for (const v of Object.values(rec.stock)) n += Math.max(0, v);
    if (n > 0) out[id.slice("pile:".length)] = Number(n.toFixed(2));
  }
  return out;
};

const closeDay = () => {
  dayIdx++;
  const lv = bodyIds().map(hungerOf);
  const mean = lv.length ? lv.reduce((a, b) => a + b, 0) / lv.length : 0;
  const row = {
    day: dayIdx,
    rations: Number(dayRations.toFixed(2)),
    takes: dayTakes,
    parked: counts.get("parked") ?? 0,
    reselected: counts.get("reselected") ?? 0,
    sleeps: counts.get("sleeps") ?? 0,
    hungryMean: Number(mean.toFixed(2)),
    hungry: lv.filter((x) => x >= 1).length,
    bodies: lv.length,
    // 🪨 piles-not-boxes: what was put into a pile today, what was carried out
    // of one into a box today, and what is standing in them at the day's edge.
    stows: dayStows,
    collects: dayCollects,
    pileUnits: pileSample(),
  };
  perDay.push(row);
  const piles = Object.entries(row.pileUnits)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([h, n]) => `${h}=${n}`)
    .join(",");
  lines.push(
    `day ${String(dayIdx).padStart(3)}  rations=${row.rations.toFixed(2).padStart(7)}` +
      `  takes=${String(row.takes).padStart(4)}  parked=${String(row.parked).padStart(3)}` +
      ` resel=${String(row.reselected).padStart(3)}  sleeps=${String(row.sleeps).padStart(3)}` +
      `  hungry=${row.hungry}/${row.bodies} mean=${row.hungryMean.toFixed(2)}` +
      `  stows=${String(row.stows).padStart(3)} collects=${String(row.collects).padStart(3)}` +
      `  pile[${piles}]`,
  );
  dayTakes = 0;
  dayRations = 0;
  dayStows = 0;
  dayCollects = 0;
};

// ── THE LOOP ────────────────────────────────────────────────────────────────
const TOTAL_FRAMES = Math.round((DAYS * dayS) / DT);
let framesDone = 0;
let nextDayFrame = Math.round(dayS / DT);

/** Step `n` frames, keeping every sampler honest. Never steps past the budget. */
const stepFrames = (n: number) => {
  for (let i = 0; i < n && framesDone < TOTAL_FRAMES; i++) {
    run.stepFrame();
    framesDone++;
    clock.t = session.townClock;
    while (session.townClock >= nextSample) {
      nextSample++;
      sampleOnce();
    }
    drainConsole();
    if (framesDone >= nextDayFrame) {
      nextDayFrame += Math.round(dayS / DT);
      closeDay();
    }
  }
};
// ── THE SCRIPT, THROUGH TEXT MODE'S OWN PARSER ──────────────────────────────
// `say build house` must compose the sentence the way a player's board does —
// `run.speak()` is the raw path and takes an already-composed line, so a
// harness that calls it with prose silently orders NOTHING (measured: the
// construction beats never fired).
const liveNouns: BuilderNounEntry[] = [];
run.addPresenterTap({
  nouns: (list: readonly BuilderNounEntry[] | null) => {
    liveNouns.length = 0;
    for (const n of list ?? []) liveNouns.push(n);
  },
});
const textSession = createTextModeSession({
  host: run.host,
  view: run.view,
  stepFrame: () => stepFrames(1),
  frameDt: run.frameDt,
  addPresenterTap: (p) => run.addPresenterTap(p),
  locale: "en",
  grid: 8,
  spirit: (world as { game?: { avatar?: unknown } }).game?.avatar === "spirit",
  look: (x: number, y: number) => run.look(x, y),
  clearLook: () => run.clearLook(),
  addresseeOf: () => run.host.localAddressee(),
  nameOf: (cid: string) => run.host.nameOf(cid),
  activityOf: (cid: string) => run.host.activityOf(cid),
  nouns: liveNouns,
});

const scriptEcho: string[] = [];
try {
  if (SCRIPT) {
    const cmds = fs
      .readFileSync(SCRIPT, "utf8")
      .split(/\r?\n/)
      .map((l) => l.replace(/^>\s*/, "").trim())
      .filter((l) => l && !l.startsWith("#"));
    stepFrames(1); // the warm-up frame the CLI also runs before the first command
    for (const c of cmds) {
      scriptEcho.push(`> ${c}`);
      try {
        for (const ev of textSession.command(c).events)
          if (ev.tag === "SAY" || ev.tag === "TOAST" || ev.tag === "NOTE")
            scriptEcho.push(`  ${ev.tag} ${JSON.stringify(ev).slice(0, 200)}`);
      } catch (e) {
        scriptEcho.push(`  ! ${String(e)}`);
      }
    }
  }
  stepFrames(TOTAL_FRAMES - framesDone);
} finally {
  drainConsole();
  console.log = realLog;
}

// ── REPORT ──────────────────────────────────────────────────────────────────
const wallMs = Date.now() - wall0;
const bigTakes = [...takeHist.entries()].filter(([u]) => u >= 6).reduce((s, [, c]) => s + c, 0);
const lvEnd = bodyIds().map(hungerOf);
// ── SKILLS (skill-learning-round.md §2.6) ───────────────────────────────────
//
// 🚨 READ OFF `session.bodySkills` — the engine is NEVER instrumented for a
// metric. Per body: its top skill, that level, and every skill's practice
// seconds; per skill: CONCENTRATION, the share of that skill's total practice
// held by its single busiest body. Concentration is the division-of-labour
// number: 1 / N when everybody does an equal share of everything, rising toward
// 1 as one body becomes THE feller. Everything sorted — cid, then key — so two
// runs of one seed produce byte-identical JSON.
const skillsOf = () => {
  const perBody: Record<string, { top: string | null; level: number; practiceS: Record<string, number> }> = {};
  const total = new Map<string, number>();
  const top = new Map<string, number>();
  for (const cid of [...session.bodySkills.keys()].sort()) {
    const rows = session.bodySkills.get(cid)!;
    const practiceS: Record<string, number> = {};
    let bestKey: string | null = null;
    let bestLvl = 0;
    for (const k of [...rows.keys()].sort()) {
      const p = rows.get(k)!.practiceS;
      practiceS[k] = Number(p.toFixed(1));
      total.set(k, (total.get(k) ?? 0) + p);
      if ((top.get(k) ?? 0) < p) top.set(k, p);
      const lvl = skillEffectiveLevel(session, cid, k);
      // Ties break on the KEY's sort order (the loop is already sorted), never
      // on Map insertion — a readout may not invent a ranking.
      if (lvl > bestLvl) { bestLvl = lvl; bestKey = k; }
    }
    perBody[cid] = {
      top: bestKey,
      level: Number(bestLvl.toFixed(3)),
      practiceS,
    };
  }
  const concentration: Record<string, number> = {};
  const multiplierTop: Record<string, number> = {};
  for (const k of [...total.keys()].sort()) {
    const t = total.get(k) ?? 0;
    concentration[k] = t > 0 ? Number(((top.get(k) ?? 0) / t).toFixed(3)) : 0;
    let best = 1;
    for (const cid of session.bodySkills.keys()) {
      const m = skillMultiplier(session, cid, k);
      if (m > best) best = m;
    }
    multiplierTop[k] = Number(best.toFixed(3));
  }
  return {
    bodies: perBody,
    totalPracticeS: Object.fromEntries([...total.keys()].sort().map((k) => [k, Number((total.get(k) ?? 0).toFixed(1))])),
    concentration,
    multiplierTop,
  };
};

const metrics = {
  world: WORLD_PATH,
  seed: SEED,
  dt: DT,
  days: DAYS,
  dayLengthS: dayS,
  script: SCRIPT || null,
  frames: framesDone,
  simSeconds: Number(session.townClock.toFixed(1)),
  wallMs,
  simSecondsPerWallSecond: Number((session.townClock / (wallMs / 1000)).toFixed(2)),
  bodies: lvEnd.length,
  takes,
  zeroYieldTakes: zeroYield,
  takeSizeHistogram: Object.fromEntries([...takeHist.entries()].sort((a, b) => a[0] - b[0])),
  takesOfSixOrMore: bigTakes,
  takesBySource: Object.fromEntries([...takeBySource.entries()].sort((a, b) => b[1] - a[1])),
  unitsByGoodKey: Object.fromEntries([...takeByGood.entries()].sort((a, b) => b[1] - a[1])),
  foodUnits: Number(takeUnitsFood.toFixed(2)),
  rationsPerDay: Number((takeUnitsFood / DAYS).toFixed(2)),
  // 🪨 PILES (piles-not-boxes-round.md acceptance A–C): what the settlement put
  // DOWN, what it later carried into a box, and what is standing at the end.
  stows,
  stowUnits: Number(stowUnits.toFixed(2)),
  stowsByHead: Object.fromEntries(
    [...stowByHead.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, Number(v.toFixed(2))]),
  ),
  collects,
  collectUnits: Number(collectUnits.toFixed(2)),
  pileUnitsAtEnd: pileSample(),
  parked: counts.get("parked") ?? 0,
  reselected: counts.get("reselected") ?? 0,
  sleeps: counts.get("sleeps") ?? 0,
  reaped: counts.get("reaped") ?? 0,
  haulAbandoned: counts.get("haulAbandoned") ?? 0,
  haulReissued: counts.get("haulReissued") ?? 0,
  starvationBodyDays: {
    "1.5": Number((starve15 / dayS).toFixed(2)),
    "3": Number((starve3 / dayS).toFixed(2)),
  },
  frozenBodySeconds,
  frozenEpisodes: frozen,
  constructionBeatsS: beatAt,
  hungerAtEnd: {
    mean: Number((lvEnd.reduce((a, b) => a + b, 0) / (lvEnd.length || 1)).toFixed(2)),
    hungry: lvEnd.filter((x) => x >= 1).length,
    deep: lvEnd.filter((x) => x >= 3).length,
  },
  skills: skillsOf(),
  // ⚖️ THE INTERCITY LINE (trade-topology round) — session reads per bucket.
  trade: {
    line: tradeReading(),
    partnerChanges,
    buckets: tradeBuckets,
    toasts: tradeToasts,
  },
  perDay,
  samples,
};

const out: string[] = [];
out.push(`# arc-run world=${WORLD_PATH} seed=${SEED} dt=${DT} days=${DAYS} dayS=${dayS}`);
if (SCRIPT) out.push(`# script=${SCRIPT}`);
out.push(...scriptEcho);
out.push(...lines);
out.push("");
out.push(
  `# takes=${takes} (zero-yield=${zeroYield})  ≥6u=${bigTakes}  sizes=${[...takeHist.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([u, c]) => `${u}u×${c}`)
    .join(" ")}`,
);
out.push(`# food units=${takeUnitsFood.toFixed(2)} over ${DAYS} days = ${metrics.rationsPerDay}/day`);
out.push(
  `# parked=${metrics.parked}  re-selected=${metrics.reselected}  sleeps=${metrics.sleeps}` +
    `  reaped=${metrics.reaped}  haul ABANDONED=${metrics.haulAbandoned} RE-ISSUED=${metrics.haulReissued}`,
);
out.push(
  `# starvation body-days ≥1.5=${metrics.starvationBodyDays["1.5"]}  ≥3=${metrics.starvationBodyDays["3"]}`,
);
out.push(
  `# stows=${metrics.stows} (${metrics.stowUnits} units) ` +
    `${Object.entries(metrics.stowsByHead).map(([h, n]) => `${h}:${n}`).join(" ") || "—"}` +
    `  collects=${metrics.collects} (${metrics.collectUnits} units)` +
    `  piles at end=${
      Object.entries(metrics.pileUnitsAtEnd).map(([h, n]) => `${h}:${n}`).join(" ") || "—"
    }`,
);
out.push(
  `# frozen body-seconds=${frozenBodySeconds}  episodes>${FROZEN_S}s=${frozen.length}` +
    frozen.map((f) => `\n#   ${f.cid} from t=${f.fromS.toFixed(0)} for ${f.forS}s`).join(""),
);
out.push(
  `# construction beats: ${BEATS.map((b) => `${b.key}=${beatAt[b.key] === null ? "-" : beatAt[b.key]!.toFixed(1)}`).join("  ")}`,
);
for (const b of buildToasts.slice(0, 25)) out.push(`#   ${b}`);
for (const n of notable.slice(0, 25)) out.push(`#   ${n}`);
out.push(
  `# skills concentration ${
    Object.entries(metrics.skills.concentration)
      .map(([k, v]) => `${k}=${v}`)
      .join(" ") || "(none)"
  }`,
);
out.push(
  `# skills top-multiplier ${
    Object.entries(metrics.skills.multiplierTop)
      .map(([k, v]) => `${k}=${v}×`)
      .join(" ") || "(none)"
  }`,
);
// ── THE INTERCITY LINE (trade-topology round) ──────────────────────────────
const fmtTrade = (r: TradeReading) =>
  `partner=${r.partnerKey}${r.bound ? "" : " (unbound)"} road=${r.distanceM}m` +
  ` imports=[${r.imports.join(",")}] units=${JSON.stringify(r.units)}` +
  ` rare=${r.rare.kind}×${r.rare.perVisit} exports=[${r.exports.join(",")}]`;
if (metrics.trade.line) {
  out.push(`# trade line at end: ${fmtTrade(metrics.trade.line)}`);
  out.push(
    `# trade partner changes=${partnerChanges.length}` +
      partnerChanges.map((c) => `\n#   t=${c.t.toFixed(1)} ${c.from} → ${c.to}`).join(""),
  );
  for (const b of tradeBuckets.slice(0, 40)) {
    out.push(`#   bucket ${b.bucket} @t=${b.atEdge.t.toFixed(1)}: ${fmtTrade(b.atEdge)}`);
    if (b.atEnd && JSON.stringify(b.atEnd) !== JSON.stringify({ ...b.atEdge, t: b.atEnd.t })) {
      out.push(`#     …ended @t=${b.atEnd.t.toFixed(1)}: ${fmtTrade(b.atEnd)}`);
    }
  }
  for (const l of tradeToasts.slice(0, 40)) out.push(`#   ${l}`);
} else {
  out.push(`# trade line: none (no town stage trade)`);
}
out.push(
  `# wall=${(wallMs / 1000).toFixed(1)}s  sim/wall=${metrics.simSecondsPerWallSecond}×  bodies=${metrics.bodies}`,
);

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, "arc.txt"), out.join("\n") + "\n");
fs.writeFileSync(path.join(OUT_DIR, "metrics.json"), JSON.stringify(metrics, null, 2) + "\n");
fs.writeFileSync(path.join(OUT_DIR, "console.log"), conLines.join("\n") + "\n");
run.dispose();
if (!QUIET) realLog(out.join("\n"));
realLog(`\n→ ${path.join(OUT_DIR, "arc.txt")} / metrics.json / console.log`);
