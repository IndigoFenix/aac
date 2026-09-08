// Record the BYTE-IDENTITY GOLDEN for `compileAction` (intent-compile.ts).
//
// Run this BEFORE porting the per-verb switch to the effect table, and never
// again unless a behaviour change was deliberately ruled: the whole value of the
// fixture is that it was written by the OLD compiler.
//
//   npx tsx scripts/dev/verb-effects-golden.ts
//
// Writes server/tests/world-engine/fixtures/verb-effects-golden.json, which
// server/tests/world-engine/verb-effects.test.ts replays.
//
// 🚨 A RE-RECORD MUST EXTEND `FIXTURE_NOTE` BELOW, in the same commit, with the
// date, the ruling that authorised it, and how many cases moved. The signature
// guard stops a corpus edit from re-baselining silently; the note is what stops
// a RULED change from becoming an anonymous wall of new answers six months on.
// If you are re-recording and have nothing to add to that list, you are not
// re-baselining — you are erasing the proof.

// `--verify` replays the existing fixture instead of rewriting it (the same
// check verb-effects.test.ts runs, but with a diff you can read).

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { compileAction } from "@shared/world-engine/interaction/intent/intent-compile.js";
import {
  BINDERS,
  buildCorpus,
  canonical,
  corpusSignature,
  goldenOutputs,
  type GoldenFixture,
} from "../../server/tests/world-engine/fixtures/verb-effects-corpus.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(here, "..", "..", "server", "tests", "world-engine", "fixtures", "verb-effects-golden.json");

/**
 * THE FIXTURE'S HEADER (JSON takes no comments — this is written into the file
 * as `note`). Line 1 is the original recording; each line after it is a RULED
 * re-baseline. Append, never rewrite.
 */
const FIXTURE_NOTE: string[] = [
  "2026-09-08 · RECORDED from the PRE-PORT compiler (the 22-arm switch in compileBareAction), " +
    "semantic-engine round B1. Every answer here was written by the code the effect table replaced.",
  "2026-09-08 · RE-BASELINED, 279 of 44,492 cases (0.63%) — the ONE deliberate re-baseline of this round " +
    "(B5b; ruling recorded in planning-docs/games/world-engine/semantic-engine-round.md, B5a's 🚨 residual). " +
    "REASON: `with` marks COMPANY, never an ENDPOINT. The parser gives the `target` slot to the LAST " +
    "relation-marked noun, so a companion sat where the destination belonged and every endpoint reading of " +
    "`target` STOLE the place the child said: `go + home + with + mara` compiled to goTo{mara}, " +
    "`go + to + kitchen + with + mara` to goTo{mara}. The endpoint readings (movement's `dest`, " +
    "stay/wait/stop's optional place, follow/chase's pursued creature) now read the sentence as if the " +
    "`with` phrase were absent, and the partner rides `CompiledIntent.companions` instead. " +
    "Partner-shaped verbs (talk/help/hug/trade/play/give/put/throw/drop/show) are UNCHANGED — there the " +
    "`with` phrase names the argument itself. The 279 are all `with`-marked movement shapes: " +
    "goTo{companion} ⇒ goHome / goTo{the place actually said} / null, stay{companion} ⇒ stay{undefined}, " +
    "follow{companion} ⇒ null. No other shape moved.",
  "2026-09-08 · RE-BASELINED, 39 of 44,492 cases (0.09%) — the SECOND ruled re-baseline of this round " +
    "(B5c; ruling recorded in planning-docs/games/world-engine/semantic-engine-round.md, B5b's ⚠️ residual). " +
    "REASON: semantic-behavior.md §7 — a well-formed sentence must never read as \"not understood\". Once " +
    "`with` stopped being an endpoint, a movement order that named COMPANY and no destination matched no row " +
    "at all (`go/come/run + with + mara`, `follow + with + mara` ⇒ null ⇒ unbound). Moving WITH somebody IS " +
    "moving alongside them, so one ACCOMPANY_ROW (guards hasBound:with + no:endpoint + creature:with, " +
    "target = creature(with)) now sits at the END of go/come/run/follow/chase and ABOVE `return`'s bare " +
    "home row. Three groups: null ⇒ follow{mara} 32 (go 16, chase/come/follow/run 4 each); goHome ⇒ " +
    "follow{mara} 4 (bare `return` + with — the company is what the sentence states, home is only where a " +
    "BARE return would have gone); null ⇒ follow{box} 3 (the KIND-BLIND binder family alone, where a box " +
    "binds as a creature — under every classifier-backed binder `go + with + box` stays null, as does any " +
    "binder answering isCompanion false). An endpoint still always wins, and stay/wait/stop are untouched.",
];

const cases = buildCorpus();
const outputs: string[] = [];
const tally = new Map<string, number>();

for (const c of cases) {
  const binder = BINDERS[c.binder];
  if (!binder) throw new Error(`unknown binder key: ${c.binder}`);
  const goal = compileAction(c.frame, binder);
  outputs.push(canonical(goal));
  const kind = goal ? goal.kind : "(null)";
  tally.set(kind, (tally.get(kind) ?? 0) + 1);
}

if (process.argv.includes("--verify")) {
  const fixture = JSON.parse(readFileSync(OUT, "utf8")) as GoldenFixture;
  const want = goldenOutputs(fixture);
  const sig = corpusSignature(cases);
  console.log(`corpus cases : ${cases.length}`);
  console.log(`signature    : ${sig === fixture.signature ? "MATCH" : `DRIFT (fixture ${fixture.signature}, corpus ${sig})`}`);
  let bad = 0;
  const shown: string[] = [];
  for (let i = 0; i < cases.length; i++) {
    if (outputs[i] === want[i]) continue;
    bad++;
    if (shown.length < 25) shown.push(`  ${cases[i]!.id}\n    want ${want[i]}\n    got  ${outputs[i]}`);
  }
  console.log(`mismatches   : ${bad}`);
  for (const s of shown) console.log(s);
  process.exit(bad === 0 && sig === fixture.signature ? 0 : 1);
}

const dict: string[] = [];
const dictIndex = new Map<string, number>();
const index = outputs.map((o) => {
  let i = dictIndex.get(o);
  if (i === undefined) {
    i = dict.length;
    dict.push(o);
    dictIndex.set(o, i);
  }
  return i;
});

const fixture: GoldenFixture = {
  corpusSize: cases.length,
  signature: corpusSignature(cases),
  note: FIXTURE_NOTE,
  dict,
  index,
};

mkdirSync(path.dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(fixture), "utf8");

const nonNull = outputs.filter((o) => o !== "null").length;
console.log(`corpus cases : ${cases.length}`);
console.log(`signature    : ${fixture.signature}`);
console.log(`non-null     : ${nonNull} (${((nonNull / cases.length) * 100).toFixed(1)}%)`);
console.log(`distinct out : ${new Set(outputs).size}`);
console.log("goal kinds   :");
for (const [k, n] of [...tally.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(14)} ${n}`);
console.log(`written      : ${OUT}`);
