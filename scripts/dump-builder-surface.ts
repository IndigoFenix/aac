/**
 * WHAT THE SENTENCE BUILDER ACTUALLY OFFERS — a plain dump of the out-of-game
 * builder's default vocabulary and of the ranked board for any partial
 * sentence. Diagnostic only: it imports the same pure surfacer the AAC's local
 * builder backend runs (`builderSurfaceFor` / `surfaceNext` over
 * `defaultBuilderNouns`), so what it prints is what a child sees.
 *
 * Every button prints as `symbol(<role-initial><weight>)`, in board order, so
 * the ranking layers (TIER + bonuses, then the frequency prior, then lexicon
 * order, then the alphabet) can be read off the output directly.
 *
 * Usage:
 *   npx tsx scripts/dump-builder-surface.ts                       # lists + the standard boards
 *   npx tsx scripts/dump-builder-surface.ts "i_me + want"         # one board
 *   npx tsx scripts/dump-builder-surface.ts --cap 17 "i_me + go"  # one page's worth
 *
 * The AAC grid is 9×2 with a More button, so the first 17 buttons ARE page one.
 */
import { LEXICON, tokenizeSentence } from "../shared/world-engine/interaction/intent/parse-intent.js";
import { defaultBuilderNouns } from "../shared/world-engine/interaction/intent/builder-surface.js";
import { AXIS_WORDS } from "../shared/world-engine/object-properties.js";
import { surfaceNext, type SurfaceNoun } from "../shared/world-engine/interaction/intent/surface-next.js";

const argv = process.argv.slice(2);
const capFlag = argv.indexOf("--cap");
const capacity = capFlag >= 0 ? Number(argv[capFlag + 1]) : 54;
// `capFlag + 1` is only a real index when the flag is present — without the
// guard a bare `dump "i_me + want"` drops its own first argument (capFlag is
// -1, so the filter excludes index 0) and silently prints the lists instead.
const sentences = argv.filter((a, i) => !a.startsWith("--") && (capFlag < 0 || i !== capFlag + 1));

const nouns = defaultBuilderNouns();
const surfNouns: SurfaceNoun[] = nouns.map((n) => ({
  symbol: n.symbol,
  kind: (n.kind ?? "unknown") as SurfaceNoun["kind"],
  affords: n.affords ?? [],
  properties: n.properties ?? [],
}));

function show(sentence: string): void {
  const s = surfaceNext(tokenizeSentence(sentence), { nouns: surfNouns, capacity });
  console.log(`\n--- "${sentence || "(empty board)"}" cap=${capacity} complete=${s.complete} open=[${s.open.join(",")}] subTab=${s.subTab ?? "-"}`);
  console.log("  buttons: " + s.buttons.map((b) => `${b.symbol}(${b.role[0]}${b.weight})`).join(" "));
  console.log("  groups:  " + s.groups.map((g) => `[${g.id}:${g.kind}:${g.weight.toFixed(1)}×${g.members.length}]`).join(" "));
}

if (sentences.length) {
  for (const s of sentences) show(s);
} else {
  console.log(`=== DEFAULT NOUNS (${nouns.length}) ===`);
  for (const n of nouns) {
    console.log(`${n.kind}\t${n.symbol}\tprops=[${(n.properties ?? []).join(",")}]\taffords=[${(n.affords ?? []).join(",")}]`);
  }
  console.log("\n=== LEXICON BY CATEGORY ===");
  const byCat: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(LEXICON)) (byCat[(v as { cat: string }).cat] ??= []).push(k);
  for (const [c, keys] of Object.entries(byCat)) console.log(`${c} (${keys.length}): ${keys.join(", ")}`);
  console.log("\n=== AXIS_WORDS ===");
  for (const [a, w] of Object.entries(AXIS_WORDS)) console.log(`${a}: ${(w as readonly string[]).join(", ")}`);
  for (const s of ["", "i_me", "i_me + want", "i_me + want + eat", "i_me + go", "you", "i_me + want + apple"]) show(s);
}
