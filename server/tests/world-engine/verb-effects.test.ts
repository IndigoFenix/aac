// THE VERB → EFFECT TABLE (shared/world-engine/interaction/intent/verb-effects.ts)
//
// `compileBareAction`'s 22-arm `switch (frame.verb)` became an ORDERED DATA
// TABLE (semantic-behavior.md §2/§5, migration steps 1-2). A port like that is
// worth exactly as much as its proof, so this suite is three pins — plus the
// two readings the round deliberately CHANGED (④ and ⑤), each pinned where the
// fixture can no longer speak for it:
//
// 🚨 TWO RULED RE-BASELINES (2026-09-08), one rule in two halves, 318 of the
// 44,492 answers between them — all of them `with`-marked movement:
//   • B5b, 279 cases: `with` marks COMPANY and never an ENDPOINT, so a companion
//     may no longer STEAL the destination the child said ("go home with Mara"
//     was compiling to goTo{Mara}). Pinned below in ④.
//   • B5c, 39 cases: what that leaves when the sentence names company and NO
//     destination. "Go with Mara" matched no row at all, and §7 says a
//     well-formed sentence must never read as not-understood — moving WITH
//     somebody is moving alongside her, so it compiles to follow{Mara}. Pinned
//     below in ⑤.
// The fixture carries its own history in `note`, the reasons live in
// verb-effects.ts (`endpointTarget`, `ACCOMPANY_ROW`) — everything else in the
// file is still the pre-port switch's own bytes.
//
//   ① BYTE-IDENTITY. 44,492 (frame × binder) cases — every directive verb the
//      LEXICON declares, crossed with ten object shapes, twelve bound/relation
//      shapes and sixteen binders (two binder families × eight settings of the
//      seven optional predicates), plus the phase/quantity/negation/colour/
//      company/`use` slices and every glyph sentence harvested from the nine
//      shipped intent suites — were compiled by the PRE-PORT compiler and frozen
//      in fixtures/verb-effects-golden.json. Today's compiler must answer each
//      one with the same bytes. The fixture's `signature` pins the CASE LIST
//      too, so a corpus edit cannot silently re-baseline the answers.
//
//   ② COVERAGE. Every directive verb either has table rows, is served by the
//      default arm's probes, is the `use` intercept, or is in the documented
//      `UNMAPPED_VERBS` set — and an UNMAPPED verb really does compile to null.
//      A word cannot quietly gain or lose a meaning.
//
//   ③ ROW ORDER. Row order IS the rule (it is what made the port identical), so
//      three representative ladders are pinned literally: `carry` (its whole
//      difference from `take` is two swapped rows), `build` (category → founding
//      → makeable → structure) and `break` (furniture → room → feature).
//
// Pure — no DB, no GL. Runs under `npm run test:engine -- verb-effects`.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "@jest/globals";

import { compileAction } from "@shared/world-engine/interaction/intent/intent-compile.js";
import {
  CATEGORY_NEEDS,
  DEFAULT_ROWS,
  INGEST_VERBS,
  REST_VERBS,
  SELF_NEEDS,
  TRANSFORM_STATE,
  UNMAPPED_VERBS,
  VERB_EFFECTS,
  verbEffectRows,
} from "@shared/world-engine/interaction/intent/verb-effects.js";
import { LEXICON } from "@shared/world-engine/interaction/intent/parse-intent.js";
import type { IntentFrame, Ref } from "@shared/world-engine/interaction/intent/parse-intent.js";
import {
  BINDERS,
  DIRECTIVE_VERBS,
  buildCorpus,
  canonical,
  corpusSignature,
  goldenOutputs,
  type GoldenFixture,
} from "./fixtures/verb-effects-corpus.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = JSON.parse(
  readFileSync(path.join(here, "fixtures", "verb-effects-golden.json"), "utf8"),
) as GoldenFixture;

// ---------------------------------------------------------------------------
// ① BYTE-IDENTITY
// ---------------------------------------------------------------------------

describe("① the effect table compiles byte-identically to the switch it replaced", () => {
  const cases = buildCorpus();
  const want = goldenOutputs(FIXTURE);

  it("the corpus is the one the fixture was recorded from (no silent re-baseline)", () => {
    expect(cases.length).toBe(FIXTURE.corpusSize);
    expect(corpusSignature(cases)).toBe(FIXTURE.signature);
  });

  it("the fixture says where its answers came from — a re-record must extend that list", () => {
    // The signature above stops a CORPUS edit from re-baselining the answers
    // silently. This stops a ruled re-baseline from becoming an anonymous wall
    // of new ones: the file carries its own history, one line per recording.
    expect(FIXTURE.note?.length).toBeGreaterThanOrEqual(3);
    expect(FIXTURE.note?.[0]).toMatch(/RECORDED from the PRE-PORT compiler/);
    expect(FIXTURE.note?.[1]).toMatch(/RE-BASELINED, 279 of 44,492 cases/);
    expect(FIXTURE.note?.[2]).toMatch(/RE-BASELINED, 39 of 44,492 cases/);
  });

  it("the corpus is big enough to mean something", () => {
    // Not a magic number so much as a floor: if a future edit shrinks the sweep
    // by an order of magnitude the pin above still passes and this one does not.
    expect(cases.length).toBeGreaterThan(30_000);
    // …and it must actually REACH the compiler: a corpus of nulls proves nothing.
    expect(want.filter((o) => o !== "null").length).toBeGreaterThan(20_000);
    // Every GoalSpec kind the compiler can emit is exercised. (`canonical` is
    // deliberately NOT JSON — it keeps `undefined`-valued keys as `<undefined>`
    // so the port has to reproduce even those — so read the kind by pattern.)
    const kinds = new Set(
      want.filter((o) => o !== "null").map((o) => /"kind":"([a-zA-Z]+)"/.exec(o)?.[1] ?? "?"),
    );
    expect(kinds).not.toContain("?");
    expect(kinds.size).toBeGreaterThanOrEqual(28);
  });

  it("every case answers with the same bytes", () => {
    const bad: string[] = [];
    for (let i = 0; i < cases.length; i++) {
      const c = cases[i]!;
      const binder = BINDERS[c.binder];
      expect(binder).toBeDefined();
      const got = canonical(compileAction(c.frame, binder!));
      if (got !== want[i] && bad.length < 20) bad.push(`${c.id}\n  want ${want[i]}\n  got  ${got}`);
      else if (got !== want[i]) bad.push("…");
    }
    expect(bad).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// ② COVERAGE — no verb falls off the table unnoticed
// ---------------------------------------------------------------------------

/** The default arm serves a verb only through one of its verb-keyed probes. */
const servedByDefaultArm = (v: string): boolean =>
  v in CATEGORY_NEEDS ||
  v in TRANSFORM_STATE ||
  INGEST_VERBS.has(v) ||
  REST_VERBS.has(v) ||
  SELF_NEEDS.has(v) ||
  v === "wear";

/** `use` never reaches the table: it is rewritten to the station's own verb first. */
const INTERCEPT_VERBS = new Set(["use"]);

describe("② every directive verb is accounted for", () => {
  it("the LEXICON's directive verbs are the compiler's whole input alphabet", () => {
    const fromLexicon = Object.entries(LEXICON)
      .filter(([, lex]) => (lex as { cat: string; directive?: boolean }).cat === "verb" && (lex as { directive?: boolean }).directive === true)
      .map(([w]) => w)
      .sort();
    expect(DIRECTIVE_VERBS).toEqual(fromLexicon);
    expect(DIRECTIVE_VERBS.length).toBe(58);
  });

  it("each one has rows, is served by the default arm, is an intercept, or is UNMAPPED", () => {
    const orphans = DIRECTIVE_VERBS.filter(
      (v) => !(v in VERB_EFFECTS) && !servedByDefaultArm(v) && !INTERCEPT_VERBS.has(v) && !UNMAPPED_VERBS.has(v),
    );
    expect(orphans).toEqual([]);
  });

  it("UNMAPPED_VERBS is the documented set, and every member really compiles to null", () => {
    // `do` is in the set for the record; it is not a DIRECTIVE verb (it is the
    // broad "what are you doing" question focus), so it never reaches here.
    expect([...UNMAPPED_VERBS].sort()).toEqual(
      ["ask", "dig", "do", "fix", "plant", "pull", "push", "teach", "turn"],
    );
    const unmappedDirectives = DIRECTIVE_VERBS.filter((v) => UNMAPPED_VERBS.has(v));
    expect(unmappedDirectives.sort()).toEqual(["ask", "dig", "fix", "plant", "pull", "push", "teach", "turn"]);

    const ent = (symbol: string): Ref => ({ kind: "entity", symbol, modifiers: [] });
    const probes: Array<Partial<IntentFrame>> = [
      {},
      { object: ent("ball") },
      { object: ent("mara") },
      { object: ent("tree") },
      { object: ent("house"), quantity: "two" },
      { object: ent("ball"), target: ent("box"), relation: "to", bound: [{ relation: "to", ref: ent("box") }] },
      { object: ent("ball"), target: ent("mara"), relation: "for", bound: [{ relation: "for", ref: ent("mara") }] },
    ];
    for (const v of unmappedDirectives) {
      for (const bk of ["blind/allTrue", "class/allTrue", "blind/absent"]) {
        for (const p of probes) {
          const frame: IntentFrame = { kind: "command", verb: v, modifiers: [], raw: [v], ...p };
          expect({ verb: v, binder: bk, goal: compileAction(frame, BINDERS[bk]!) }).toEqual({ verb: v, binder: bk, goal: null });
        }
      }
    }
  });

  it("an UNMAPPED verb has no rows of its own — it falls to the default arm and misses there", () => {
    for (const v of DIRECTIVE_VERBS.filter((x) => UNMAPPED_VERBS.has(x))) {
      expect(VERB_EFFECTS[v]).toBeUndefined();
      expect(verbEffectRows(v)).toBe(DEFAULT_ROWS);
    }
  });
});

// ---------------------------------------------------------------------------
// ③ ROW ORDER IS THE RULE
// ---------------------------------------------------------------------------

const ladder = (verb: string): Array<{ guards: string[]; effect: string }> =>
  verbEffectRows(verb).map((r) => ({ guards: [...r.guards], effect: r.effect }));

describe("③ row order is the rule — three ladders pinned literally", () => {
  it("`carry` prefers a CONTAINER destination where `take` prefers a RECIPIENT", () => {
    expect(ladder("carry")).toEqual([
      { guards: ["item:object", "hasBound:to", "place:to"], effect: "putIn" },
      { guards: ["item:object", "hasBound:to", "creature:to"], effect: "give" },
      { guards: ["item:object", "beneficiary"], effect: "give" },
      { guards: ["item:object", "source"], effect: "fetch" },
      { guards: ["item:object"], effect: "fetch" },
      { guards: ["source"], effect: "fetch" },
    ]);
    expect(ladder("take")).toEqual([
      { guards: ["item:object", "hasBound:to", "creature:to"], effect: "give" },
      { guards: ["item:object", "hasBound:to", "place:to"], effect: "putIn" },
      { guards: ["item:object", "beneficiary"], effect: "give" },
      { guards: ["item:object", "source"], effect: "fetch" },
      { guards: ["item:object"], effect: "fetch" },
      { guards: ["source"], effect: "fetch" },
    ]);
    // The WHOLE difference between the two words is those first two rows.
    expect(ladder("carry").slice(2)).toEqual(ladder("take").slice(2));
    // …and get / pick_up read exactly as take does.
    expect(ladder("get")).toEqual(ladder("take"));
    expect(ladder("pick_up")).toEqual(ladder("take"));
  });

  it("`build` reads category → founding → makeable(non-structure) → structure", () => {
    expect(ladder("build")).toEqual([
      { guards: ["categoryNeed"], effect: "satisfy" },
      { guards: ["no:objectSymbol"], effect: "build" },
      { guards: ["objectSymbol", "makeable", "isStructure.not:object"], effect: "craft" },
      { guards: ["objectSymbol"], effect: "build" },
    ]);
    // MAKE vs BUILD (user law 2026-07-28): the same rows, OPPOSITE priority —
    // `make` reaches the makeable reading unconditionally and has no bare arm.
    expect(ladder("make")).toEqual([
      { guards: ["categoryNeed"], effect: "satisfy" },
      { guards: ["objectSymbol", "makeable"], effect: "craft" },
      { guards: ["objectSymbol"], effect: "build" },
    ]);
  });

  it("`break` reads furniture → room → feature, narrowest and most recoverable first", () => {
    expect(ladder("break")).toEqual([
      { guards: ["has:object", "isFurniture:object", "item:object"], effect: "breakPiece" },
      { guards: ["objectSymbol", "isStructure:object"], effect: "demolish" },
      { guards: ["objectSymbol", "isFeature:object"], effect: "clearFeature" },
    ]);
    // ⚖️ `cut` and `fight` carry the clearing reading and NOTHING else — the
    // object gate is the whole of "`fight` does not eat combat".
    expect(ladder("cut")).toEqual([{ guards: ["objectSymbol", "isFeature:object"], effect: "clearFeature" }]);
    expect(ladder("fight")).toEqual(ladder("cut"));
  });

  it("the default arm keeps its six probes in order (the rest probe is two rows, two channels)", () => {
    expect(ladder("__no_such_verb__")).toEqual([
      { guards: ["categoryNeed"], effect: "satisfy" },
      { guards: ["transformVerb", "item:object"], effect: "transform" },
      { guards: ["ingestVerb", "item:object"], effect: "consume" },
      { guards: ["verb:wear", "isClothing:object", "item:object"], effect: "wear" },
      { guards: ["restVerb", "noCompanions", "creature:station"], effect: "rest" },
      { guards: ["restVerb", "noCompanions", "place:station"], effect: "rest" },
      { guards: ["selfNeed"], effect: "satisfy" },
    ]);
  });

  it("🚨 SYNONYMS STAY ENUMERATED — the table names every word, VERB_FAMILY is never applied", () => {
    // `take`→`get`, `bring`→`give`, `come`/`run`→`go`, `chase`→`follow`,
    // `wait`→`stay` are the parser's families. Each word has its OWN key here;
    // folding them would be a behaviour change wearing a refactor's clothes.
    for (const w of ["get", "take", "pick_up", "carry", "give", "bring", "share", "go", "come", "run", "return", "follow", "chase", "stay", "wait"]) {
      expect(VERB_EFFECTS[w]).toBeDefined();
    }
    // …and the fold would NOT be a no-op: these pairs read differently.
    expect(ladder("carry")).not.toEqual(ladder("take"));
    expect(ladder("return")).not.toEqual(ladder("go"));
  });
});

// ---------------------------------------------------------------------------
// ④ `with` IS COMPANY, NEVER AN ENDPOINT — the one ruled re-baseline
// ---------------------------------------------------------------------------

describe("④ a companion cannot steal an endpoint (2026-09-08 ruling; the 279-case re-baseline)", () => {
  const ent = (symbol: string): Ref => ({ kind: "entity", symbol, modifiers: [] });
  /** The frame shape the parser leaves for "<verb> [obj] with mara": the LAST
   *  relation-marked noun owns `target`, and every marked pair stays in `bound`. */
  const withMara = (verb: string, object?: Ref, before?: { relation: string; ref: Ref }): IntentFrame => ({
    kind: "command",
    verb,
    modifiers: [],
    raw: [verb],
    ...(object ? { object } : {}),
    target: ent("mara"),
    relation: "with",
    bound: [...(before ? [before] : []), { relation: "with", ref: ent("mara") }],
  });
  const binder = BINDERS["blind/allTrue"]!; // the kind-BLIND family: mara binds on every channel

  it("the endpoint readings look straight past her — the sentence reads as if `with` were absent", () => {
    // Movement: with an object ⇒ the object; with an earlier `to` ⇒ that place.
    // Neither is Mara, however late in the sentence she was said.
    expect(compileAction(withMara("go", ent("kitchen")), binder)).toEqual({
      kind: "goTo", place: { kind: "named", id: "kitchen" },
    });
    expect(compileAction(withMara("go", undefined, { relation: "to", ref: ent("kitchen") }), binder)).toEqual({
      kind: "goTo", place: { kind: "named", id: "kitchen" },
    });
    // Waiting: the optional place stays the KEY-PRESENT undefined it always was.
    expect(compileAction(withMara("stay"), binder)).toEqual({ kind: "stay", place: undefined });
    // Pursuit: whom you end up beside is an endpoint too — a named quarry wins,
    // and the companion never becomes one.
    expect(compileAction(withMara("follow", ent("dog")), binder)).toEqual({ kind: "follow", target: "dog" });
    // What a companion-only movement sentence compiles to is ⑤'s subject: SHE
    // is still not the destination — there is none — she is who you go with.
    expect(compileAction(withMara("go"), binder)).not.toMatchObject({ kind: "goTo" });
  });

  it("…while the PARTNER readings still depend on her, on the very same frame shape", () => {
    // The boundary of the rule. Which way a row reads a `with` phrase is a
    // property of the ROLE SOURCE it cites, so these need no per-verb branch.
    expect(compileAction(withMara("talk"), binder)).toEqual({ kind: "converse", target: "mara" });
    expect(compileAction(withMara("hug"), binder)).toMatchObject({ kind: "socialAct", target: "mara" });
    expect(compileAction(withMara("help"), binder)).toEqual({ kind: "help", target: "mara" });
    expect(compileAction(withMara("trade", ent("wood")), binder)).toMatchObject({ kind: "trade", partner: "mara" });
    expect(compileAction(withMara("play"), binder)).toMatchObject({ kind: "satisfy", need: "play" });
    // Acquisition was already companion-blind — `with` is not an endpoint
    // RELATION, so `from`/`to`/`for` could never have been filled by it. Pinned
    // because the ruling names acquisition and this is why it did not move.
    expect(compileAction(withMara("get", ent("ball")), binder)).toEqual({
      kind: "fetch", item: { match: { kind: "ball" } },
    });
  });
});

// ---------------------------------------------------------------------------
// ⑤ GOING ALONG WITH SOMEBODY
// ---------------------------------------------------------------------------

describe("⑤ movement + company − endpoint ⇒ go ALONG with them (2026-09-08 ruling; 39 cases)", () => {
  const ent = (symbol: string): Ref => ({ kind: "entity", symbol, modifiers: [] });
  /** "<verb> [obj] with <who>" — the shape the parser leaves (see ④). */
  const withRef = (verb: string, ref: Ref, object?: Ref, before?: { relation: string; ref: Ref }): IntentFrame => ({
    kind: "command",
    verb,
    modifiers: [],
    raw: [verb],
    ...(object ? { object } : {}),
    target: ref,
    relation: "with",
    bound: [...(before ? [before] : []), { relation: "with", ref }],
  });
  const withMara = (verb: string, object?: Ref, before?: { relation: string; ref: Ref }): IntentFrame =>
    withRef(verb, ent("mara"), object, before);

  // The two binder families answer this rule DIFFERENTLY on purpose, and the
  // difference is the whole of "a box is not somebody": kind-blind binds every
  // noun on every channel, classifier-backed keeps the three disjoint.
  const blind = BINDERS["blind/allTrue"]!;
  const classified = BINDERS["class/allTrue"]!;

  it("every movement word says it — one shared row, six verbs", () => {
    for (const verb of ["go", "come", "run", "return", "follow", "chase"]) {
      expect(compileAction(withMara(verb), blind)).toEqual({ kind: "follow", target: "mara" });
    }
  });

  it("the row is ONE object, shared by reference the way the synonym groups share arrays", () => {
    // Not a copy per verb: six lists, one reading. (`return` keeps its bare
    // home row after it, which is why the index differs there.)
    const row = VERB_EFFECTS.go!.at(-1)!;
    expect(row.guards).toEqual(["hasBound:with", "no:endpoint", "creature:with"]);
    expect(row.effect).toBe("follow");
    for (const verb of ["come", "run", "follow", "chase"]) {
      expect(VERB_EFFECTS[verb]!.at(-1)).toBe(row);
    }
    // `return`: the accompany row sits ABOVE the bare `goHome` fall-through, so
    // company outranks the home a BARE return would have gone to.
    const ret = VERB_EFFECTS.return!;
    expect(ret.at(-2)).toBe(row);
    expect(ret.at(-1)).toMatchObject({ guards: [], effect: "goHome" });
  });

  it("an ENDPOINT always wins — the row is what is left when the sentence states none", () => {
    // Every shape that names somewhere to go is answered by a row ABOVE it.
    expect(compileAction(withMara("go", undefined, { relation: "to", ref: ent("kitchen") }), blind)).toEqual({
      kind: "goTo", place: { kind: "named", id: "kitchen" },
    });
    expect(compileAction(withMara("go", ent("kitchen")), blind)).toEqual({
      kind: "goTo", place: { kind: "named", id: "kitchen" },
    });
    expect(compileAction(withMara("go", undefined, { relation: "to", ref: ent("home") }), blind)).toEqual({
      kind: "goHome",
    });
    // …and pursuit that names its quarry follows the quarry, not the company.
    expect(compileAction(withMara("follow", ent("dog")), blind)).toEqual({ kind: "follow", target: "dog" });
  });

  it("🚨 a `with`-marked THING is still the honest not-understood — never 'follow the box'", () => {
    // The animacy gate is `companionsOf`'s, stated once: whoever the party is,
    // the body you walk beside and the party that rides `companions` are the
    // same reading of the same phrase.
    expect(compileAction(withRef("go", ent("box")), classified)).toBeNull();
    expect(compileAction(withRef("run", ent("ball")), classified)).toBeNull();
    // A binder that says outright she is no companion is obeyed too.
    const notCompanion = BINDERS["blind/allFalse"]!;
    expect(compileAction(withMara("go"), notCompanion)).toBeNull();
  });

  it("the SPEAKER can be the company — 'come with me' follows the one who said it", () => {
    // Deixis is animate by construction and never consults the animacy gate.
    expect(compileAction(withRef("come", { kind: "player" }), classified)).toEqual({
      kind: "follow", target: "child",
    });
  });

  it("an unresolved 'we'/'together' group names nobody to walk beside — still null", () => {
    // The row needs a BODY. A group the pure layer cannot resolve is company
    // (it rides `companions`), but it is not a creature to follow.
    const together: IntentFrame = { kind: "command", verb: "go", modifiers: [], raw: ["go"], joint: true };
    expect(compileAction(together, blind)).toBeNull();
  });

  it("stay/wait/stop are UNTOUCHED — waiting with somebody is waiting where you are", () => {
    for (const verb of ["stay", "wait"]) {
      expect(compileAction(withMara(verb), blind)).toEqual({ kind: "stay", place: undefined });
    }
    expect(compileAction(withMara("stop"), blind)).toEqual({ kind: "stay", place: undefined });
  });
});
