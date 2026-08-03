// The two pure decisions behind the sleep overlay, with SLP MODE as the
// subject: there the overlay is a curtain a therapist draws back by hand, so
// it must never resolve itself on a timer or because a face appeared.
import { describe, it, expect } from "@jest/globals";
import {
  computePhase,
  stageForPhase,
  slpStageFor,
  initialStageFor,
  overlayAwaitsPress,
} from "./sleepOverlayLogic";
import type { SleepState } from "./cameraAttentivenessTypes";

const phase = (
  over: Partial<{
    isInitialized: boolean;
    isLoading: boolean;
    sleepState: SleepState;
    errorFrozen: boolean | null;
    faceLost: boolean;
    slpMode: boolean;
  }> = {},
) => {
  const o = {
    isInitialized: true,
    isLoading: false,
    sleepState: "awake" as SleepState,
    errorFrozen: null as boolean | null,
    faceLost: true,
    slpMode: false,
    ...over,
  };
  return computePhase(
    o.isInitialized, o.isLoading, o.sleepState, o.errorFrozen, o.faceLost, o.slpMode,
  );
};

describe("computePhase — the face exemption", () => {
  it("keeps the board usable when asleep with the student in frame (normal mode)", () => {
    expect(phase({ sleepState: "asleep", faceLost: false })).toBe("awake");
  });

  it("fades to the overlay when asleep and nobody is in frame (normal mode)", () => {
    expect(phase({ sleepState: "asleep", faceLost: true })).toBe("sleep");
  });

  it("SLP MODE: asleep is asleep, whoever is in frame", () => {
    // The therapist carries the device; a face proves nothing about whether
    // the student is at it, and may well be the therapist's own. It also stops
    // a face appearing mid-sleep from raising a "Ready" curtain over a session
    // that never actually woke.
    expect(phase({ sleepState: "asleep", faceLost: false, slpMode: true })).toBe("sleep");
    expect(phase({ sleepState: "asleep", faceLost: true, slpMode: true })).toBe("sleep");
  });

  it("SLP MODE does not disturb the non-asleep phases", () => {
    expect(phase({ isLoading: true, slpMode: true })).toBe("wake");
    expect(phase({ sleepState: "waking", slpMode: true })).toBe("wake");
    expect(phase({ isInitialized: false, slpMode: true })).toBe("sleep");
    expect(phase({ slpMode: true })).toBe("awake");
    // The connection-error freeze still overrides everything.
    expect(phase({ errorFrozen: true, slpMode: true })).toBe("sleep");
    expect(phase({ errorFrozen: false, sleepState: "asleep", slpMode: true })).toBe("awake");
  });
});

describe("stageForPhase — the non-SLP timed machine", () => {
  it("hides itself on a timer once awake", () => {
    expect(stageForPhase("awake")).toEqual({ stage: "waking", autoHide: true });
  });

  it("never auto-hides from sleeping or waking", () => {
    expect(stageForPhase("sleep")).toEqual({ stage: "sleeping", autoHide: false });
    expect(stageForPhase("wake")).toEqual({ stage: "waking", autoHide: false });
  });

  it("'ready' is unreachable outside SLP MODE", () => {
    for (const p of ["sleep", "wake", "awake"] as const) {
      expect(stageForPhase(p).stage).not.toBe("ready");
    }
  });
});

describe("slpStageFor — projected from GLOBAL state", () => {
  it("awake ALWAYS means the overlay is gone — one press, straight to the board", () => {
    // The regression this guards: 'ready' used to sit AFTER the wake, so the
    // therapist pressed once to wake and again to get the board back.
    expect(slpStageFor("awake", false)).toBe("hidden");
    expect(slpStageFor("awake", true)).toBe("hidden");
  });

  it("'ready' is a PRE-wake state: still asleep, someone is just there", () => {
    expect(slpStageFor("sleep", true)).toBe("ready");
    expect(slpStageFor("sleep", false)).toBe("sleeping");
  });

  it("both asleep stages take the same single press", () => {
    // "sleeping" and "ready" differ only in what they say; both are asleep, so
    // the button does the same thing and one press reaches the board.
    for (const ready of [false, true]) {
      expect(overlayAwaitsPress(slpStageFor("sleep", ready))).toBe(true);
    }
  });

  it("is a pure function of its inputs — same inputs, same stage, always", () => {
    // This is what stops the two wake controls desyncing: neither surface can
    // hold an opinion of its own.
    for (const ready of [false, true]) {
      for (const p of ["sleep", "wake", "awake"] as const) {
        expect(slpStageFor(p, ready)).toBe(slpStageFor(p, ready));
      }
    }
  });

  it("a wake in flight shows progress, never a control", () => {
    for (const ready of [false, true]) {
      expect(slpStageFor("wake", ready)).toBe("waking");
    }
  });
});

describe("overlayAwaitsPress — where the wake control belongs", () => {
  it("is the stages waiting on a human, never mid-wake", () => {
    expect(overlayAwaitsPress("sleeping")).toBe(true);
    expect(overlayAwaitsPress("ready")).toBe(true);
    expect(overlayAwaitsPress("waking")).toBe(false);
    expect(overlayAwaitsPress("hidden")).toBe(false);
  });

  it("covers every visible stage SLP MODE can rest on", () => {
    // A visible stage that persists and shows no control would strand the
    // therapist with no way forward — the overlay covers the header where the
    // normal wake/sleep control lives.
    for (const ready of [false, true]) {
      for (const p of ["sleep", "wake", "awake"] as const) {
        const stage = slpStageFor(p, ready);
        if (stage === "waking" || stage === "hidden") continue; // transient / gone
        expect(overlayAwaitsPress(stage)).toBe(true);
      }
    }
  });
});

describe("initialStageFor", () => {
  it("mounts already showing whatever the phase implies", () => {
    expect(initialStageFor("sleep")).toBe("sleeping");
    expect(initialStageFor("wake")).toBe("waking");
    expect(initialStageFor("awake")).toBe("hidden");
  });
});
