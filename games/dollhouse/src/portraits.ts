// games/dollhouse/src/portraits.ts
//
// THE PORTRAIT DESK — word → a picture of the creature that word NAMES.
//
// The builder offers a button for every person and pet the child can see, keyed
// by their NAME ("mara", "biscuit"). No lexicon holds a name and no artist drew
// one, so those buttons fell through the glyph compositor's resolver to the "❓"
// placeholder. Here the game bakes each named body's own head into a PNG
// (world-engine creatures/portrait.ts) and hands it to the resolver under that
// same word — the picture is DISPLAY-side, the key stays the word, and the
// sentence the child builds is unchanged.
//
// Baking is deferred and rationed: one body per idle tick, because a species +
// wardrobe the town never warmed pays a real loft on its first portrait, and a
// board icon must never cost a dropped frame of play. The GL context is a
// visitor — opened on the first bake of a batch, released when the queue drains.
//
// The species+outfit each name wears is the HOST's answer (FamilyHudEntry's
// `species`/`outfit`), never re-derived here: the portrait must show the body
// standing in the room, not a plausible guess at it.

import {
  bakeCreaturePortrait,
  disposeCreaturePortraitRenderer,
  portraitKey,
  type CreaturePortraitSpec,
} from "@shared/world-engine/creatures/portrait";

/** One creature to draw: the word it is offered under + the body it wears. */
export interface PortraitRequest extends CreaturePortraitSpec {
  /** The builder word this picture belongs to (lower-case, as the noun list keys it). */
  symbol: string;
}

/** Bakes per idle tick. One: a cold body's loft is tens of milliseconds, and
 *  there are only ever a handful of named creatures in a household. */
const PER_TICK = 1;

/** How long a bake may wait for a quiet frame before taking one anyway (ms). */
const IDLE_DEADLINE_MS = 600;

// Baked art, twice keyed: by BODY (two residents in one species + preset share a
// bake) and by WORD (what the resolver asks with). A body that failed to bake is
// remembered as null so it is never retried in a loop.
const artByBody = new Map<string, string | null>();
const artByWord = new Map<string, string>();
const queued = new Set<string>();
const queue: PortraitRequest[] = [];
let draining = false;
let listener: ((added: ReadonlyArray<{ symbol: string; url: string }>) => void) | null = null;

/** Next quiet moment — but with a DEADLINE.
 *
 *  A world-engine game renders every frame it is given, so on anything slower
 *  than a fast desktop the main thread is never idle by the browser's
 *  definition and a bare `requestIdleCallback` is starved forever. That is not a
 *  slow portrait, it is NO portrait: the buttons keep their "❓" for the whole
 *  session. The timeout makes idle a preference rather than a condition. */
function onIdle(fn: () => void): void {
  const ric = (globalThis as {
    requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => void;
  }).requestIdleCallback;
  if (ric) ric(fn, { timeout: IDLE_DEADLINE_MS });
  else setTimeout(fn, 16);
}

/** The picture for a builder word, or null while (or if) it has none. */
export function portraitFor(symbol: string): string | null {
  return artByWord.get(symbol.toLowerCase()) ?? null;
}

/** Called with each freshly-baked batch: the standalone board repaints, the
 *  embedded one ships them to the platform. One listener — the game has one. */
export function onPortraitsBaked(fn: (added: ReadonlyArray<{ symbol: string; url: string }>) => void): void {
  listener = fn;
}

function drain(): void {
  const added: Array<{ symbol: string; url: string }> = [];
  for (let n = 0; n < PER_TICK && queue.length; n++) {
    const req = queue.shift()!;
    const bodyKey = portraitKey(req);
    const known = artByBody.get(bodyKey);
    const url: string | null = known !== undefined ? known : bakeCreaturePortrait(req);
    if (known === undefined) artByBody.set(bodyKey, url);
    if (url) {
      artByWord.set(req.symbol, url);
      added.push({ symbol: req.symbol, url });
    }
  }
  if (added.length) listener?.(added);
  if (queue.length) {
    onIdle(drain);
    return;
  }
  // Drained: hand the GL context back. A later request opens a fresh one.
  draining = false;
  disposeCreaturePortraitRenderer();
}

/**
 * Ask for portraits of these creatures. Idempotent and cheap to call every time
 * the family strip changes: a word already drawn (or already queued) is skipped,
 * so only a genuinely new body ever costs a bake.
 */
export function requestPortraits(reqs: readonly PortraitRequest[]): void {
  let fresh = false;
  for (const req of reqs) {
    const symbol = req.symbol.toLowerCase();
    if (!symbol || !req.speciesId) continue;
    if (artByWord.has(symbol) || queued.has(symbol)) continue;
    queued.add(symbol);
    queue.push({ ...req, symbol });
    fresh = true;
  }
  if (!fresh || draining) return;
  draining = true;
  onIdle(drain);
}
