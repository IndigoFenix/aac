// shared/world-engine/interaction/text/speech.ts
//
// SPEECH IS READ, NEVER COMPOSED (law ②). Every creature line in the world lands
// in `state.bubbles` — the ONE display-only caption channel, written through the
// host's `sayNpcLine` chokepoint. This module DIFFS that record between frames
// and copies `text` and `glyph` BYTE-FOR-BYTE into a `SAY`. It never
// re-translates, re-cases, or tidies: garbled syntax must arrive garbled, since
// that is precisely the defect an AI tester is here to find.
//
// SILENCE IS AN EVENT (law ③). A `style:"thought"` bubble — the host's visible
// silence, "…" over a creature that took in a turn and did not answer it — comes
// out as `SILENT`, never as nothing.
//
// WHO SAID IT. The bubble record itself is the evidence, in this order:
//   1. an AVATAR anchor names the body outright;
//   2. the key's suffix (`speech:<avatarId>`, `char:<entityId>`, `eat:<cid>`, …)
//      matched against `state.avatars` under the host's own body-id spellings
//      (`<id>`, `npc_<id>`, `resident_<id>`, `pet_<id>` — quest-host avatarIdOf);
//   3. a POINT anchor, matched to a body standing within POINT_ATTRIBUTION_R of
//      it (a creature's poser point is at its own feet). `sayNpcLine` uses a
//      point anchor for most creature lines, so this branch is the common one.
// Nothing matches ⇒ the line is narrated UNATTRIBUTED rather than guessed at.
//
// VISIBILITY GATES NARRATION (§3): a line from a sealed room is not narrated,
// even though GL would draw its bubble. That divergence is recorded in §3 and in
// visibility.ts — it is a standing finding against GL, not a bug here.

import type { WorldBubble, WorldState } from "../../engine.js";
import { POINT_ATTRIBUTION_R } from "./visibility.js";
import type { TextEvent } from "./types.js";

/** What we remember about a bubble so the NEXT frame can tell "still there"
 *  from "said again". `at` is the written-at marker (local sim time). */
export interface BubbleMark {
  at: number;
  text: string;
  glyph: string;
  style: string;
}

/** The per-frame memory `diffBubbles` threads. Empty map = first frame. */
export type BubbleSnapshot = ReadonlyMap<string, BubbleMark>;

export const EMPTY_BUBBLES: BubbleSnapshot = new Map();

function markOf(b: WorldBubble): BubbleMark {
  return { at: b.at, text: b.text, glyph: b.glyph ?? "", style: b.style ?? "speech" };
}

function changed(prev: BubbleMark | undefined, next: BubbleMark): boolean {
  if (!prev) return true;
  // A REPLACED bubble under the same key is a NEW utterance — the host re-uses
  // `char:<entity>` for every line a creature speaks, so text/glyph/written-at
  // are the only three things that can tell one line from the next.
  return prev.at !== next.at || prev.text !== next.text || prev.glyph !== next.glyph || prev.style !== next.style;
}

/** The body-id spellings a bubble key's suffix may abbreviate (quest-host's
 *  `avatarIdOf`: a quest creature's body is `npc_<cid>`, a streamed resident or
 *  pet keeps its own prefix, a player's body is its participant id). */
function bodyCandidates(suffix: string): string[] {
  return [suffix, `npc_${suffix}`, `resident_${suffix}`, `pet_${suffix}`];
}

/** Which body owns this bubble — see the header for the order and why. */
export function speakerOf(state: WorldState, key: string, bubble: WorldBubble): string | null {
  if (bubble.anchor.kind === "avatar") {
    return state.avatars[bubble.anchor.id] ? bubble.anchor.id : null;
  }
  const colon = key.lastIndexOf(":");
  if (colon >= 0) {
    const suffix = key.slice(colon + 1);
    for (const id of bodyCandidates(suffix)) if (state.avatars[id]) return id;
  }
  // POINT anchor: the body standing at the point. Tight radius on purpose —
  // this attributes a line to the creature it hangs over, never to "whoever is
  // nearest in the room".
  let best: string | null = null;
  let bestD = POINT_ATTRIBUTION_R;
  for (const a of Object.values(state.avatars)) {
    const d = Math.hypot(a.x - bubble.anchor.x, a.y - bubble.anchor.y);
    if (d <= bestD) {
      bestD = d;
      best = a.id;
    }
  }
  return best;
}

export interface DiffBubblesOpts {
  /** Sim ids the §3 filter admits this frame — the narration gate. */
  inView: ReadonlySet<string>;
  /** Sim id → the latched text id a driver types. */
  textIdOf: (simId: string) => string | undefined;
  /** Narrate a bubble that resolves to NO body (a caption anchored at a point
   *  nobody stands on)? Off by default: an unattributable line in a world the
   *  viewer may not even be near is noise. */
  includeUnattributed?: boolean;
}

export interface BubbleDiff {
  events: TextEvent[];
  next: BubbleSnapshot;
  /** THE BODIES THAT ACTUALLY SPOKE this frame, as sim ids, in event order and
   *  without repeats. Only the ones that passed the §3 gate — a line the viewer
   *  could not hear is not an introduction. The session records them as
   *  "previously met" (law ⑤ rank ②): text mode narrates a line only when its
   *  speaker is in view, so hearing one IS meeting them. */
  speakers: string[];
}

/**
 * Diff `state.bubbles` against the previous frame's snapshot into `SAY`/`SILENT`
 * events. Pure: it reads the state and the snapshot, and returns the next
 * snapshot rather than mutating anything.
 */
export function diffBubbles(
  prev: BubbleSnapshot,
  state: WorldState,
  opts: DiffBubblesOpts,
): BubbleDiff {
  const next = new Map<string, BubbleMark>();
  const fresh: { key: string; bubble: WorldBubble; mark: BubbleMark }[] = [];

  for (const key of Object.keys(state.bubbles).sort()) {
    const bubble = state.bubbles[key]!;
    const mark = markOf(bubble);
    next.set(key, mark);
    if (changed(prev.get(key), mark)) fresh.push({ key, bubble, mark });
  }

  const events: TextEvent[] = [];
  const heard = new Set<string>();
  for (const { key, bubble, mark } of fresh) {
    const speaker = speakerOf(state, key, bubble);
    if (speaker) {
      if (!opts.inView.has(speaker)) continue; // §3 gate — sealed room, no line
      heard.add(speaker);
    } else if (!opts.includeUnattributed) {
      continue;
    }
    const who = speaker ? (opts.textIdOf(speaker) ?? speaker) : null;
    if (mark.style === "thought") {
      events.push({
        tag: "SILENT",
        who,
        ...(bubble.text ? { text: bubble.text } : {}),
        ...(bubble.glyph ? { glyph: bubble.glyph } : {}),
      });
    } else {
      events.push({
        tag: "SAY",
        who,
        text: bubble.text,
        ...(bubble.glyph ? { glyph: bubble.glyph } : {}),
      });
    }
  }

  return { events, next, speakers: [...heard] };
}
