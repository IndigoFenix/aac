// Tests for the world speech-bubble layer (shared/world-engine): the ephemeral
// per-avatar `say` state, its one-shot net message, and the renderer-agnostic
// fade clock. Pure logic — no DOM, no DB, no LLM — safe in the default test run.

import { describe, it, expect } from "@jest/globals";
import {
  createWorldState,
  applyInbound,
  applyRemoteAvatar,
  collectOutbound,
  setAvatarSpeech,
  sayMessage,
  type WorldState,
} from "@shared/world-engine/index.js";
import {
  bubbleAlpha,
  layoutBubble,
  DEFAULT_BUBBLE_STYLE,
  BUBBLE_TTL_SECONDS,
  BUBBLE_FADE_SECONDS,
} from "@shared/world-engine/speech-bubble.js";
import { socialFieldSpec } from "@shared/world-engine/specs/social-field.js";

function state(): WorldState {
  return createWorldState(socialFieldSpec, "me", 0);
}

describe("avatar speech state", () => {
  it("stamps say with the current sim time and clears on blank text", () => {
    const s = state();
    s.time = 12.5;
    setAvatarSpeech(s, "me", { text: "hello", glyph: "i_me+want" });
    expect(s.avatars.me.say).toEqual({ text: "hello", glyph: "i_me+want", at: 12.5 });
    setAvatarSpeech(s, "me", { text: "   " });
    expect(s.avatars.me.say).toBeUndefined();
  });

  it("no-ops for an unknown avatar (a say can race ahead of the first packet)", () => {
    const s = state();
    expect(() => setAvatarSpeech(s, "ghost", { text: "hi" })).not.toThrow();
    expect(s.avatars.ghost).toBeUndefined();
  });
});

describe("say over the wire", () => {
  it("builds a say message with and without a glyph", () => {
    expect(sayMessage("p1", "hi")).toEqual({ t: "say", id: "p1", text: "hi" });
    expect(sayMessage("p1", "hi", "i_me")).toEqual({ t: "say", id: "p1", text: "hi", glyph: "i_me" });
  });

  it("applyInbound('say') sets a remote avatar's bubble", () => {
    const s = state();
    applyRemoteAvatar(s, { id: "p2", x: 5, y: 5, fx: 1, fy: 0, vx: 0, vy: 0 });
    s.time = 3;
    applyInbound(s, sayMessage("p2", "over here", "go+here"));
    expect(s.avatars.p2.say).toEqual({ text: "over here", glyph: "go+here", at: 3 });
  });

  it("a later position packet does NOT clobber an existing bubble", () => {
    const s = state();
    applyRemoteAvatar(s, { id: "p2", x: 5, y: 5, fx: 1, fy: 0, vx: 0, vy: 0 });
    applyInbound(s, sayMessage("p2", "stay"));
    applyRemoteAvatar(s, { id: "p2", x: 6, y: 6, fx: 0, fy: 1, vx: 1, vy: 1 });
    expect(s.avatars.p2.say?.text).toBe("stay");
  });

  it("is NOT part of the per-frame outbound stream (sent once, not every tick)", () => {
    const s = state();
    setAvatarSpeech(s, "me", { text: "hi" });
    const out = collectOutbound(s);
    expect(out.some((m) => m.t === "say")).toBe(false);
    expect(out.some((m) => m.t === "avatar")).toBe(true);
  });
});

describe("bubble composed-glyph layout", () => {
  // A minimal 2D-context stand-in: layoutBubble only needs font + measureText.
  function fakeCtx(): CanvasRenderingContext2D {
    return {
      font: "",
      measureText: (s: string) => ({ width: s.length * 8 } as TextMetrics),
    } as unknown as CanvasRenderingContext2D;
  }

  it("reserves a glyph row only when an aspect is given, never stretched", () => {
    const ctx = fakeCtx();
    expect(layoutBubble(ctx, "hi", 0).glyphRowHeight).toBe(0);
    const wide = layoutBubble(ctx, "hi", 3); // a 3-slot glyph: 3:1
    expect(wide.glyphDrawHeight).toBe(DEFAULT_BUBBLE_STYLE.glyphSize);
    // Width follows the aspect exactly (no squashing): 3 × height.
    expect(wide.glyphDrawWidth).toBeCloseTo(3 * DEFAULT_BUBBLE_STYLE.glyphSize, 5);
  });

  it("caps a very wide glyph by scaling BOTH dims (keeps aspect)", () => {
    const ctx = fakeCtx();
    const l = layoutBubble(ctx, "hi", 20); // absurdly wide → must clamp
    const cap = DEFAULT_BUBBLE_STYLE.maxWidth * 1.5;
    expect(l.glyphDrawWidth).toBeLessThanOrEqual(cap + 0.5);
    // Aspect preserved after the clamp.
    expect(l.glyphDrawWidth / l.glyphDrawHeight).toBeCloseTo(20, 5);
  });
});

describe("bubble fade clock", () => {
  it("is full while fresh, eases over the fade window, then zero", () => {
    const at = 100;
    expect(bubbleAlpha(at, at)).toBe(1);
    expect(bubbleAlpha(at, at + (BUBBLE_TTL_SECONDS - BUBBLE_FADE_SECONDS))).toBe(1);
    // Halfway through the fade window → ~0.5.
    expect(bubbleAlpha(at, at + (BUBBLE_TTL_SECONDS - BUBBLE_FADE_SECONDS / 2))).toBeCloseTo(0.5, 5);
    expect(bubbleAlpha(at, at + BUBBLE_TTL_SECONDS)).toBe(0);
    expect(bubbleAlpha(at, at + BUBBLE_TTL_SECONDS + 5)).toBe(0);
  });
});
