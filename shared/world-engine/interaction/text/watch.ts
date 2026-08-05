// shared/world-engine/interaction/text/watch.ts
//
// WATCHING (design §6 / D6). `watch <id>` upgrades ONE subject from crowd
// summary to per-event narration. Three rules shape the whole module:
//
//   • A WATCH NEVER GRANTS VISIBILITY. It changes how much of what you can
//     already see gets said — never what you can see. A watched body inside a
//     sealed house is silent, exactly like an unwatched one, and the moment it
//     leaves view it emits ONE `EXIT` (with the visible transit) and then
//     nothing at all. The watch PERSISTS across that silence and re-fires
//     `ENTER` on return, which is what makes it worth having.
//   • DELTAS ARE HYSTERETIC. A body walking a street changes its exact bearing
//     every frame; nobody narrates that. `MOVED` fires on a BAND change, a SPACE
//     change, or a bearing swing of at least 90° from the last one reported —
//     stated in degrees on purpose, because the four-word cardinal vocabulary
//     turns a 2° drift across a boundary into a "direction change" it isn't.
//   • HANDS COME FROM `carriedBy`, NEVER `carryOf()`. The latter merges the
//     contents of bags the eye cannot see into one number; a renderer draws the
//     thing IN THE HAND, so that is what `HOLD` reports.
//
// `STOCK` is the gated one: what a container holds is narrated only while its
// lid is open AND it is in view — the lid is the thing the eye actually reads.
//
// ── ENTER / EXIT ARE BROADER THAN THE WATCH LIST, AND BOUNDED ───────────────
// Step ⑨ wants arrivals and departures narrated during a walk. But law ⑤ governs
// the STREAM as much as the scene: a town of 54 bodies streaming past would
// bury the transcript in comings and goings of people the driver has never
// heard of. So presence is diffed over a TRACKED set the caller composes —
// watched bodies, the travel target, and anyone law ⑤ would already have NAMED
// (a conversation member, a body with a name, one previously met, one the
// driver has asked about). Anonymous crowd stays crowd, in the stream as in the
// scene. The caller owns that set; this module only diffs it.
//
// Pure: no clock, no host, no world reads of its own — a scene in, events out.

import { activityKey } from "./summarize.js";
import {
  MOVED_SWING_DEG,
  WATCH_CAP,
  type TextEvent,
  type VisibleScene,
  type VisibleSubject,
} from "./types.js";

/** What one frame of a tracked subject looked like — the comparison basis for
 *  the next frame's deltas. Everything in it is renderer-visible. */
export interface WatchSample {
  band: string;
  cardinal: string;
  /** Raw bearing in degrees, when the scene supplied one. */
  bearing?: number;
  space: string | null;
  /** `activityKey` of the (verb, object) pair, or "" for idle. */
  activity: string;
  /** The activity, already worded by the caller — the DOING payload. */
  activityPhrase: string;
  /** Text ids in the hands, joined — `carriedBy` and nothing else. */
  holding: string;
  /** The appearance signature (visibility.ts `dressSignature`). */
  dress: string;
  /** The dress worded, when there is one — the WEAR payload. */
  dressWord: string;
  /** Objects: the lid, as a boolean the eye can read. */
  open?: boolean;
  /** Objects: what an OPEN container visibly holds, as text ids, joined. */
  contains?: string;
}

export interface WatchDeps {
  /** Sim id → the text id the transcript prints. */
  label: (simId: string) => string;
  /** The (verb, object) pair, already worded and localized by the caller. */
  activityPhrase: (a: { verb: string; object?: string } | undefined) => string | undefined;
  /** Watches held at once. Default `WATCH_CAP`. */
  cap?: number;
}

export interface WatchStepCtx {
  /** Sim ids whose comings and goings are narrated (see the header). Always a
   *  superset of the watch list. */
  tracked: ReadonlySet<string>;
  /** THE VISIBLE TRANSIT for a body that just left view: the whole trailing
   *  phrase ("into the blue house"), or undefined when the exit was not a
   *  doorway the viewer could read. The caller owns it because naming a
   *  building needs the world, and this module is pure over the scene. */
  transitOf?: (simId: string, prevSpace: string | null) => string | undefined;
}

export type WatchAdd = "added" | "already" | "full";

export interface WatchBook {
  add(simId: string): WatchAdd;
  remove(simId: string): boolean;
  /** Drop every watch. Returns how many there were. */
  clear(): number;
  has(simId: string): boolean;
  /** Sim ids, in the order they were watched. */
  ids(): string[];
  /** The set law ⑤ promotes at rank ①. */
  set(): ReadonlySet<string>;
  /** ONE FRAME. Returns the deltas, in the order they are narrated. */
  step(scene: VisibleScene, ctx: WatchStepCtx): TextEvent[];
  /** Forget every presence baseline (a fresh world, a re-boot). */
  reset(): void;
}

/** Smallest signed angle between two bearings, degrees. */
export function swing(a: number, b: number): number {
  let d = ((b - a) % 360 + 540) % 360 - 180;
  return Math.abs(d);
}

/** The frame-to-frame comparison basis for one subject. */
export function sampleOf(
  s: VisibleSubject,
  deps: Pick<WatchDeps, "label" | "activityPhrase">,
): WatchSample {
  const phrase = deps.activityPhrase(s.activity);
  return {
    band: s.band,
    cardinal: s.cardinal,
    ...(s.bearing !== undefined ? { bearing: s.bearing } : {}),
    space: s.space,
    activity: s.activity ? activityKey(s.activity) : "",
    activityPhrase: phrase ?? "",
    holding: s.holding.map(deps.label).join(", "),
    dress: s.appearance.join("|"),
    dressWord: s.dress ?? "",
    ...(s.open !== undefined ? { open: s.open >= 0.5 } : {}),
    ...(s.contains !== undefined ? { contains: s.contains.map(deps.label).join(", ") } : {}),
  };
}

/** THE DELTA TABLE (§6), in narration order. Pure over two samples. */
export function watchDeltas(
  prev: WatchSample,
  next: WatchSample,
  s: VisibleSubject,
  who: string,
): TextEvent[] {
  const out: TextEvent[] = [];

  if (prev.activity !== next.activity) {
    out.push({ tag: "DOING", who, activity: next.activityPhrase || "doing nothing" });
  }

  const bandMoved = prev.band !== next.band;
  const spaceMoved = prev.space !== next.space;
  const swung =
    prev.bearing !== undefined && next.bearing !== undefined
      ? swing(prev.bearing, next.bearing) >= MOVED_SWING_DEG
      : prev.cardinal !== next.cardinal;
  if (bandMoved || spaceMoved || swung) {
    out.push({ tag: "MOVED", who, band: s.band, cardinal: s.cardinal });
  }

  if (prev.holding !== next.holding) {
    out.push({ tag: "HOLD", who, what: next.holding || null });
  }

  if (prev.dress !== next.dress) {
    out.push({ tag: "WEAR", who, what: next.dressWord || "something else" });
  }

  if (prev.open !== next.open && next.open !== undefined) {
    out.push({ tag: "OPEN", what: who, open: next.open });
  }

  // §6's GATED delta: contents are readable only through an open lid, and
  // `VisibleSubject.contains` is populated only then — so an absent `contains`
  // is "shut", not "empty", and must never narrate as a change.
  if (next.contains !== undefined && prev.contains !== undefined && prev.contains !== next.contains) {
    out.push({ tag: "STOCK", what: who, items: next.contains ? next.contains.split(", ") : [] });
  }

  return out;
}

export function createWatchBook(deps: WatchDeps): WatchBook {
  const cap = deps.cap ?? WATCH_CAP;
  /** Insertion-ordered — `watching` lists them in the order they were taken. */
  const watched = new Set<string>();
  const samples = new Map<string, WatchSample>();
  /** Tracked subjects currently in view. */
  const present = new Set<string>();
  /** Subjects whose presence baseline has been established. The FIRST frame a
   *  subject is tracked is silent in both directions: watching somebody already
   *  standing in front of you is not an arrival, and watching somebody out of
   *  sight is not a departure. */
  const based = new Set<string>();

  const forget = (id: string): void => {
    samples.delete(id);
    present.delete(id);
    based.delete(id);
  };

  return {
    add(simId) {
      if (watched.has(simId)) return "already";
      if (watched.size >= cap) return "full";
      watched.add(simId);
      return "added";
    },
    remove(simId) {
      if (!watched.delete(simId)) return false;
      forget(simId);
      return true;
    },
    clear() {
      const n = watched.size;
      for (const id of [...watched]) forget(id);
      watched.clear();
      return n;
    },
    has: (simId) => watched.has(simId),
    ids: () => [...watched],
    set: () => watched,
    reset() {
      samples.clear();
      present.clear();
      based.clear();
    },

    step(scene, ctx) {
      // PLACES ARE WATCHABLE TOO. `watch house-2` resolves against the whole
      // scene (subjects AND places), so building the in-view map from subjects
      // alone made a watched building permanently absent: never present, so
      // never an ENTER, never an EXIT, never a delta — the watch was accepted
      // and then silently inert, which is the one thing a watch may not be.
      const inView = new Map([...scene.subjects, ...scene.places].map((s) => [s.id, s]));
      const out: TextEvent[] = [];

      for (const id of ctx.tracked) {
        const s = inView.get(id);
        if (!based.has(id)) {
          // Baseline only — silent by construction (see `based`).
          based.add(id);
          if (s) {
            present.add(id);
            samples.set(id, sampleOf(s, deps));
          }
          continue;
        }
        if (!s) continue; // out of view: the EXIT pass below owns it
        const next = sampleOf(s, deps);
        if (!present.has(id)) {
          present.add(id);
          samples.set(id, next);
          out.push({ tag: "ENTER", who: deps.label(id), where: `${s.band} ${s.cardinal}` });
          continue;
        }
        const prev = samples.get(id);
        if (prev && watched.has(id)) out.push(...watchDeltas(prev, next, s, deps.label(id)));
        samples.set(id, next);
      }

      // …then the leavers. ONE `EXIT`, with the transit when the viewer could
      // read it, and silence afterwards — the watch itself survives.
      for (const id of [...present]) {
        if (inView.has(id)) continue;
        present.delete(id);
        const prev = samples.get(id);
        const via = ctx.transitOf?.(id, prev?.space ?? null);
        out.push({
          tag: "EXIT",
          who: deps.label(id),
          ...(via ? { via } : prev ? { where: `${prev.band} ${prev.cardinal}` } : {}),
        });
      }

      return out;
    },
  };
}
