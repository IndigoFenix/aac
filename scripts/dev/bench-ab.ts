// scripts/dev/bench-ab.ts — THE BENCH, RECORDED AND A/B'd.
//
// THE BENCH is one fixed play arc — the dollhouse default world, seed 12,
// dt 1/20, the commands in `scripts/dev/bench-cmds.txt`, NO `--cheats` — whose
// transcript is byte-identical below the `# ───` fence for a given build
// (text-mode.md §5). Every lane that changes sim behaviour records it and
// diffs against the checked-in reference; a lane that changes nothing must
// produce zero lines of diff.
//
//   npx tsx scripts/dev/bench-ab.ts                       record ×2, diff vs ref
//   npx tsx scripts/dev/bench-ab.ts --ref transcripts/jx-doll-bench.txt
//   npx tsx scripts/dev/bench-ab.ts --revert my-lane.patch     the A/B
//
// 🚨 THE A/B NEVER USES `git stash`. `--revert <patch>` records the tree as it
// stands (arm A), `git apply -R`s the patch, records again (arm B), then
// `git apply`s it back and PROVES the restoration by sha1 of every file the
// patch touches — taken before the revert and again after the re-apply. If a
// sha1 does not come back, the run says so loudly and stops; nothing is
// silently dropped on the floor the way a stash can.

import { execSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const argv = process.argv.slice(2);
const arg = (k: string, d: string): string => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1]! : d;
};
const has = (k: string) => argv.includes(`--${k}`);

const SEED = arg("seed", "12");
const DT = arg("dt", "1/20");
const SCRIPT = arg("script", "scripts/dev/bench-cmds.txt");
const REF = arg("ref", "transcripts/jx-doll-bench.txt");
const REVERT = arg("revert", "");
const KEEP = has("keep");
const OUT_DIR = arg("out", path.join(os.tmpdir(), "bench-ab"));
const WORLD = arg("world", "");

/** Everything above this line is run metadata (build sha, timestamp) and is
 *  EXCLUDED from every diff — text-mode.md §5's determinism law. */
const FENCE = /^#\s*[─━-]{4,}/;

const body = (file: string): string[] => {
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  const i = lines.findIndex((l) => FENCE.test(l));
  return i >= 0 ? lines.slice(i + 1) : lines;
};

const sha1 = (file: string): string =>
  fs.existsSync(file)
    ? crypto.createHash("sha1").update(fs.readFileSync(file)).digest("hex")
    : "ABSENT";

const sh = (cmd: string): string => execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/** One bench recording → the transcript path. */
function record(tag: string): string {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const out = path.join(OUT_DIR, `bench-${tag}.txt`);
  const world = WORLD ? ` --world ${WORLD}` : "";
  const cmd = `npm run world:text -- --seed ${SEED} --dt ${DT} --script ${SCRIPT}${world} --transcript ${out}`;
  const t0 = Date.now();
  try {
    sh(cmd);
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    console.error(`✖ recording ${tag} failed:\n${err.stderr ?? ""}\n${(err.stdout ?? "").slice(-2000)}`);
    process.exit(1);
  }
  console.log(`  recorded ${tag} in ${((Date.now() - t0) / 1000).toFixed(1)}s → ${out}`);
  return out;
}

/** A line-level diff of two transcript BODIES. Not a patch — a count and a
 *  readable sample, which is what a bench verdict needs. */
function diffBodies(a: string[], b: string[], labelA: string, labelB: string): number {
  const n = Math.max(a.length, b.length);
  const rows: string[] = [];
  let changed = 0;
  for (let i = 0; i < n; i++) {
    if (a[i] === b[i]) continue;
    changed++;
    if (rows.length < 40) {
      if (a[i] !== undefined) rows.push(`  -${labelA} ${i + 1}| ${a[i]}`);
      if (b[i] !== undefined) rows.push(`  +${labelB} ${i + 1}| ${b[i]}`);
    }
  }
  if (changed === 0) console.log(`  ✔ identical (${a.length} lines below the fence)`);
  else {
    console.log(`  ✖ ${changed} differing line position(s) of ${n}:`);
    for (const r of rows) console.log(r);
    if (changed * 2 > rows.length) console.log(`  … (${changed} total)`);
  }
  return changed;
}

/** The files a patch touches, per git itself. */
function patchFiles(patch: string): string[] {
  const out = sh(`git apply --numstat "${patch}"`);
  return out
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => l.split(/\t/).pop()!.trim())
    .filter(Boolean);
}

// ── ① DETERMINISM: the same tree, recorded twice ────────────────────────────
console.log(`THE BENCH — world=${WORLD || "games/dollhouse (world-text default)"} seed=${SEED} dt=${DT} script=${SCRIPT}`);
console.log(`\n① determinism (two recordings of the SAME tree)`);
const a1 = record("a1");
const a2 = record("a2");
const detDiff = diffBodies(body(a1), body(a2), "a1", "a2");
if (detDiff > 0) console.log(`  🚨 the bench is NOT deterministic on this tree — every verdict below is void.`);

// ── ② vs THE REFERENCE ──────────────────────────────────────────────────────
console.log(`\n② this tree vs the reference ${REF}`);
let refDiff = -1;
if (!fs.existsSync(REF)) console.log(`  (no reference at ${REF} — skipped)`);
else refDiff = diffBodies(body(REF), body(a1), "ref", "now");

// ── ③ THE A/B ───────────────────────────────────────────────────────────────
let verdict = "";
if (REVERT) {
  console.log(`\n③ A/B against ${REVERT} (arm A = tree as it stands, arm B = patch reverted)`);
  const files = patchFiles(REVERT);
  const before = new Map(files.map((f) => [f, sha1(f)] as const));
  console.log(`  patch touches ${files.length} file(s); sha1 recorded`);
  sh(`git apply -R "${REVERT}"`);
  let b1 = "";
  try {
    b1 = record("b1");
  } finally {
    sh(`git apply "${REVERT}"`);
  }
  const bad = files.filter((f) => sha1(f) !== before.get(f));
  if (bad.length) {
    console.log(`  🚨 RESTORATION FAILED — sha1 changed for: ${bad.join(", ")}`);
    process.exitCode = 1;
  } else console.log(`  ✔ restored: every touched file's sha1 matches the pre-revert value`);
  const d = diffBodies(body(b1), body(a1), "B(reverted)", "A(tree)");
  verdict = d === 0 ? "NO BEHAVIOURAL CHANGE (the patch is bench-silent)" : `${d} line position(s) moved by the patch`;
  console.log(`  verdict: ${verdict}`);
}

// ── SUMMARY ─────────────────────────────────────────────────────────────────
console.log(`\nSUMMARY`);
console.log(`  determinism : ${detDiff === 0 ? "PASS" : `FAIL (${detDiff})`}`);
console.log(`  vs reference: ${refDiff < 0 ? "n/a" : refDiff === 0 ? "clean" : `${refDiff} line(s) differ`}`);
if (REVERT) console.log(`  A/B         : ${verdict}`);
console.log(`  recordings  : ${OUT_DIR}${KEEP ? " (kept)" : ""}`);
if (detDiff > 0) process.exitCode = 1;
