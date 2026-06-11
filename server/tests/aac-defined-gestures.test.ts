// Tests for the defined-gestures feature (gestures treated as button presses):
//   - parseDefinedGestures — jsonb validation of aac_settings.defined_gestures
//   - resolveDefinedGesture — model-reported name → registry entry matching
//   - buildObserverPrompt — <defined_gestures> block presence/content
//   - buildObserverToolDeclarations — conditional report_gesture declaration
//   - renderEventLine — "via gesture" annotation on synthetic button presses

import { describe, test, expect } from "@jest/globals";
import {
  parseDefinedGestures,
  resolveDefinedGesture,
  type DefinedGesture,
} from "../services/dual-agent/defined-gestures";
import {
  buildObserverPrompt,
  buildObserverToolDeclarations,
} from "../services/dual-agent/prompts/observer";
import { renderEventLine } from "../services/dual-agent/prompts/board-manager";
import type { ButtonPressedEvent } from "../services/dual-agent/agent-events";

const GESTURES: DefinedGesture[] = [
  { name: "thumbs up", meaning: "Yes, I want that", description: "closed fist, thumb pointing up" },
  { name: "hand to mouth", meaning: "I'm hungry" },
];

describe("parseDefinedGestures", () => {
  test("accepts valid rows and trims fields", () => {
    const parsed = parseDefinedGestures([
      { name: "  thumbs up ", meaning: " Yes ", description: " fist up " },
    ]);
    expect(parsed).toEqual([
      { name: "thumbs up", meaning: "Yes", description: "fist up" },
    ]);
  });

  test("drops rows missing name or meaning (half-filled editor rows)", () => {
    const parsed = parseDefinedGestures([
      { name: "wave", meaning: "" },
      { name: "", meaning: "Hello" },
      { name: "nod", meaning: "Yes" },
      null,
      "junk",
    ]);
    expect(parsed).toEqual([{ name: "nod", meaning: "Yes" }]);
  });

  test("returns [] for non-array input", () => {
    expect(parseDefinedGestures(undefined)).toEqual([]);
    expect(parseDefinedGestures(null)).toEqual([]);
    expect(parseDefinedGestures({})).toEqual([]);
  });

  test("normalizes empty description to undefined", () => {
    const parsed = parseDefinedGestures([{ name: "nod", meaning: "Yes", description: "  " }]);
    expect(parsed[0].description).toBeUndefined();
  });
});

describe("resolveDefinedGesture", () => {
  test("exact match", () => {
    expect(resolveDefinedGesture(GESTURES, "thumbs up")?.meaning).toBe("Yes, I want that");
  });

  test("case- and punctuation-insensitive match", () => {
    expect(resolveDefinedGesture(GESTURES, "Thumbs-Up")?.name).toBe("thumbs up");
    expect(resolveDefinedGesture(GESTURES, "HAND TO MOUTH!")?.name).toBe("hand to mouth");
  });

  test("unique containment match (model padded the name)", () => {
    expect(resolveDefinedGesture(GESTURES, "thumbs up gesture")?.name).toBe("thumbs up");
  });

  test("ambiguous containment does not match", () => {
    const ambiguous: DefinedGesture[] = [
      { name: "hand up", meaning: "A" },
      { name: "hand down", meaning: "B" },
    ];
    expect(resolveDefinedGesture(ambiguous, "hand")).toBeUndefined();
  });

  test("no match / empty input", () => {
    expect(resolveDefinedGesture(GESTURES, "shrug")).toBeUndefined();
    expect(resolveDefinedGesture(GESTURES, "")).toBeUndefined();
    expect(resolveDefinedGesture([], "thumbs up")).toBeUndefined();
  });
});

describe("buildObserverPrompt — <defined_gestures>", () => {
  const baseConfig = { studentName: "Dana", language: "en" };

  test("includes the block with names, descriptions, and meanings", () => {
    const prompt = buildObserverPrompt({ ...baseConfig, definedGestures: GESTURES });
    expect(prompt).toContain("<defined_gestures>");
    expect(prompt).toContain('"thumbs up"');
    expect(prompt).toContain("closed fist, thumb pointing up");
    expect(prompt).toContain("Yes, I want that");
    expect(prompt).toContain("report_gesture");
  });

  test("caretaker-authored fields are wrapped as untrusted data", () => {
    const prompt = buildObserverPrompt({
      ...baseConfig,
      definedGestures: [{ name: "nod", meaning: "Yes", description: "tilts head" }],
    });
    expect(prompt).toContain("<untrusted-data>tilts head</untrusted-data>");
    expect(prompt).toContain("<untrusted-data>Yes</untrusted-data>");
  });

  test("omitted when no gestures are configured", () => {
    const without = buildObserverPrompt(baseConfig);
    expect(without).not.toContain("<defined_gestures>");
    expect(without).not.toContain("report_gesture");
    const empty = buildObserverPrompt({ ...baseConfig, definedGestures: [] });
    expect(empty).not.toContain("<defined_gestures>");
  });
});

describe("buildObserverToolDeclarations — report_gesture", () => {
  function declarationNames(tools: ReturnType<typeof buildObserverToolDeclarations>): string[] {
    return (tools[0] as any).functionDeclarations.map((d: any) => d.name);
  }

  test("declared with the gesture-name enum when gestures exist", () => {
    const tools = buildObserverToolDeclarations({ definedGestures: GESTURES });
    const names = declarationNames(tools);
    expect(names).toContain("report_gesture");
    const decl = (tools[0] as any).functionDeclarations.find((d: any) => d.name === "report_gesture");
    expect(decl.parametersJsonSchema.properties.gesture.enum).toEqual([
      "thumbs up",
      "hand to mouth",
    ]);
  });

  test("absent when no gestures are configured", () => {
    expect(declarationNames(buildObserverToolDeclarations({}))).not.toContain("report_gesture");
    expect(
      declarationNames(buildObserverToolDeclarations({ definedGestures: [] })),
    ).not.toContain("report_gesture");
  });
});

describe("renderEventLine — gesture-triggered press", () => {
  function pressEvent(extra: Partial<ButtonPressedEvent> = {}): ButtonPressedEvent {
    return {
      type: "button_pressed",
      source: "client",
      timestamp: 1,
      label: "thumbs up",
      sentence: "Yes, I want that",
      ...extra,
    };
  }

  test("annotates synthetic gesture presses", () => {
    const line = renderEventLine(pressEvent({ via: "gesture", gestureName: "thumbs up", target: "DEVICE" }));
    expect(line).toBe(`[USER to AI via gesture] "Yes, I want that"`);
  });

  test("regular presses are unchanged", () => {
    const line = renderEventLine(pressEvent({ target: "DEVICE" }));
    expect(line).toBe(`[USER to AI] "Yes, I want that"`);
  });
});
