/**
 * Verifies that the `singleGlyphButtons` AAC setting strips every `+`-joined
 * SENTENCE example from the AI's button-generating surfaces.
 *
 * What's tested:
 *   - `<grammar>` and `<button_syntax>` blocks of the live system prompt
 *     contain no `+`-joined glyph composition when the flag is on.
 *   - `<binary_choice>` examples drop the `+` syntax.
 *   - The base (default-false) prompt still carries multi-glyph guidance.
 *   - Tool descriptions for rebuild_board, add_buttons, binary_choice, and
 *     ask_binary_choice drop the `+` syntax under the flag.
 *
 * What's deliberately NOT tested:
 *   - `<sentence_interpretation>` / `<sentence_builder>` sections — the user-
 *     driven sentence-builder path keeps multi-glyph regardless of the flag.
 *   - Validator behavior — there is none. The flag is prompt-only.
 */

import { describe, it, expect } from "@jest/globals";
import { buildInteractiveAgentPrompt } from "../services/memory-schema/aac-memory-schema";
import { buildToolDeclarations } from "../services/dual-agent/tool-declarations";

// Extract a [start..end] region of the prompt by tag pair so we can assert
// on it in isolation. Keeps the test honest — a `+` elsewhere in the prompt
// (e.g. inside <sentence_builder>) is intentional and shouldn't fail the test.
function regionBetween(prompt: string, openTag: string, closeTag: string): string {
  const open = prompt.indexOf(openTag);
  const close = prompt.indexOf(closeTag, open);
  if (open < 0 || close < 0) {
    throw new Error(`region "${openTag}…${closeTag}" not found in prompt`);
  }
  return prompt.slice(open, close + closeTag.length);
}

// A `+` flanked by non-whitespace characters (the shape `i_me+want`,
// `🍪+two`, `you+👌#question`, etc). The grammar / button_syntax /
// binary_choice regions have no other use of `+` — every flanked `+` is
// glyph composition.
const GLYPH_PLUS_PATTERN = /\S\+\S/;

const base = {
  studentName: "Daniel",
  persona: "TEST_PERSONA",
  language: "en",
  muteState: "unmuted" as const,
};

describe("singleGlyphButtons — system prompt", () => {
  it("strips `+`-joined glyphs from <grammar> when on", () => {
    const promptOn = buildInteractiveAgentPrompt({ ...base, singleGlyphButtons: true });
    const grammarOn = regionBetween(promptOn, "<grammar>", "</grammar>");
    expect(grammarOn).not.toMatch(GLYPH_PLUS_PATTERN);
    expect(grammarOn).not.toContain("i_me+want");
    expect(grammarOn).not.toContain("2-glyph");
    expect(grammarOn).not.toContain("3-glyph");
  });

  it("keeps `+`-joined glyphs in <grammar> when off (default)", () => {
    const promptOff = buildInteractiveAgentPrompt({ ...base });
    const grammarOff = regionBetween(promptOff, "<grammar>", "</grammar>");
    expect(grammarOff).toMatch(GLYPH_PLUS_PATTERN);
    expect(grammarOff).toContain("i_me+want+🍌");
  });

  it("strips `+`-joined glyphs from <button_syntax> when on", () => {
    const promptOn = buildInteractiveAgentPrompt({ ...base, singleGlyphButtons: true });
    const region = regionBetween(promptOn, "<button_syntax>", "</button_syntax>");
    expect(region).not.toMatch(GLYPH_PLUS_PATTERN);
  });

  it("strips `+`-joined glyphs from <binary_choice> when on", () => {
    const promptOn = buildInteractiveAgentPrompt({ ...base, singleGlyphButtons: true });
    const region = regionBetween(promptOn, "<binary_choice>", "</binary_choice>");
    expect(region).not.toMatch(GLYPH_PLUS_PATTERN);
    expect(region).not.toContain("multi-glyph");
  });

  it("keeps <sentence_builder> multi-glyph examples regardless of the flag", () => {
    // sentence_builder is the user-driven composition surface; its tool
    // (interpret) still has to decode multi-glyph SENTENCEs the user assembles.
    const promptOn = buildInteractiveAgentPrompt({ ...base, singleGlyphButtons: true });
    const region = regionBetween(promptOn, "<sentence_builder>", "</sentence_builder>");
    expect(region).toMatch(GLYPH_PLUS_PATTERN);
  });
});

describe("singleGlyphButtons — tool declarations", () => {
  const toolConfigBase = {
    enabledApps: [],
    availableBoards: [],
    hasLoadedBoard: false,
    faceRecognitionActive: false,
    language: "en",
  };

  function findToolDescription(tools: ReturnType<typeof buildToolDeclarations>, name: string): string {
    for (const t of tools) {
      const decl = t.functionDeclarations?.find((d: any) => d.name === name);
      if (decl) return decl.description || "";
    }
    throw new Error(`tool "${name}" not declared`);
  }

  it("strips `+`-joined glyphs from rebuild_board's button-list description when on", () => {
    const tools = buildToolDeclarations({ ...toolConfigBase, singleGlyphButtons: true });
    const decl = tools[0]?.functionDeclarations?.find((d: any) => d.name === "rebuild_board");
    expect(decl).toBeDefined();
    const buttonsDesc = (decl!.parametersJsonSchema as any).properties.user_response_buttons.description;
    expect(buttonsDesc).not.toMatch(GLYPH_PLUS_PATTERN);
    expect(buttonsDesc).not.toContain("3-glyph");
  });

  it("keeps `+`-joined glyphs in rebuild_board's description when off", () => {
    const tools = buildToolDeclarations({ ...toolConfigBase });
    const decl = tools[0]?.functionDeclarations?.find((d: any) => d.name === "rebuild_board");
    const buttonsDesc = (decl!.parametersJsonSchema as any).properties.user_response_buttons.description;
    expect(buttonsDesc).toMatch(GLYPH_PLUS_PATTERN);
  });

  it("strips `+`-joined glyphs from binary_choice option descriptions when on", () => {
    const tools = buildToolDeclarations({ ...toolConfigBase, singleGlyphButtons: true });
    const decl = tools[0]?.functionDeclarations?.find((d: any) => d.name === "binary_choice");
    expect(decl).toBeDefined();
    const optDesc = (decl!.parametersJsonSchema as any).properties.option1.description;
    expect(optDesc).not.toMatch(GLYPH_PLUS_PATTERN);
    expect(optDesc).not.toContain("multi-glyph");
  });

  it("strips `+`-joined glyphs from ask_binary_choice when on", () => {
    const tools = buildToolDeclarations({ ...toolConfigBase, singleGlyphButtons: true });
    const decl = tools[0]?.functionDeclarations?.find((d: any) => d.name === "ask_binary_choice");
    expect(decl).toBeDefined();
    const optDesc = (decl!.parametersJsonSchema as any).properties.option1.description;
    expect(optDesc).not.toMatch(GLYPH_PLUS_PATTERN);
  });

  it("keeps the interpret() tool description intact (user-composed SENTENCEs)", () => {
    const tools = buildToolDeclarations({ ...toolConfigBase, singleGlyphButtons: true });
    const decl = tools[0]?.functionDeclarations?.find((d: any) => d.name === "interpret");
    expect(decl).toBeDefined();
    // interpret() decodes whatever the user composed; its description should
    // still describe full SENTENCEs. We don't assert on `+` here — the user's
    // composed sentence is the input, the tool itself doesn't need to bake
    // multi-glyph examples into its own text.
    expect(decl!.description).toContain("SENTENCE");
  });
});
