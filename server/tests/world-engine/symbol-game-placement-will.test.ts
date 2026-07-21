// The PLACEMENT WILLINGNESS gate (behavior/placement-will.ts) + the lines it
// speaks (dialogue/placement-lines.ts) + the lang rendering of the new
// refusal shapes (construction v1). Pure logic — no DB / LLM / GL.

import { describe, it, expect } from "@jest/globals";
import {
  NATURAL_FLOOR,
  willingnessToPlace,
} from "@shared/world-engine/interaction/behavior/placement-will.js";
import {
  PLACEMENT_OK,
  placementCannotLine,
  placementDoneLine,
  placementVerdictLine,
  placementWontLine,
} from "@shared/world-engine/interaction/dialogue/placement-lines.js";
import { translateGlyph } from "@shared/world-engine/interaction/lang/index.js";
import type { RatedSpot } from "@shared/world-engine/kernel/town/placement.js";

const spot = (score: number, gripe?: RatedSpot["gripe"]): RatedSpot => ({
  x: 0, y: 0, facing: 0, roomId: "h_0", score, factors: gripe ? [gripe] : [],
  ...(gripe !== undefined ? { gripe } : {}),
});

const FAMILY = { affinity: 0.5, trust: 0.8, authority: 0.8 };

describe("willingnessToPlace — the comply / can't / won't matrix", () => {
  it("no candidates ⇒ cannot, with the kernel's failure reason", () => {
    expect(willingnessToPlace({ candidates: [], failure: "door" }))
      .toEqual({ kind: "cannot", reason: "door" });
    expect(willingnessToPlace({ candidates: [] }))
      .toEqual({ kind: "cannot", reason: "service" });
  });

  it("a natural spot places for anyone — no relation needed", () => {
    const s = spot(NATURAL_FLOOR + 0.1);
    expect(willingnessToPlace({ candidates: [s] }))
      .toEqual({ kind: "place", spot: s, reason: "natural" });
  });

  it("a sub-floor spot: a stranger's ask is refused, the family's is obliged", () => {
    const s = spot(0.3, "crowded");
    expect(willingnessToPlace({ candidates: [s] }))
      .toEqual({ kind: "wont", reason: "crowded" });
    expect(willingnessToPlace({ candidates: [s], relation: FAMILY }))
      .toEqual({ kind: "place", spot: s, reason: "obliging" });
  });

  it("even high compliance has a floor — a truly awful spot still refuses", () => {
    // compliance < 1 for the family relation, so threshold > 0.
    const s = spot(0.01, "wrong-room");
    const r = willingnessToPlace({ candidates: [s], relation: FAMILY });
    expect(r).toEqual({ kind: "wont", reason: "wrong-room" });
  });

  it("is deterministic — same input, same verdict", () => {
    const s = spot(0.3, "mid-room");
    const a = willingnessToPlace({ candidates: [s], relation: FAMILY });
    expect(willingnessToPlace({ candidates: [s], relation: FAMILY })).toEqual(a);
  });
});

describe("the spoken verdicts — every grade has a line, rendered per locale", () => {
  const en = (g: string) => translateGlyph(g, "en");
  const he = (g: string) => translateGlyph(g, "he-IL");
  const es = (g: string) => translateGlyph(g, "es");
  const pt = (g: string) => translateGlyph(g, "pt-BR");

  it("cannot (geometric): 'I can't put X there because the place is small'", () => {
    const line = placementCannotLine("chair", "service");
    expect(line.c).toBe("i_me + put.not + chair + because + place + small");
    expect(en(line.c)).toBe("I can't put the chair there because the place is small.");
    expect(he(line.c)).toContain("אני לא יכול לשים");
    expect(es(line.c)).toContain("No puedo poner");
    expect(pt(line.c)).toContain("Não posso pôr");
  });

  it("cannot (not-mine): the mine frame — 'no, my house'", () => {
    const line = placementCannotLine("chair", "not-mine");
    expect(line.b).toBe("no + home.my");
    expect(en(line.b)).toContain("my house");
  });

  it("cannot (have-not): the vendor's noStock shape", () => {
    const line = placementCannotLine("chair", "have-not");
    expect(en(line.c)).toBe("I don't have the chair.");
  });

  it("wont: 'I don't want to put — because the place is not good'", () => {
    const line = placementWontLine();
    expect(line.c).toBe("i_me + want.not + put + because + place + good.not");
    expect(en(line.c)).toBe("I don't want to put because the place isn't good.");
    expect(es(line.c).toLowerCase()).toContain("no");
  });

  it("ok + done lines exist (silence must be explicit)", () => {
    expect(PLACEMENT_OK.c).toBe("ok");
    expect(placementDoneLine("chair").b).toBe("chair + here");
    expect(en(placementDoneLine("chair").b)).toBe("The chair is here.");
  });

  it("the dispatcher maps verdicts to lines (null = accepted)", () => {
    expect(placementVerdictLine("chair", { kind: "place", spot: spot(1), reason: "natural" })).toBeNull();
    expect(placementVerdictLine("chair", { kind: "cannot", reason: "door" })).not.toBeNull();
    expect(placementVerdictLine("chair", { kind: "wont", reason: "crowded" })).not.toBeNull();
  });
});
