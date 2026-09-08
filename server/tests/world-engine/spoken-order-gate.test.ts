// THE SPOKEN ORDER, GATED AND ANSWERED — wave-2 W2-5, gap 6 and gap 9.
//
// Three laws this file holds, and one line each:
//
//  ① THE SPOKEN PATH GETS THE PRESS'S GATE (W2-5). `attendTo` has asked
//    `bondStrength(author, actor) < VOLUNTEER_COMPLIANCE` since politics L-2;
//    the SPOKEN order — the one the sentence builder reaches — asked nobody, so
//    a stranger answered "okay" and walked. It now refuses OUT LOUD, in its own
//    bubble, and the refusal is witnessed (`order-refused` charges the asker).
//
//  ② THE REFUSAL NAMES THE PRECONDITION (W2-4). `you + leader.not` — the exact
//    inverse of the yield sentence the child already builds. Not "I won't help
//    you" (which says what, not why), and not a banner.
//
//  ③ A FAILED PRECONDITION *IS* THE REPLY (gap 6). "stop eating" to a body that
//    is not eating answers `i_me + eat.not` and halts nothing. An UNVERIFIABLE
//    activity is never a denial — the order lands exactly as it shipped.
//
//  ④ COMPANY SURVIVES THE COMPILE (gap 9). "get the basket WITH Pip" issues the
//    goal to both, party-style — one rule at the dispatch, never per verb.
//
// DB-free / GL-free — `npm run test:engine`. ONE boot (the show-item pattern):
// the dollhouse boot is the expensive part and every phase wants the world the
// previous one leaves.

import { describe, it, expect } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseSentence } from "@shared/world-engine/interaction/intent/parse-intent.js";
import {
  compileIntent,
  defaultBinder,
  type IntentBinder,
} from "@shared/world-engine/interaction/intent/intent-compile.js";
import {
  NO_BOND,
  notDoingLine,
  WONT_HELP_YOU,
} from "@shared/world-engine/interaction/dialogue/host-lines.js";
import { translateGlyph } from "@shared/world-engine/interaction/lang/index.js";
import { bootTextQuest } from "@shared/world-engine/headless/text-quest.js";

// ═══════════════════════════════════════════════════════════════════════════
// A. THE LINES — pure, and the whole point of the round is that they RENDER
// ═══════════════════════════════════════════════════════════════════════════

describe("NO_BOND — 'You are not the leader.'", () => {
  it("is the yield sentence, negated — one word, no new vocabulary", () => {
    // The child's own yield ("you + leader") makes somebody a leader; this is
    // its exact inverse, which is what makes the refusal teach the rule that
    // would lift it.
    expect(NO_BOND.c).toBe("you + leader.not");
    expect(NO_BOND.b).toBe("you + leader.not");
    expect(NO_BOND.a).toBe("no"); // the reserved one-word refusal, like WONT_HELP_YOU
    expect(WONT_HELP_YOU.a).toBe("no");
    // …and it is NOT WONT_HELP_YOU: that one says what this body will not do,
    // this one says why. The press gate keeps the first; the sentence gets both.
    expect(NO_BOND.c).not.toBe(WONT_HELP_YOU.c);
  });

  it("renders in all four shipped rulesets (B2's `neg` regard frame)", () => {
    expect(translateGlyph(NO_BOND.c, "en")).toBe("You are not the leader.");
    expect(translateGlyph(NO_BOND.c, "he")).toBe("אתה לא המנהיג.");
    expect(translateGlyph(NO_BOND.c, "es")).toBe("No eres el líder.");
    expect(translateGlyph(NO_BOND.c, "pt")).toBe("Você não é o líder.");
  });

  it("agrees with the ADDRESSEE's gender in Hebrew, like every other line", () => {
    expect(translateGlyph(NO_BOND.c, "he", { addressee: "f" })).toBe("את לא המנהיגה.");
  });
});

describe("notDoingLine — the failed precondition, spoken", () => {
  it("is `i_me + {verb}.not` — the verb the CHILD just said, so never a new word", () => {
    expect(notDoingLine("eat").c).toBe("i_me + eat.not");
    expect(notDoingLine("play").c).toBe("i_me + play.not");
    expect(notDoingLine("eat").a).toBe("no");
  });

  it("renders in all four shipped rulesets", () => {
    // ⚠️ English alone reads HABITUAL rather than progressive ("I don't eat");
    // the other three carry both readings in the one form. Pinned as shipped so
    // an aspect fix is a deliberate change, not a surprise.
    expect(translateGlyph(notDoingLine("eat").c, "en")).toBe("I don't eat.");
    expect(translateGlyph(notDoingLine("eat").c, "he")).toBe("אני לא אוכל.");
    expect(translateGlyph(notDoingLine("eat").c, "es")).toBe("No como.");
    expect(translateGlyph(notDoingLine("eat").c, "pt")).toBe("Eu não como.");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// B. WHAT THE HOST CONSUMES — B5a's compile output, pinned at the seam
// ═══════════════════════════════════════════════════════════════════════════

const ITEMS = new Set(["basket", "ball", "wood", "apple"]);
const PEOPLE = new Set(["pip", "mara"]);
const classify = (sym: string): "place" | "item" | "creature" | "unknown" =>
  ITEMS.has(sym) ? "item" : PEOPLE.has(sym) ? "creature" : "unknown";
const makeBinder = (): IntentBinder => defaultBinder({ player: "child", listener: "bear" });
const compile = (sentence: string) =>
  compileIntent(parseSentence(sentence, { classifyEntity: classify }), makeBinder(), { id: "s1" });

describe("the compile seam the host reads", () => {
  it("'stop + eat' carries the precondition it assumed; bare 'stop' assumes nothing", () => {
    expect(compile("stop + eat")).toMatchObject({
      kind: "goal",
      goal: { kind: "stay" },
      preconditions: [{ kind: "doing", verb: "eat" }],
    });
    const bare = compile("stop") as { preconditions?: unknown };
    expect(bare).toMatchObject({ kind: "goal", goal: { kind: "stay" } });
    expect(bare.preconditions).toBeUndefined();
  });

  it("'get + ball + with + pip' names the company on EVERY kind, not just satisfy", () => {
    expect(compile("get + ball + with + pip")).toMatchObject({
      kind: "goal",
      goal: { kind: "fetch" },
      companions: { kind: "creatures", ids: ["pip"] },
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// C. LIVE ON THE DOLLHOUSE — one boot, four phases
// ═══════════════════════════════════════════════════════════════════════════

const specPath = join(process.cwd(), "games", "dollhouse", "src", "game.spec.json");
const doc = JSON.parse(readFileSync(specPath, "utf8"));

describe("live on the dollhouse — who takes an order, and what a refusal says", () => {
  it("gates the spoken order on the bond, answers the precondition, and fans a companion out", () => {
    const run = bootTextQuest({ world: doc, dt: 1 / 10 });
    try {
      run.advance(6);
      const s = run.session;
      const hi = s.dollhouse!;
      const head = `resident_${hi}_0`;
      // The peer AUTHOR of phase ②. It needs no dialogue node — only a
      // relation — which is exactly what makes it a usable stand-in for the
      // stranger the shipped worlds do not contain (see the round note).
      const mate = `resident_${hi}_1`;
      // The COMPANION of phase ④. A headless dollhouse boot registers the
      // house's first resident and its pet and nothing else, so the pet is the
      // one live second body — and it is `playerGroup` like every housemate, so
      // it exercises the fan-out and not the gate.
      const pet = `pet_${hi}_0`;
      const headName = (run.host.nameOf(head) ?? "").toLowerCase();
      const petName = (run.host.nameOf(pet) ?? "").toLowerCase();
      expect(headName).not.toBe("");
      expect(petName).not.toBe("");
      const syntax = s.meta.syntax;
      const bubble = (cid: string): string | undefined =>
        run.state.bubbles[`char:resident_face:${cid}`]?.glyph;
      // A PEER'S SENTENCE. `applySpokenSentence` sits below the gate and off the
      // public `QuestHost3D` surface on purpose (a game presses and speaks, it
      // never acts directly) — but a relayed peer utterance is precisely what
      // `applyRemoteCommand` hands it, and that door needs a multiplayer owner
      // role a headless boot has no business inventing. So the executor is
      // reached directly, with the same opts the wire would carry.
      const sayAs = (sentence: string, speakerCid: string): void =>
        (run.host as unknown as {
          applySpokenSentence(s: string, o: { speakerCid?: string }): void;
        }).applySpokenSentence(sentence, { speakerCid });

      // ── ① THE PLAYER'S OWN HOUSEHOLD IS BOND 1 — byte-identical ──────────
      // `playerGroup` holds the kept household by construction, so the gate is
      // a no-op here and the shipped echo stands. THIS is why the dollhouse
      // bench cannot move on this hunk.
      run.speak(`${headName} + get + basket`);
      expect(s.pursuits.get(head)?.source).toBe("command");
      expect(bubble(head)).not.toBe(NO_BOND[syntax]);

      // ── ② A PEER AUTHOR WITH NO BOND IS REFUSED, ALOUD ───────────────────
      // The same sentence, authored by a HOUSEMATE instead of the spirit. A
      // resident's edge toward another resident is the neutral default
      // (`deference` ≈ 0.07 < VOLUNTEER_COMPLIANCE), so the order is turned
      // down — and the answer names the missing precondition rather than
      // vanishing into a banner.
      s.pursuits.delete(head);
      sayAs(`${headName} + get + basket`, mate);
      expect(bubble(head)).toBe(NO_BOND[syntax]);
      expect(s.pursuits.has(head)).toBe(false); // SKIPPED — never a silent obey

      // ── ③ THE PRECONDITION IS THE REPLY ──────────────────────────────────
      // Put the body on a real errand first, so its activity is VERIFIABLE and
      // is not "eat"; "stop eating" then corrects the premise and halts nothing.
      run.speak(`${headName} + get + basket`);
      expect(s.pursuits.get(head)?.source).toBe("command");
      run.speak(`${headName} + stop + eat`);
      expect(bubble(head)).toBe(notDoingLine("eat")[syntax]);
      expect(s.pursuits.get(head)?.source).toBe("command"); // nothing was halted

      // …and the same sentence about what it IS doing falls straight through to
      // the shipped halt arm (the precondition HOLDS — no correction).
      run.speak(`${headName} + stop + get`);
      expect(bubble(head)).not.toBe(notDoingLine("get")[syntax]);

      // ── ④ COMPANY IS ISSUED TO BOTH (gap 9) ──────────────────────────────
      s.pursuits.delete(head);
      s.pursuits.delete(pet);
      run.speak(`${headName} + get + basket + with + ${petName}`);
      expect(s.pursuits.get(head)?.source).toBe("command");
      expect(s.pursuits.get(pet)?.source).toBe("command"); // the partner the child NAMED
      expect(run.presenterLog().lastToast).toContain("party (2)");

      // …and a `satisfy` is NOT fanned out: a shared need is one PERFORMANCE
      // two bodies attend (`goal.with` → the ritual path), not the same solo
      // goal handed to each. Byte-identical to what shipped.
      s.pursuits.delete(head);
      s.pursuits.delete(pet);
      run.speak(`${headName} + play + with + ${petName}`);
      expect(s.pursuits.has(head)).toBe(false);
      expect(s.pursuits.has(pet)).toBe(false);
    } finally {
      run.dispose();
    }
  });
});
