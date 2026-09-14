// Unit tests for server/services/aac/verbal-ability-memory.ts — the module
// that moved the student's structured VERBAL ABILITY from the legacy
// `students.verbal_ability` column to chat memory
// (`Student_CommunicationStyle.VerbalAbility`), maintained by the AI.
//
// Covers: the memory-wins-over-column read, the raise/demotion rules that
// the attribution trust gate depends on (decideVerbalAbilitySync), the
// identity-plan-call parser, the write path (merge/clear/consent-gate), the
// field schema pinned to the same enum, and the prompt strings that
// reference the new memory path.
//
// See CLAUDE.md "Never run jest directly" — run via:
//   npm run test:unit -- verbal-ability

import { readFileSync } from "fs";
import { join } from "path";
import { describe, it, expect, jest } from "@jest/globals";
import {
  readVerbalAbility,
  verbalAbilityRank,
  isVerbalAbilityRaise,
  decideVerbalAbilitySync,
  parsePlannedVerbalAbility,
  writeVerbalAbility,
  VERBAL_ABILITY_FIELD,
  VERBAL_ABILITY_KEY,
  VERBAL_ABILITY_SOURCE_KEY,
  VERBAL_ABILITY_UPDATED_KEY,
  VERBAL_ABILITY_SOURCES,
  type VerbalAbilityWriteDeps,
} from "../services/aac/verbal-ability-memory";
import { VERBAL_ABILITIES, type VerbalAbility } from "@shared/aac/verbal-ability";
import { STUDENT_COMMUNICATION_STYLE_FIELD } from "../services/memory-schema/student-memory-schema";
import { buildMonitorSystemPrompt } from "../services/memory-schema/aac-memory-schema";
import { buildObserverPrompt, verbalAbilityLine } from "../services/dual-agent/prompts/observer";

// ---------------------------------------------------------------------------
// readVerbalAbility
// ---------------------------------------------------------------------------

describe("readVerbalAbility", () => {
  it("memory value wins over the legacy column", () => {
    const student = {
      chatMemory: {
        Student_CommunicationStyle: { VerbalAbility: "fluent", VerbalAbilitySource: "monitor" },
      },
      verbalAbility: "none",
    };
    expect(readVerbalAbility(student)).toEqual({ value: "fluent", from: "memory", source: "monitor" });
  });

  it("falls back to the legacy column when memory is absent, attributed to clinician", () => {
    const student = { chatMemory: {}, verbalAbility: "single_words" };
    expect(readVerbalAbility(student)).toEqual({ value: "single_words", from: "column", source: "clinician" });
  });

  it("falls back to the column when chatMemory itself is undefined", () => {
    const student = { verbalAbility: "vocalizations" };
    expect(readVerbalAbility(student)).toEqual({ value: "vocalizations", from: "column", source: "clinician" });
  });

  it("unknown/garbage strings in memory or column read as unset", () => {
    expect(
      readVerbalAbility({
        chatMemory: { Student_CommunicationStyle: { VerbalAbility: "garbage" } },
        verbalAbility: "also-garbage",
      }),
    ).toEqual({ value: null, from: null });

    // Garbage in memory falls through to a VALID column value.
    expect(
      readVerbalAbility({
        chatMemory: { Student_CommunicationStyle: { VerbalAbility: "garbage" } },
        verbalAbility: "fluent",
      }),
    ).toEqual({ value: "fluent", from: "column", source: "clinician" });
  });

  it("null/undefined student reads as unset", () => {
    expect(readVerbalAbility(null)).toEqual({ value: null, from: null });
    expect(readVerbalAbility(undefined)).toEqual({ value: null, from: null });
  });
});

// ---------------------------------------------------------------------------
// verbalAbilityRank / isVerbalAbilityRaise
// ---------------------------------------------------------------------------

describe("isVerbalAbilityRaise", () => {
  it("none -> single_words is a raise", () => {
    expect(isVerbalAbilityRaise("none", "single_words")).toBe(true);
  });

  it("fluent -> none is not a raise", () => {
    expect(isVerbalAbilityRaise("fluent", "none")).toBe(false);
  });

  it("null -> none is not a raise (unset -> none is a lowering/no-op on the speech axis)", () => {
    expect(isVerbalAbilityRaise(null, "none")).toBe(false);
  });

  it("null -> fluent is a raise", () => {
    expect(isVerbalAbilityRaise(null, "fluent")).toBe(true);
  });

  it("single_words -> single_words is not a raise", () => {
    expect(isVerbalAbilityRaise("single_words", "single_words")).toBe(false);
  });

  it("verbalAbilityRank orders the enum and puts unset lowest", () => {
    expect(verbalAbilityRank(null)).toBe(-1);
    expect(verbalAbilityRank("none")).toBeLessThan(verbalAbilityRank("vocalizations"));
    expect(verbalAbilityRank("vocalizations")).toBeLessThan(verbalAbilityRank("single_words"));
    expect(verbalAbilityRank("single_words")).toBeLessThan(verbalAbilityRank("fluent"));
  });
});

// ---------------------------------------------------------------------------
// decideVerbalAbilitySync
// ---------------------------------------------------------------------------

describe("decideVerbalAbilitySync", () => {
  const roundStartedAt = 1_000_000;

  it("same value -> noop", () => {
    expect(
      decideVerbalAbilitySync({ current: "single_words", next: "single_words", lastDemotionAt: null, roundStartedAt }),
    ).toBe("noop");
  });

  it("lowering -> apply regardless of demotion timing", () => {
    expect(
      decideVerbalAbilitySync({ current: "fluent", next: "none", lastDemotionAt: roundStartedAt + 100, roundStartedAt }),
    ).toBe("apply");
    expect(
      decideVerbalAbilitySync({ current: "fluent", next: "single_words", lastDemotionAt: roundStartedAt - 100, roundStartedAt }),
    ).toBe("apply");
  });

  it("raise with no demotion recorded -> apply", () => {
    expect(
      decideVerbalAbilitySync({ current: "none", next: "single_words", lastDemotionAt: null, roundStartedAt }),
    ).toBe("apply");
  });

  it("raise with a demotion AT the round start -> refuse_raise", () => {
    expect(
      decideVerbalAbilitySync({ current: "none", next: "single_words", lastDemotionAt: roundStartedAt, roundStartedAt }),
    ).toBe("refuse_raise");
  });

  it("raise with a demotion AFTER the round start -> refuse_raise", () => {
    expect(
      decideVerbalAbilitySync({ current: "none", next: "single_words", lastDemotionAt: roundStartedAt + 1, roundStartedAt }),
    ).toBe("refuse_raise");
  });

  it("raise with a demotion BEFORE the round start -> apply", () => {
    expect(
      decideVerbalAbilitySync({ current: "none", next: "single_words", lastDemotionAt: roundStartedAt - 1, roundStartedAt }),
    ).toBe("apply");
  });

  it("next null -> apply (the gate simply stops)", () => {
    expect(
      decideVerbalAbilitySync({ current: "fluent", next: null, lastDemotionAt: roundStartedAt, roundStartedAt }),
    ).toBe("apply");
  });
});

// ---------------------------------------------------------------------------
// parsePlannedVerbalAbility
// ---------------------------------------------------------------------------

describe("parsePlannedVerbalAbility", () => {
  it("parses a bare token", () => {
    expect(parsePlannedVerbalAbility("single_words")).toBe("single_words");
  });

  it("tolerates leading/trailing whitespace, capitalization, and trailing prose", () => {
    expect(parsePlannedVerbalAbility("  Fluent.\n(reason)")).toBe("fluent");
  });

  it("'unspecified' parses to null", () => {
    expect(parsePlannedVerbalAbility("unspecified")).toBeNull();
  });

  it("empty string / undefined parse to null", () => {
    expect(parsePlannedVerbalAbility("")).toBeNull();
    expect(parsePlannedVerbalAbility(undefined)).toBeNull();
  });

  it("tolerates trailing prose after the token, separated by punctuation", () => {
    expect(parsePlannedVerbalAbility("none - no spoken words")).toBe("none");
  });
});

// ---------------------------------------------------------------------------
// writeVerbalAbility
// ---------------------------------------------------------------------------

function makeDeps(
  initialMemory: Record<string, any> | null,
  writesAllowed = true,
): VerbalAbilityWriteDeps & { getStore: () => Record<string, any> | null } {
  let store = initialMemory;
  const writeMemory = jest.fn(async (_studentId: string, memory: Record<string, any>) => {
    store = memory;
  });
  const readMemory = jest.fn(async (_studentId: string) => store);
  const writesAllowedFn = jest.fn(async (_studentId: string) => writesAllowed);
  return { readMemory, writeMemory, writesAllowed: writesAllowedFn, getStore: () => store };
}

describe("writeVerbalAbility", () => {
  it("merges into an existing Student_CommunicationStyle object, preserving AccessMethod", async () => {
    const deps = makeDeps({ Student_CommunicationStyle: { AccessMethod: "touch" } });
    const result = await writeVerbalAbility("s1", "fluent", "clinician", deps);
    expect(result).not.toBeNull();
    const style = result![VERBAL_ABILITY_FIELD];
    expect(style.AccessMethod).toBe("touch");
    expect(style[VERBAL_ABILITY_KEY]).toBe("fluent");
    expect(style[VERBAL_ABILITY_SOURCE_KEY]).toBe("clinician");
    expect(typeof style[VERBAL_ABILITY_UPDATED_KEY]).toBe("string");
    expect(deps.writeMemory).toHaveBeenCalledTimes(1);
  });

  it("null clears the three keys and keeps AccessMethod", async () => {
    const deps = makeDeps({
      Student_CommunicationStyle: {
        AccessMethod: "eyegaze",
        VerbalAbility: "single_words",
        VerbalAbilitySource: "monitor",
        VerbalAbilityUpdatedAt: "2026-01-01T00:00:00.000Z",
      },
    });
    const result = await writeVerbalAbility("s1", null, "monitor", deps);
    expect(result).not.toBeNull();
    const style = result![VERBAL_ABILITY_FIELD];
    expect(style.AccessMethod).toBe("eyegaze");
    expect(style[VERBAL_ABILITY_KEY]).toBeUndefined();
    expect(style[VERBAL_ABILITY_SOURCE_KEY]).toBeUndefined();
    expect(style[VERBAL_ABILITY_UPDATED_KEY]).toBeUndefined();
  });

  it("writesAllowed:false refuses the write — returns null, writeMemory never called", async () => {
    const deps = makeDeps({ Student_CommunicationStyle: { AccessMethod: "touch" } }, false);
    const result = await writeVerbalAbility("s1", "fluent", "clinician", deps);
    expect(result).toBeNull();
    expect(deps.writeMemory).not.toHaveBeenCalled();
  });

  it("memory absent (readMemory returns null) still writes a fresh object", async () => {
    const deps = makeDeps(null);
    const result = await writeVerbalAbility("s1", "none", "seed", deps);
    expect(result).not.toBeNull();
    expect(result![VERBAL_ABILITY_FIELD]).toEqual(
      expect.objectContaining({ VerbalAbility: "none", VerbalAbilitySource: "seed" }),
    );
    expect(deps.getStore()![VERBAL_ABILITY_FIELD][VERBAL_ABILITY_KEY]).toBe("none");
  });
});

// ---------------------------------------------------------------------------
// Field schema
// ---------------------------------------------------------------------------

describe("Student_CommunicationStyle field schema", () => {
  it("VerbalAbility.enum matches the four VerbalAbility tokens", () => {
    const prop = (STUDENT_COMMUNICATION_STYLE_FIELD.properties as any).VerbalAbility;
    expect(prop.enum).toEqual([...VERBAL_ABILITIES]);
  });

  it("VerbalAbilitySource.enum matches the five write sources", () => {
    const prop = (STUDENT_COMMUNICATION_STYLE_FIELD.properties as any).VerbalAbilitySource;
    expect(prop.enum).toEqual([...VERBAL_ABILITY_SOURCES]);
  });

  it("the VerbalAbility description warns against speech-derived writes", () => {
    const prop = (STUDENT_COMMUNICATION_STYLE_FIELD.properties as any).VerbalAbility;
    expect(prop.description).toContain("NEVER");
  });
});

// ---------------------------------------------------------------------------
// Prompt pins
// ---------------------------------------------------------------------------

describe("prompt pins — verbal ability memory path", () => {
  it("buildMonitorSystemPrompt points the Monitor at the new memory path and bans speech-derived writes", () => {
    const p = buildMonitorSystemPrompt({ name: "Sam", aacSettings: null });
    expect(p).toContain("/Student_CommunicationStyle/VerbalAbility");
    expect(p).toContain("NEVER from speech");
  });

  it("buildObserverPrompt still renders the 'none' attribution line unchanged", () => {
    expect(buildObserverPrompt({ studentName: "Dana", language: "en", verbalAbility: "none" }))
      .toContain("[Dana] does NOT produce spoken words");
  });

  it("verbalAbilityLine('Dana', 'none') states the capability as fact", () => {
    expect(verbalAbilityLine("Dana", "none")).toContain("does NOT produce spoken words");
  });
});

// ---------------------------------------------------------------------------
// Guided setup — source-level guard
// ---------------------------------------------------------------------------

describe("guided setup — references the new memory path", () => {
  it("student-setup-flow.ts mentions /Student_CommunicationStyle/VerbalAbility", () => {
    const src = readFileSync(
      join(process.cwd(), "server", "services", "guided-setup", "student-setup-flow.ts"),
      "utf8",
    );
    expect(src).toContain("/Student_CommunicationStyle/VerbalAbility");
  });
});
