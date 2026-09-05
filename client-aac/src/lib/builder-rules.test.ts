// The sentence builder's CLIENT-BOUND press rules (builder-rules.ts): the noun
// kind the parser reads off the wire, and where the student's learned layer is
// kept.
//
// The press-ROUTING half (`autoComposeSlot` & co.) is now shared with the
// clinician builder and pinned in server/tests/glyph-builder-ops.test.ts.

import { describe, it, expect, beforeEach } from "@jest/globals";
import {
  engineNounKind,
  loadRecency,
  recencyStorageKey,
  saveRecency,
  RECENCY_STORAGE_PREFIX,
} from "./builder-rules";
import { emptyRecency, noteUtterance } from "@shared/world-engine/interaction/intent/surface-next";
import { parseSentence } from "@shared/world-engine/interaction/intent/parse-intent";
import type { BuilderRecency } from "@shared/games-bridge";

/** A minimal localStorage for the node test environment. */
function installStore(seed: Record<string, string> = {}): Map<string, string> {
  const map = new Map(Object.entries(seed));
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  } as Storage;
  return map;
}

describe("engineNounKind — the wire's kind as the parser names it", () => {
  it("a person is a CREATURE to the parser", () => {
    expect(engineNounKind("person")).toBe("creature");
    expect(engineNounKind("creature")).toBe("creature");
  });

  it("items and places pass through; anything else is unknown", () => {
    expect(engineNounKind("item")).toBe("item");
    expect(engineNounKind("place")).toBe("place");
    expect(engineNounKind("")).toBe("unknown");
    expect(engineNounKind("spaceship")).toBe("unknown");
  });
});

describe("the recency store — one learned layer per student", () => {
  beforeEach(() => {
    installStore();
  });

  it("keys off the student, so two students never share a memory", () => {
    const store = installStore({ synapse_student_id: "student-a" });
    expect(recencyStorageKey()).toBe(`${RECENCY_STORAGE_PREFIX}student-a`);
    saveRecency(noteUtterance(emptyRecency(), parseSentence("i_me+want+apple")));
    store.set("synapse_student_id", "student-b");
    expect(recencyStorageKey()).toBe(`${RECENCY_STORAGE_PREFIX}student-b`);
    // B starts fresh — A's habit is not B's board.
    expect(loadRecency()).toEqual(emptyRecency());
    store.set("synapse_student_id", "student-a");
    expect(loadRecency().utterances).toBe(1);
  });

  it("round-trips what the student said, cap rules and all", () => {
    installStore({ synapse_student_id: "s1" });
    let mem: BuilderRecency = emptyRecency();
    for (const s of ["i_me+want+ball", "i_me+want+ball", "you+go+home"]) {
      mem = noteUtterance(mem, parseSentence(s));
    }
    saveRecency(mem);
    const back = loadRecency();
    expect(back).toEqual(mem);
    expect(back.utterances).toBe(3);
    expect(back.uses?.find((u) => u.key === "want")?.n).toBe(2);
    expect(back.pairs?.find((p) => p.key === "want>ball")?.n).toBe(2);
  });

  it("no entry yet ⇒ an EMPTY memory, which the surfacer treats as no memory", () => {
    installStore({ synapse_student_id: "brand-new" });
    expect(loadRecency()).toEqual(emptyRecency());
  });

  it("a CORRUPT entry costs the board nothing — fresh memory, never a throw", () => {
    for (const junk of ["not json at all", "null", "42", '{"utterances":"lots"}', '{"mentioned":3}']) {
      installStore({ synapse_student_id: "s1", [`${RECENCY_STORAGE_PREFIX}s1`]: junk });
      expect(loadRecency()).toEqual(emptyRecency());
    }
  });

  it("survives having no store at all — a press must never depend on one", () => {
    delete (globalThis as unknown as { localStorage?: Storage }).localStorage;
    expect(recencyStorageKey()).toBe(`${RECENCY_STORAGE_PREFIX}anon`);
    expect(loadRecency()).toEqual(emptyRecency());
    expect(() => saveRecency(emptyRecency())).not.toThrow();
  });
});
