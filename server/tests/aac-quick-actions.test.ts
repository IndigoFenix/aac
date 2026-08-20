import { describe, it, expect } from "@jest/globals";
/**
 * The quick-action row's composition. These assert the rules the student's
 * screen and the clinician's mirror BOTH now read from — before this module
 * existed the two derived them separately and had already drifted (the mirror
 * offered board Back + Pause while an app was open; the real row did not).
 */

import { quickActionSlots, quickActionsMirror, type QuickActionsState } from "@shared/aac/quick-actions";

const base: QuickActionsState = { boardMode: "ai" };
const ids = (s: Partial<QuickActionsState>, rtl = false) =>
  quickActionSlots({ ...base, ...s }, rtl).map((x) => x.id);

describe("quickActionSlots", () => {
  it("gives the default AI board the full row in reading order", () => {
    expect(ids({})).toEqual([
      "boardback",
      "boardpause",
      "more",
      "yes",
      "no",
      "home",
      "guess",
      "speak",
    ]);
  });

  it("hides board navigation while an app owns the screen", () => {
    // The regression this module exists to prevent: the mirror used to keep
    // these two slots here, showing a clinician buttons the child did not have.
    const withApp = ids({ hasActiveApp: true });
    expect(withApp).not.toContain("boardback");
    expect(withApp).not.toContain("boardpause");
    expect(withApp).not.toContain("guess");
    expect(withApp).toContain("exit");
  });

  it("puts Speak FIRST in a world-engine game and drops board chrome", () => {
    const game = ids({ worldEngineGame: true, hasActiveApp: true });
    expect(game).toEqual(["speak", "yes", "no", "exit"]);
    // Grid auto-placement never walks backwards, so leading is an ORDER fact,
    // not a style one.
    expect(game[0]).toBe("speak");
  });

  it("shares one slot between Forward and More so the row never changes width", () => {
    const idle = ids({});
    const ahead = ids({ canGoForward: true });
    expect(idle).toContain("more");
    expect(ahead).toContain("boardforward");
    expect(ahead).not.toContain("more");
    expect(ahead.length).toBe(idle.length);
  });

  it("renders board Back even with nowhere to go, dimmed and inert", () => {
    const [back] = quickActionSlots(base, false);
    expect(back.id).toBe("boardback");
    expect(back.enabled).toBe(false);
    const [liveBack] = quickActionSlots({ ...base, canGoBack: true }, false);
    expect(liveBack.enabled).toBe(true);
  });

  it("keeps Pause labelled Pause while held, and only lights it", () => {
    const held = quickActionSlots({ ...base, boardPaused: true }, false)
      .find((s) => s.id === "boardpause")!;
    expect(held.labelKey).toBe("quickActions.pauseBoard");
    expect(held.icon.draw).toBe("pause");
    expect(held.active).toBe(true);
    expect(held.ariaLabelKey).toBe("quickActions.resumeBoard");
  });

  it("turns Speak into Back while the sentence builder is open", () => {
    const speak = quickActionSlots({ ...base, inSentenceBuilder: true }, false)
      .find((s) => s.id === "speak")!;
    expect(speak.labelKey).toBe("quickActions.back");
    expect(speak.active).toBe(true);
    // The builder carries its own Word Finder, so the row drops it.
    expect(ids({ inSentenceBuilder: true })).not.toContain("guess");
  });

  it("points the back arrow against the reading direction", () => {
    const ltr = quickActionSlots({ ...base, canGoBack: true }, false).find((s) => s.id === "boardback")!;
    const rtl = quickActionSlots({ ...base, canGoBack: true }, true).find((s) => s.id === "boardback")!;
    expect(ltr.icon.emoji).toBe("◀");
    expect(rtl.icon.emoji).toBe("▶");
  });

  it("swaps the trailing slot by tier", () => {
    const end = (s: Partial<QuickActionsState>) =>
      quickActionSlots({ ...base, ...s }, false).find((x) => x.id === "home" || x.id === "exit")!;
    expect(end({ currentTier: "latest" }).labelKey).toBe("quickActions.board");
    expect(end({ currentTier: "context" }).labelKey).toBe("quickActions.home");
    expect(end({ currentTier: "home" }).labelKey).toBe("quickActions.back");
    expect(end({ isGuessingMode: true }).labelKey).toBe("quickActions.back");
    expect(end({ hasActiveApp: true }).id).toBe("exit");
  });

  it("gives the prebuilt-board mode its own Back and no AI board chrome", () => {
    expect(ids({ boardMode: "db" })).toEqual(["back", "yes", "no", "home", "speak"]);
  });
});

describe("quickActionsMirror", () => {
  it("projects exactly the slots the child sees", () => {
    const state: QuickActionsState = { boardMode: "ai", hasActiveApp: true };
    const mirror = quickActionsMirror(state, (k) => k, false);
    expect(mirror.map((m) => m.id)).toEqual(quickActionSlots(state, false).map((s) => s.id));
  });

  it("carries an emoji for icons the AAC draws itself", () => {
    // Pause and Yes/No are drawn as SVG on the device; the data channel has no
    // way to carry that, so the mirror falls back to an approximating emoji.
    const mirror = quickActionsMirror({ boardMode: "ai" }, (k) => k, false);
    expect(mirror.find((m) => m.id === "boardpause")?.emoji).toBe("⏸️");
    expect(mirror.find((m) => m.id === "yes")?.emoji).toBe("✓");
    expect(mirror.find((m) => m.id === "no")?.emoji).toBe("✗");
  });
});
