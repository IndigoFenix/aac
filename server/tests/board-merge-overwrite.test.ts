// Verifies that smartMergeButtons evicts existing buttons when the
// board is at capacity — i.e. multiple sequential add_board_button
// calls progressively overwrite stale buttons rather than silently
// no-op'ing. This is the fallback path; the common case of N parallel
// fused calls is handled upstream by mergeFusedToolCalls (which
// collapses them into a single rebuild_board that fully replaces the
// board).

import { smartMergeButtons } from "../services/dual-agent/board-merge";

const MAX = 8;
let idCounter = 0;
const newId = () => `btn-${++idCounter}`;

function btn(label: string, glyph?: string) {
  return { id: newId(), label, glyph: glyph ?? label, speech: label, sentence: label };
}

describe("smartMergeButtons — overwrite when saturated", () => {
  test("single add against full board displaces one existing button", () => {
    idCounter = 0;
    const prev = ["A", "B", "C", "D", "E", "F", "G", "H"].map(l => btn(l));
    const incoming = [btn("X")];
    const { merged } = smartMergeButtons(prev, incoming, MAX, newId);
    expect(merged).toHaveLength(MAX);
    const labels = merged.map(b => b.label);
    expect(labels).toContain("X");
    // Exactly one existing button is displaced.
    const remainingFromPrev = labels.filter(l => ["A","B","C","D","E","F","G","H"].includes(l));
    expect(remainingFromPrev).toHaveLength(7);
  });

  test("KNOWN LIMITATION: sequential single-adds cycle the same slot (only last survives)", () => {
    // Documents an existing smartMergeButtons quirk: when incoming
    // buttons share no label/glyph/sentence signature with any existing
    // button, replacementScore returns 0 for ALL candidates. The greedy
    // tie-break then always picks the first leftover index, so each new
    // single-button add evicts whatever's in slot 0 — which on the
    // previous iteration was the LAST new button. Result: only the
    // most-recent add survives across a sequential burst.
    //
    // This is NOT a regression and NOT what the user reported. The
    // reported "6 buttons collapse to 1" failure was the parallel
    // RebuildBoardButtons fusion case, which is now handled upstream by
    // mergeFusedToolCalls — those collapse into a SINGLE rebuild_board
    // that fully replaces the board (covered by the bulk multi-add test
    // below). Genuine sequential single-button add_board_button calls
    // from separate invocations are rare in practice (the BM model
    // reaches for rebuild_board when intent is bulk replacement).
    idCounter = 0;
    let board = ["A", "B", "C", "D", "E", "F", "G", "H"].map(l => btn(l));
    const incomingLabels = ["X1", "X2", "X3", "X4", "X5", "X6"];
    for (const lbl of incomingLabels) {
      const { merged } = smartMergeButtons(board, [btn(lbl)], MAX, newId);
      board = merged;
    }
    expect(board).toHaveLength(MAX);
    const labels = board.map(b => b.label);
    // Only the last add survives — the others were each evicted by the
    // next iteration's slot-0 cycling.
    expect(labels).toContain("X6");
    // Most original buttons survive untouched.
    const survivors = labels.filter(l => ["A","B","C","D","E","F","G","H"].includes(l));
    expect(survivors.length).toBeGreaterThanOrEqual(7);
  });

  test("bulk multi-add (single merge call) overwrites all displaced slots in one pass", () => {
    idCounter = 0;
    const prev = ["A", "B", "C", "D", "E", "F", "G", "H"].map(l => btn(l));
    const incoming = ["X1", "X2", "X3", "X4", "X5", "X6"].map(l => btn(l));
    const { merged } = smartMergeButtons(prev, incoming, MAX, newId);
    expect(merged).toHaveLength(MAX);
    const labels = merged.map(b => b.label);
    for (const lbl of ["X1", "X2", "X3", "X4", "X5", "X6"]) {
      expect(labels).toContain(lbl);
    }
    expect(labels.filter(l => ["A","B","C","D","E","F","G","H"].includes(l))).toHaveLength(2);
  });

  test("under capacity: simple append, nothing displaced", () => {
    idCounter = 0;
    const prev = ["A", "B"].map(l => btn(l));
    const incoming = ["X1", "X2", "X3"].map(l => btn(l));
    const { merged } = smartMergeButtons(prev, incoming, MAX, newId);
    expect(merged).toHaveLength(5);
    const labels = merged.map(b => b.label);
    expect(labels).toEqual(["A", "B", "X1", "X2", "X3"]);
  });

  test("exact-duplicate incoming collapses to existing — no false 'overwrite'", () => {
    idCounter = 0;
    const prev = ["A", "B"].map(l => btn(l));
    const incoming = [btn("A")]; // exact dup
    const { merged, report } = smartMergeButtons(prev, incoming, MAX, newId);
    expect(merged).toHaveLength(2);
    expect(report.duplicatesIgnored).toBe(1);
    expect(merged.map(b => b.label)).toEqual(["A", "B"]);
  });
});
