/**
 * One-shot migration of authored blueprints to the reworked NOSE dials.
 *
 *   noseHeight        → nosePosition   (rename only)
 *   noseRadiusFrac    was a fraction of the HEAD radius; it is now a fraction
 *                     of THE SURFACE THE NOSE SITS ON. Re-derived per
 *                     blueprint so each nose keeps the thickness it had.
 *   noseTaper         new; 0.45 reproduces the old hardcoded `1 − 0.55·f`.
 *   noseFlatten       new; 1 reproduces the old circular cross-section.
 *
 * The host radius is not a constant — it depends on where the nose sits on the
 * dorsal rail and what the skull looks like there — so this BUILDS each
 * skeleton and reads the real value rather than guessing a factor. That means
 * running it against the NEW skeleton code with the OLD data, which is exactly
 * the state the repo is in when the migration runs.
 *
 * Usage: npx tsx scripts/convert-nose-dials.ts <file.ts> [...]
 */
import { promises as fs } from "fs";
import { clampBlueprint } from "../shared/world-engine/creatures/blueprint.js";
import { buildSkeleton } from "../shared/world-engine/creatures/skeleton.js";

/** `1 − 0.55·f` at the tip — the taper every nose used to get for free. */
const OLD_TAPER = 0.45;

/** Yield the [start, end) span of each `head: { … }` object literal body. */
function* headBlocks(src: string): Generator<[number, number]> {
  const re = /["']?head["']?\s*:\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    let depth = 0;
    for (let i = m.index + m[0].length - 1; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}") {
        depth--;
        if (depth === 0) {
          yield [m.index + m[0].length, i];
          break;
        }
      }
    }
  }
}

const numOf = (block: string, key: string): number | null => {
  const m = new RegExp(`["']?${key}["']?\\s*:\\s*(-?[\\d.eE+]+)`).exec(block);
  return m ? Number(m[1]) : null;
};
const fmt = (v: number): string => String(Number(v.toFixed(4)));

/** The host half-thickness under this head's nose root, in head radii. */
function hostFracFor(head: Record<string, number>): number | null {
  // A nose needs a length to have a root at all.
  if (!head.noseLengthFrac) return null;
  const bp = clampBlueprint({ head } as Record<string, unknown>);
  const skel = buildSkeleton(bp);
  const nose0 = skel.bones.find((b) => b.id === "nose0");
  const gd = skel.skull;
  const lm = skel.head;
  if (!nose0 || !gd || !lm) return null;
  const X = { x: 1, y: 0, z: 0 };
  let best = Infinity;
  let r = gd.cranium.ry;
  for (const pr of [gd.cranium, ...gd.stations]) {
    const ux = pr.dir.y * X.z - pr.dir.z * X.y;
    const uy = pr.dir.z * X.x - pr.dir.x * X.z;
    const uz = pr.dir.x * X.y - pr.dir.y * X.x;
    const ul = Math.hypot(ux, uy, uz) || 1;
    const rel = {
      x: nose0.head.x - pr.center.x,
      y: nose0.head.y - pr.center.y,
      z: nose0.head.z - pr.center.z,
    };
    const onU = (rel.x * ux + rel.y * uy + rel.z * uz) / ul;
    const onD = rel.x * pr.dir.x + rel.y * pr.dir.y + rel.z * pr.dir.z;
    const q = Math.hypot(rel.x / pr.rx, onU / pr.ry, onD / pr.halfLen);
    if (Math.abs(q - 1) < best) {
      best = Math.abs(q - 1);
      r = Math.min(pr.rx, pr.ry);
    }
  }
  return r / lm.radius;
}

async function convert(path: string): Promise<void> {
  const src = await fs.readFile(path, "utf8");
  const out: string[] = [];
  let pos = 0;
  let done = 0;
  let skipped = 0;
  for (const [start, end] of headBlocks(src)) {
    const block = src.slice(start, end);
    if (numOf(block, "noseHeight") === null && numOf(block, "noseRadiusFrac") === null) {
      skipped++;
      continue;
    }
    // Read the whole head so a PARTIAL blueprint still builds correctly —
    // clampBlueprint fills anything absent with the default.
    const head: Record<string, number> = {};
    for (const m of block.matchAll(/["']?([A-Za-z]+)["']?\s*:\s*(-?[\d.eE+]+)/g)) {
      head[m[1]] = Number(m[2]);
    }
    if (head.noseHeight !== undefined) head.nosePosition = head.noseHeight;
    const hostFrac = hostFracFor(head);
    let next = block;
    if (hostFrac !== null && hostFrac > 1e-6 && head.noseRadiusFrac !== undefined) {
      const scaled = Math.min(1.2, Math.max(0.05, head.noseRadiusFrac / hostFrac));
      next = next.replace(/(["']?noseRadiusFrac["']?\s*:\s*)-?[\d.eE+]+/, (_, p1: string) => p1 + fmt(scaled));
    }
    // Rename in place so the field keeps its position in the literal.
    next = next.replace(/(["']?)noseHeight\1(\s*:)/, (_, q: string, tail: string) => `${q}nosePosition${q}${tail}`);
    // The two new dials go next to the rename, reproducing the old look.
    const quote = /"noseRadiusFrac"/.test(next) ? '"' : "";
    next = next.replace(
      new RegExp(`(${quote}nosePosition${quote}\\s*:\\s*-?[\\d.eE+]+)`),
      (_, kept: string) =>
        `${kept},\n    ${quote}noseTaper${quote}: ${OLD_TAPER},\n    ${quote}noseFlatten${quote}: 1`,
    );
    out.push(src.slice(pos, start), next);
    pos = end;
    done++;
  }
  out.push(src.slice(pos));
  if (done) await fs.writeFile(path, out.join(""), "utf8");
  console.log(`  ${path}: ${done} head block(s) converted, ${skipped} skipped`);
}

for (const p of process.argv.slice(2)) await convert(p);
