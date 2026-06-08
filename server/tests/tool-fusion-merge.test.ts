// Verifies the parallel-fused-call merge step in the fusion normalizer:
// when the model emits N separate `RebuildBoardButtons` calls (one per
// intended board button), they collapse into ONE call carrying all N
// items in the array param. Without this, each fused call gets
// rewritten to a single-item rebuild_board, which the dispatch layer
// then downgrades to add_board_button → the intended bulk rebuild
// becomes N sequential adds and the board never fully rebuilds.

import type { FunctionDeclaration } from "@google/genai";
import {
  buildFusionMap,
  mergeFusedToolCalls,
  applyFusionEntry,
} from "../services/dual-agent/tool-fusion-normalizer";

const REBUILD_BOARD: FunctionDeclaration = {
  name: "rebuild_board",
  description: "Replace the user-response board with the given buttons.",
  parametersJsonSchema: {
    type: "object",
    properties: {
      buttons: {
        type: "array",
        items: { type: "object" },
      },
      target: { type: "string" },
    },
    required: ["buttons"],
  },
};

const SUGGEST_CONSTRUCTION: FunctionDeclaration = {
  name: "suggest_construction_buttons",
  description: "Suggest construction buttons in the sentence builder.",
  parametersJsonSchema: {
    type: "object",
    properties: {
      slot_index: { type: "number" },
      head_candidates: { type: "array", items: { type: "object" } },
      modifier_candidates: { type: "array", items: { type: "object" } },
    },
    required: ["slot_index"],
  },
};

const fusionMap = buildFusionMap([REBUILD_BOARD, SUGGEST_CONSTRUCTION]);

describe("mergeFusedToolCalls", () => {
  test("collapses N parallel RebuildBoardButtons calls into ONE rebuild_board", () => {
    const calls = [
      { name: "RebuildBoardButtons", arguments: JSON.stringify({ label: "yes", speech: "yes" }) },
      { name: "RebuildBoardButtons", arguments: JSON.stringify({ label: "no", speech: "no" }) },
      { name: "RebuildBoardButtons", arguments: JSON.stringify({ label: "maybe", speech: "maybe" }) },
    ];
    const merged = mergeFusedToolCalls(calls, fusionMap);

    expect(merged).toHaveLength(1);
    expect(merged[0].name).toBe("RebuildBoardButtons");
    const args = JSON.parse(merged[0].arguments);
    // The merged call's args use the underlying param name so
    // applyFusionEntry just renames the tool on its normal pass.
    expect(Array.isArray(args.buttons)).toBe(true);
    expect(args.buttons).toHaveLength(3);
    expect(args.buttons[0].label).toBe("yes");
    expect(args.buttons[2].label).toBe("maybe");
  });

  test("merged call rewrites to rebuild_board(buttons=[...N...]) via applyFusionEntry", () => {
    const calls = [
      { name: "RebuildBoardButtons", arguments: JSON.stringify({ label: "a", glyph: [{ sym: "x" }] }) },
      { name: "RebuildBoardButtons", arguments: JSON.stringify({ label: "b", glyph: [{ sym: "y" }] }) },
    ];
    const merged = mergeFusedToolCalls(calls, fusionMap);
    const entry = fusionMap.get(merged[0].name!)!;
    const finalArgs = applyFusionEntry(entry, JSON.parse(merged[0].arguments));
    expect(entry.toolName).toBe("rebuild_board");
    expect(finalArgs.buttons).toHaveLength(2);
    expect(finalArgs.buttons[0].label).toBe("a");
    expect(finalArgs.buttons[1].label).toBe("b");
  });

  test("single fused call passes through with one-element array (unchanged behavior)", () => {
    const calls = [
      { name: "RebuildBoardButtons", arguments: JSON.stringify({ label: "solo" }) },
    ];
    const merged = mergeFusedToolCalls(calls, fusionMap);
    expect(merged).toHaveLength(1);
    const args = JSON.parse(merged[0].arguments);
    expect(args.buttons).toHaveLength(1);
    expect(args.buttons[0].label).toBe("solo");
  });

  test("non-fused calls pass through untouched", () => {
    const calls = [
      { name: "no_change", arguments: JSON.stringify({ reason: "stable" }) },
      { name: "emote", arguments: JSON.stringify({ emotion: "happy" }) },
    ];
    const merged = mergeFusedToolCalls(calls, fusionMap);
    expect(merged).toEqual(calls);
  });

  test("interleaved fused + non-fused: clusters by tool, non-fused interleaved", () => {
    const calls = [
      { name: "RebuildBoardButtons", arguments: JSON.stringify({ label: "x" }) },
      { name: "emote", arguments: JSON.stringify({ emotion: "happy" }) },
      { name: "RebuildBoardButtons", arguments: JSON.stringify({ label: "y" }) },
    ];
    const merged = mergeFusedToolCalls(calls, fusionMap);
    // One merged RebuildBoardButtons + the emote call. Order preserved
    // by the FIRST appearance of the fused tool, so the merged call
    // takes slot 0 and emote follows.
    expect(merged).toHaveLength(2);
    expect(merged[0].name).toBe("RebuildBoardButtons");
    expect(JSON.parse(merged[0].arguments).buttons).toHaveLength(2);
    expect(merged[1].name).toBe("emote");
  });

  test("two different fused tools cluster independently", () => {
    const calls = [
      { name: "RebuildBoardButtons", arguments: JSON.stringify({ label: "a" }) },
      { name: "SuggestConstructionButtonsHeadCandidates", arguments: JSON.stringify({ slot_index: 0, label: "h1" }) },
      { name: "RebuildBoardButtons", arguments: JSON.stringify({ label: "b" }) },
      { name: "SuggestConstructionButtonsHeadCandidates", arguments: JSON.stringify({ slot_index: 0, label: "h2" }) },
    ];
    const merged = mergeFusedToolCalls(calls, fusionMap);
    expect(merged).toHaveLength(2);
    const rebuild = merged.find(c => c.name === "RebuildBoardButtons")!;
    const suggest = merged.find(c => c.name === "SuggestConstructionButtonsHeadCandidates")!;
    expect(JSON.parse(rebuild.arguments).buttons).toHaveLength(2);
    expect(JSON.parse(suggest.arguments).head_candidates).toHaveLength(2);
    // The scalar slot_index is preserved from the first call.
    expect(JSON.parse(suggest.arguments).slot_index).toBe(0);
  });

  test("applyFusionEntry keeps label/speech/glyph INSIDE the button (not stripped to outer scope)", () => {
    // Regression: the prior naive "string-typed → outer" heuristic would
    // pull label/speech out of the button and leave {glyph: [...]} as
    // the only field inside. Schema-aware split keeps non-declared
    // siblings inside the wrapped item.
    const entry = fusionMap.get("RebuildBoardButtons")!;
    const result = applyFusionEntry(entry, {
      label: "yes",
      speech: "yes please",
      glyph: [{ sym: "yes" }],
      target: "USER", // declared sibling — stays outer
    });
    expect(result.target).toBe("USER");
    expect(result.buttons).toHaveLength(1);
    expect(result.buttons[0].label).toBe("yes");
    expect(result.buttons[0].speech).toBe("yes please");
    expect(result.buttons[0].glyph).toEqual([{ sym: "yes" }]);
    // label/speech must NOT leak to the outer scope as siblings of buttons
    expect((result as any).label).toBeUndefined();
    expect((result as any).speech).toBeUndefined();
  });

  test("if fused call already carries a full array param, items concatenate without double-wrapping", () => {
    const calls = [
      { name: "RebuildBoardButtons", arguments: JSON.stringify({ buttons: [{ label: "a" }, { label: "b" }] }) },
      { name: "RebuildBoardButtons", arguments: JSON.stringify({ label: "c" }) },
    ];
    const merged = mergeFusedToolCalls(calls, fusionMap);
    expect(merged).toHaveLength(1);
    const args = JSON.parse(merged[0].arguments);
    expect(args.buttons).toHaveLength(3);
    expect(args.buttons.map((b: any) => b.label)).toEqual(["a", "b", "c"]);
  });
});
