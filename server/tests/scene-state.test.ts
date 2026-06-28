/**
 * Phase 2/3 cost-saving — scene_state escalation logic. While the scene is
 * stable the client sends cheap TEXT instead of JPEG frames; a real frame fires
 * only on a material change. These tests pin the escalation decision (the risky
 * bit) — especially that a face LOST escalates as "left_frame" (Phase 3 safety
 * decoupling) and that routine expression/motion flicker stays text.
 * See planning-docs/aac-cost-saving-spec.md §2-3.
 */

import { describe, it, expect } from "@jest/globals";
import {
  buildSceneStateText,
  sceneSignature,
  classifyScene,
  renderSceneForObserver,
  type SceneSnapshot,
  type ScenePerson,
  type IdentifiedForScene,
} from "../../shared/aac/scene-state.js";

const snap = (people: ScenePerson[], hands: string[] = [], motion?: number): SceneSnapshot =>
  ({ people, hands, motion });

describe("buildSceneStateText", () => {
  it("renders people with expressions, hands, and coarse motion", () => {
    const t = buildSceneStateText(snap([{ name: "Mom", expression: "smile" }], ["wave"], 0.3));
    expect(t).toContain("people:1");
    expect(t).toContain("Mom, smile");
    expect(t).toContain("hands:wave");
    expect(t).toContain("motion:lots");
  });

  it("prefers the comprehensive movement description when present", () => {
    const t = buildSceneStateText(snap([{ name: "Mom", expression: "smile", movement: "looking at camera, smiling, nodding x2" }]));
    expect(t).toContain("Mom, looking at camera, smiling, nodding x2");
  });

  it("says people:0 with no faces", () => {
    expect(buildSceneStateText(snap([]))).toContain("people:0");
  });
});

describe("renderSceneForObserver — swaps in server identities", () => {
  const box = (x: number) => ({ x, y: 0, w: 0.2, h: 0.2 });

  it("labels a tracked person by bbox-IoU against a matched face", () => {
    const people: ScenePerson[] = [
      { name: "person 1", expression: "smile", movement: "looking at camera, smiling, nodding", bbox: box(0.1) },
    ];
    const ided: IdentifiedForScene[] = [
      { name: "Mom", confidence: 0.88, matched: true, isStudent: false, bbox: box(0.1) },
    ];
    const out = renderSceneForObserver(snap(people), ided);
    expect(out).toContain("Mom 88%");
    expect(out).toContain("looking at camera, smiling, nodding");
    expect(out).not.toContain("person 1");
  });

  it("falls back to single-person/single-identity correlation without IoU overlap", () => {
    const people: ScenePerson[] = [{ name: "person 1", bbox: box(0.9) }];
    const ided: IdentifiedForScene[] = [{ name: "Ben", confidence: 0.7, matched: true, isStudent: true, bbox: box(0.0) }];
    const out = renderSceneForObserver(snap(people), ided);
    expect(out).toContain("Ben 70% [student]");
  });

  it("keeps the generic label when nobody is identified", () => {
    const out = renderSceneForObserver(snap([{ name: "person 1", expression: "neutral" }]), []);
    expect(out).toContain("person 1: neutral");
  });

  it("lists identities the tracker didn't see as 'also identified'", () => {
    const people: ScenePerson[] = [{ name: "person 1", bbox: box(0.1) }];
    const ided: IdentifiedForScene[] = [
      { name: "Mom", confidence: 0.9, matched: true, bbox: box(0.1) },
      { name: "Dad", confidence: 0.8, matched: true, bbox: box(0.8) },
    ];
    const out = renderSceneForObserver(snap(people), ided);
    expect(out).toContain("Mom 90%");
    expect(out).toContain("also identified: Dad 80%");
  });

  it("says 'no one visible' with no people and no identities", () => {
    expect(renderSceneForObserver(snap([]), [])).toContain("no one visible");
  });
});

describe("sceneSignature — only material changes flip it", () => {
  it("is stable across expression changes (expression is text-only)", () => {
    const a = sceneSignature(snap([{ name: "Ben", expression: "neutral" }]));
    const b = sceneSignature(snap([{ name: "Ben", expression: "smile" }]));
    expect(a).toBe(b);
  });

  it("changes when a person appears / leaves", () => {
    const one = sceneSignature(snap([{ name: "Ben" }]));
    const two = sceneSignature(snap([{ name: "Ben" }, { name: "Mom" }]));
    expect(one).not.toBe(two);
  });

  it("changes when a hand gesture appears", () => {
    expect(sceneSignature(snap([{ name: "Ben" }]))).not.toBe(
      sceneSignature(snap([{ name: "Ben" }], ["point"])),
    );
  });
});

describe("classifyScene", () => {
  it("sends a frame for the first scene", () => {
    expect(classifyScene(null, snap([{ name: "Ben" }]), "motion settled", null))
      .toMatchObject({ mode: "frame", reason: "first_scene" });
  });

  it("escalates on explicit escalation triggers (safety/wake/startup)", () => {
    const s = snap([{ name: "Ben" }]);
    const sig = sceneSignature(s);
    expect(classifyScene(sig, s, "safety", 1)).toMatchObject({ mode: "frame", reason: "safety" });
    expect(classifyScene(sig, s, "wake_check", 1)).toMatchObject({ mode: "frame", reason: "wake_check" });
  });

  it("stays TEXT when only expression/motion changed (stable signature)", () => {
    const prev = sceneSignature(snap([{ name: "Ben", expression: "neutral" }]));
    const d = classifyScene(prev, snap([{ name: "Ben", expression: "smile" }], [], 0.3), "motion settled", 1);
    expect(d).toMatchObject({ mode: "text", reason: "stable" });
  });

  it("escalates as 'left_frame' when a person count DROPS (possible fall / leaving)", () => {
    const prev = sceneSignature(snap([{ name: "Ben" }, { name: "Mom" }]));
    const d = classifyScene(prev, snap([{ name: "Ben" }]), "motion settled", 2);
    expect(d).toMatchObject({ mode: "frame", reason: "left_frame" });
  });

  it("escalates ('safety') on a suspected fall, overriding everything else", () => {
    const prev = sceneSignature(snap([{ name: "Ben" }]));
    const s: SceneSnapshot = { people: [{ name: "Ben" }], hands: [], suspectedFall: true };
    expect(classifyScene(prev, s, "motion settled", 1)).toMatchObject({ mode: "frame", reason: "safety" });
  });

  it("escalates ('seizure') when a seizure motion signature is present on a stable scene", () => {
    const prev = sceneSignature(snap([{ name: "Ben" }]));
    const s: SceneSnapshot = {
      people: [{ name: "Ben" }], hands: [],
      seizure: { phase: "clonic", confidence: 0.7, summary: "[MOTION SIGNATURE] rhythmic ~3.3Hz, bilateral" },
    };
    expect(classifyScene(prev, s, "motion settled", 1)).toMatchObject({ mode: "frame", reason: "seizure" });
  });

  it("escalates ('posture_changed') when posture shifts on an otherwise stable scene", () => {
    const s: SceneSnapshot = { people: [{ name: "Ben" }], hands: [], posture: "lying" };
    const prevSig = sceneSignature(s);
    expect(classifyScene(prevSig, s, "motion settled", 1, "upright"))
      .toMatchObject({ mode: "frame", reason: "posture_changed" });
  });

  it("stays TEXT when posture is unchanged", () => {
    const s: SceneSnapshot = { people: [{ name: "Ben" }], hands: [], posture: "upright" };
    const prevSig = sceneSignature(s);
    expect(classifyScene(prevSig, s, "motion settled", 1, "upright"))
      .toMatchObject({ mode: "text", reason: "stable" });
  });

  it("ignores posture transitions involving 'unknown' (noise)", () => {
    const s: SceneSnapshot = { people: [{ name: "Ben" }], hands: [], posture: "upright" };
    const prevSig = sceneSignature(s);
    expect(classifyScene(prevSig, s, "motion settled", 1, "unknown"))
      .toMatchObject({ mode: "text", reason: "stable" });
  });

  it("escalates ('object_shown') on a large background change (something presented)", () => {
    const prev = sceneSignature(snap([{ name: "Ben" }]));
    const s: SceneSnapshot = { people: [{ name: "Ben" }], hands: [], backgroundChange: 0.4 };
    expect(classifyScene(prev, s, "motion settled", 1)).toMatchObject({ mode: "frame", reason: "object_shown" });
  });

  it("stays TEXT when background change is small (normal scene noise)", () => {
    const prev = sceneSignature(snap([{ name: "Ben" }]));
    const s: SceneSnapshot = { people: [{ name: "Ben" }], hands: [], backgroundChange: 0.05 };
    expect(classifyScene(prev, s, "motion settled", 1)).toMatchObject({ mode: "text", reason: "stable" });
  });

  it("escalates ('no_faces') when nobody is identifiable — text tells us least then", () => {
    // Even a 'stable' empty scene sends a frame: an unidentified mover or a
    // safety situation off-camera is exactly when a real look matters most.
    const prev = sceneSignature(snap([]));
    const d = classifyScene(prev, snap([]), "motion settled", 0);
    expect(d).toMatchObject({ mode: "frame", reason: "no_faces" });
  });

  it("escalates as 'scene_changed' when a new person appears", () => {
    const prev = sceneSignature(snap([{ name: "Ben" }]));
    const d = classifyScene(prev, snap([{ name: "Ben" }, { name: "Mom" }]), "motion settled", 1);
    expect(d).toMatchObject({ mode: "frame", reason: "scene_changed" });
  });

  it("escalates when a new hand gesture appears (user may want attention)", () => {
    const prev = sceneSignature(snap([{ name: "Ben" }]));
    const d = classifyScene(prev, snap([{ name: "Ben" }], ["hand raise"]), "motion settled", 1);
    expect(d).toMatchObject({ mode: "frame", reason: "scene_changed" });
  });
});
