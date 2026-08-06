// server/services/dual-agent/board-merge.ts
//
// Smart-merge logic for AAC board buttons. Used when adding new buttons to
// an existing board that may already be at or near capacity — figures out
// which existing button each new one should displace (matched by
// label/glyph/sentence overlap), and preserves slot positions for the
// client's fade-in/fade-out animation.
//
// Extracted from live-relay.ts so both the legacy single-agent path and the
// three-agent path (AgentCoordinator) can call into the same logic.

export interface MergeButton {
  id?: string;
  label: string;
  iconRef?: string;
  symbolPath?: string;
  imageKey?: string;
  glyph?: string;
  glyphFallback?: string;
  sentence?: string;
  speech?: string;
  buttonType?: "guess" | "category" | "suggestion" | "narrow" | "wordfinder" | "more";
  suggestionKey?: string;
  narrowDimension?: string;
  narrowValue?: string;
  rowSpan?: number;
  colSpan?: number;
  /** Conversational role ("reply" | "bid"). Listed here so it survives the
   *  merge into currentBoardButtons and is readable on press. */
  role?: "reply" | "bid";
  /** Group-chat addressee: the peer this button is aimed at (a peer name the
   *  Board Manager set, resolved to a studentId on press), or "ROOM". Survives
   *  the merge so the press can route the utterance to the right peer. */
  addressee?: string;
  /** Launch action: pressing this button opens an app/website/pre-built board
   *  instead of voicing speech. Survives the merge so the client renders the
   *  right press behavior; also compared in `sameBoard` so a speak→launch swap
   *  re-renders. */
  open?: { website?: string; app?: string; board?: string };
}

export interface MergeReport {
  preservedIds: string[];      // prev IDs that survived untouched
  displacedIds: string[];      // prev IDs that got evicted to make room
  newIds: string[];            // freshly-minted IDs for incoming buttons
  duplicatesIgnored: number;   // incoming buttons that matched existing
}

export function exactDuplicate(a: MergeButton, b: MergeButton): boolean {
  return (
    a.label.trim().toLowerCase() === b.label.trim().toLowerCase()
    && (a.glyph || "") === (b.glyph || "")
    && (a.glyphFallback || "") === (b.glyphFallback || "")
    && (a.sentence || "").trim() === (b.sentence || "").trim()
  );
}

/**
 * True when two boards are identical in display AND behavior — same buttons, in
 * the same order. Builds on `exactDuplicate` (label/glyph/fallback/sentence) and
 * additionally compares the spoken `speech`, `buttonType`, and `addressee`,
 * which `exactDuplicate` ignores but which change what a press does.
 *
 * Used to suppress a redundant board re-push: re-sending a byte-identical board
 * re-renders the grid on the client and resets any in-progress dwell, which for
 * eye-gaze/dwell users can keep a selection from ever completing.
 */
export function sameBoard(a: MergeButton[], b: MergeButton[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (!exactDuplicate(a[i], b[i])) return false;
    if ((a[i].speech || "").trim() !== (b[i].speech || "").trim()) return false;
    if ((a[i].buttonType || "") !== (b[i].buttonType || "")) return false;
    if ((a[i].addressee || "") !== (b[i].addressee || "")) return false;
    if ((a[i].open?.website || "") !== (b[i].open?.website || "")) return false;
    if ((a[i].open?.app || "") !== (b[i].open?.app || "")) return false;
    if ((a[i].open?.board || "") !== (b[i].open?.board || "")) return false;
  }
  return true;
}

/**
 * Score how likely `incoming` is meant to REPLACE `existing`. Higher =
 * better match. 0 means no shared signature at all (we still allow
 * displacement as a last resort, but ranked behind partial matches).
 */
export function replacementScore(incoming: MergeButton, existing: MergeButton): number {
  let score = 0;
  if (incoming.label.trim().toLowerCase() === existing.label.trim().toLowerCase()) {
    score += 3;
  }
  if (incoming.glyph && incoming.glyph === existing.glyph) {
    score += 2;
  }
  if (
    incoming.sentence
    && existing.sentence
    && incoming.sentence.trim() === existing.sentence.trim()
  ) {
    score += 2;
  }
  if (
    incoming.glyphFallback
    && incoming.glyphFallback === existing.glyphFallback
  ) {
    score += 1;
  }
  return score;
}

/**
 * Merge `incoming` buttons into `prev` so the resulting board has at most
 * `maxSlots` entries. Exact duplicates are collapsed; near-matches displace
 * existing buttons in place (preserving slot index so the client's
 * fade-in/fade-out lands on the same cell); leftover incoming buttons fill
 * remaining slack and are dropped from the end if still over the cap.
 */
export function smartMergeButtons(
  prev: MergeButton[],
  incoming: MergeButton[],
  maxSlots: number,
  newId: () => string,
): { merged: MergeButton[]; report: MergeReport } {
  const report: MergeReport = {
    preservedIds: [],
    displacedIds: [],
    newIds: [],
    duplicatesIgnored: 0,
  };

  // Pass 1 — pair exact duplicates so we know which incoming items
  // collapse into existing buttons.
  const matchedPrevIdx = new Set<number>();
  const matchedNextIdx = new Set<number>();
  for (let ni = 0; ni < incoming.length; ni++) {
    for (let pi = 0; pi < prev.length; pi++) {
      if (matchedPrevIdx.has(pi)) continue;
      if (exactDuplicate(incoming[ni], prev[pi])) {
        matchedPrevIdx.add(pi);
        matchedNextIdx.add(ni);
        report.duplicatesIgnored++;
        break;
      }
    }
  }

  const toAdd = incoming
    .map((b, i) => ({ b, i }))
    .filter(({ i }) => !matchedNextIdx.has(i))
    .map(({ b }) => b);

  // Plenty of room — nothing displaced.
  if (prev.length + toAdd.length <= maxSlots) {
    const merged: MergeButton[] = [];
    for (const p of prev) {
      merged.push(p);
      if (p.id) report.preservedIds.push(p.id);
    }
    for (const b of toAdd) {
      const id = newId();
      merged.push({ ...b, id });
      report.newIds.push(id);
    }
    return { merged, report };
  }

  // Overflow — evict (prev.length + toAdd.length - max) buttons.
  // Leftover (unmatched prev) buttons are the eviction pool.
  const leftoverIndices: number[] = [];
  for (let pi = 0; pi < prev.length; pi++) {
    if (!matchedPrevIdx.has(pi)) leftoverIndices.push(pi);
  }

  // Build candidate (incoming, leftover) pairs and sort by descending score.
  // Each new button matches at most one leftover; each leftover displaces
  // at most once.
  const candidates: Array<{ addIdx: number; prevIdx: number; score: number }> = [];
  for (let ai = 0; ai < toAdd.length; ai++) {
    for (const pi of leftoverIndices) {
      candidates.push({ addIdx: ai, prevIdx: pi, score: replacementScore(toAdd[ai], prev[pi]) });
    }
  }
  candidates.sort((a, b) => b.score - a.score);

  // Pair greedy: highest scores first.
  const addToPrev = new Map<number, number>();
  const prevToAdd = new Map<number, number>();
  for (const c of candidates) {
    if (addToPrev.has(c.addIdx)) continue;
    if (prevToAdd.has(c.prevIdx)) continue;
    addToPrev.set(c.addIdx, c.prevIdx);
    prevToAdd.set(c.prevIdx, c.addIdx);
  }

  // Walk prev in order, building the merged result. A displaced prev is
  // replaced in place by its assigned incoming button so the slot index
  // (and therefore grid position) stays put — that's what makes the
  // client animation fade-out/fade-in at the same cell.
  const merged: MergeButton[] = [];
  const consumedAddIndices = new Set<number>();
  for (let pi = 0; pi < prev.length; pi++) {
    const replaceWith = prevToAdd.get(pi);
    if (replaceWith !== undefined) {
      const id = newId();
      merged.push({ ...toAdd[replaceWith], id });
      consumedAddIndices.add(replaceWith);
      report.newIds.push(id);
      if (prev[pi].id) report.displacedIds.push(prev[pi].id!);
    } else {
      merged.push(prev[pi]);
      if (prev[pi].id) report.preservedIds.push(prev[pi].id!);
    }
  }

  // Incoming buttons that didn't pair to a leftover go into remaining
  // slack (slots beyond prev.length). Over the cap → drop from the end.
  for (let ai = 0; ai < toAdd.length; ai++) {
    if (consumedAddIndices.has(ai)) continue;
    if (merged.length >= maxSlots) break;
    const id = newId();
    merged.push({ ...toAdd[ai], id });
    report.newIds.push(id);
  }

  return { merged: merged.slice(0, maxSlots), report };
}
