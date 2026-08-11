// The sentence builder's pure press rules (builder-rules.ts): what a press
// MEANS, and where the student's learned layer is kept.
//
// These are the client half of the two seams the AAC board carried for a long
// time — the grid press that built a different sentence than the in-game menu
// did, and the learned layer the platform path never had. Both change meaning,
// so both get pinned here rather than only being typechecked.

import { describe, it, expect, beforeEach } from "@jest/globals";
import {
  autoComposeSlot,
  engineNounKind,
  loadRecency,
  recencyStorageKey,
  saveRecency,
  RECENCY_STORAGE_PREFIX,
} from "./builder-rules";
import { parseGlyph, serializeGlyph, addModifier, EMPTY_GLYPH } from "@shared/glyph-compositor";
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

describe("autoComposeSlot — the descriptor rule (the in-game SpeakMenu's tapWord)", () => {
  // The seam, stated as the two sentences it produces: `banana.hot` is a
  // request for a hot banana; `banana + hot` is the claim that the banana is
  // hot. Same two presses; the parser reads them differently.
  it("composes a descriptor onto the head it describes", () => {
    const glyph = parseGlyph("apple");
    const idx = autoComposeSlot(glyph, "hot");
    expect(idx).toBe(0);
    expect(serializeGlyph(addModifier(glyph, idx!, "hot"))).toBe("apple.hot");
  });

  it("composes onto the LAST head only — an earlier word is not re-described", () => {
    const glyph = parseGlyph("apple+ball");
    expect(autoComposeSlot(glyph, "big")).toBe(1);
  });

  it("pushes (returns null) when there is no head to describe", () => {
    expect(autoComposeSlot(EMPTY_GLYPH, "hot")).toBeNull();
    expect(autoComposeSlot(parseGlyph(""), "hot")).toBeNull();
  });

  it("pushes when the tapped word is NOT a modifier — a noun never composes", () => {
    expect(autoComposeSlot(parseGlyph("apple"), "ball")).toBeNull();
    expect(autoComposeSlot(parseGlyph("apple"), "want")).toBeNull();
    // A word neither registry knows (an engine-only key, a generated symbol)
    // pushes too — no registry facet, no rule.
    expect(autoComposeSlot(parseGlyph("apple"), "zzz_not_a_word")).toBeNull();
  });

  it("pushes when the modifier does not APPLY to that head's part of speech", () => {
    // The gate is the registry's own `appliesTo`, not a guess: a modifier that
    // has nothing to say about a head must not silently attach to it.
    const glyph = parseGlyph("apple");
    const idx = autoComposeSlot(glyph, "hot");
    expect(idx).not.toBeNull(); // control: `hot` does apply to a noun
    // ...and a head the registry doesn't know at all offers no pos to match.
    expect(autoComposeSlot(parseGlyph("zzz_unknown_head"), "hot")).toBeNull();
  });

  it("never applies the SAME modifier twice — a second tap pushes instead", () => {
    const once = addModifier(parseGlyph("apple"), 0, "hot");
    expect(autoComposeSlot(once, "hot")).toBeNull();
    // A DIFFERENT descriptor still composes onto the same head.
    expect(autoComposeSlot(once, "big")).toBe(0);
  });

  it("the composed sentence is what the ENGINE reads as a modified noun", () => {
    // END TO END, and the reason the rule exists: the two forms are two
    // different meanings, and only the composed one asks for a HOT apple.
    const composed = serializeGlyph(addModifier(parseGlyph("i_me+want+apple"), 2, "hot"));
    expect(composed).toBe("i_me+want+apple.hot");

    const together = parseSentence(composed);
    const objectOf = (f: ReturnType<typeof parseSentence>): string[] =>
      f.object && f.object.kind === "entity" ? [...f.object.modifiers] : [];
    expect(together.kind).toBe("request");
    expect(together.object).toMatchObject({ kind: "entity", symbol: "apple" });
    // "hot" describes the APPLE — it rides on the object ref.
    expect(objectOf(together)).toContain("hot");
    expect(together.modifiers).not.toContain("hot");

    // Pushed as its own word, "hot" becomes a PREDICATE attribute of the
    // utterance instead: the apple is not asked for hot, it is called hot.
    const apart = parseSentence("i_me+want+apple+hot");
    expect(objectOf(apart)).not.toContain("hot");
    expect(apart.modifiers).toContain("hot");
  });
});

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
