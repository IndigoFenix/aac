// A2 invariant: THE CALL HAS EXACTLY ONE AUDIO OWNER.
//
// shared/call/CallAudioSinks.tsx mounts one <audio> per remote participant for
// the whole call. Every other surface that binds a remote stream to an element
// is VISUAL and must be muted.
//
// Why guard this in source rather than behaviour: the repo's client jest config
// is `testEnvironment: 'node'` and explicitly declines jsdom + testing-library
// ("add a second project here if and when that's wanted, rather than making
// every unit pay for a DOM"). This suite therefore asserts the rule where it
// actually rots — a NEW video surface appearing somewhere in the call path with
// audio left on, which is how the bug got in the first time.
//
// What went wrong before A2: remote audio rode on whichever <video> a layout
// drew, across FOUR surfaces with inconsistent muting.
//   • The shared tile only renders a <video> when the peer has live video, so a
//     camera-off participant was completely inaudible.
//   • With two surfaces mounted at once (the AAC avatar slot and the large
//     video window) the same stream played twice.
//
// If this suite fails, do not just add the file to the inventory — decide first
// whether the surface should own audio. The answer is almost certainly no.

import { describe, it, expect } from "@jest/globals";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, join, relative } from "node:path";

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(resolve(ROOT, rel), "utf8");

/** Directories where a call surface could plausibly live. */
const CALL_DIRS = [
  "shared/call",
  "shared/social-world",
  "client/src/features/call",
  "client-aac/src/components",
];

/**
 * Surfaces that bind a stream to a media element in the call path, and the
 * marker proving each one is muted. The marker is a PIN: change how a file
 * mutes and this fails, forcing the change to be deliberate.
 */
const VISUAL_SURFACES: Array<{ file: string; marker: string; why: string }> = [
  {
    file: "shared/social-world/VideoTileLayout.tsx",
    marker: "el.muted = true;",
    why: "the shared tile layout — only draws a <video> when the peer HAS video",
  },
  {
    file: "client/src/features/call/CallView.tsx",
    marker: "el.muted = true;",
    why: "the clinician's in-game peer sidebar",
  },
  {
    file: "client/src/features/call/StudentSplitView.tsx",
    marker: "el.muted = true;",
    why: "the clinician's split view — the student's camera beside their screen",
  },
  {
    file: "client-aac/src/components/CallFace.tsx",
    marker: "muted",
    why: "the AAC avatar slot — mounts alongside the large video window",
  },
  {
    file: "client-aac/src/components/GroupChatHeader.tsx",
    marker: "muted",
    why: "the AAC group-chat face row",
  },
  {
    file: "client-aac/src/components/social-world/SocialWorldOverlay.tsx",
    marker: "el.muted = true;",
    why: "the AAC in-game people panel",
  },
];

/** Files that touch srcObject but are NOT call surfaces (local camera, etc.). */
const NOT_CALL_SURFACES = new Set([
  "client/src/components/BiometricCameraDialog.tsx",
  "client/src/components/BiometricEnrollment.tsx",
  "client-aac/src/components/CameraProvider.tsx",
  "client-aac/src/components/MultiCameraDebugWindow.tsx",
  "client-aac/src/components/SignLanguageDetector.tsx",
  // Local self-view inside the world canvas — this device's own camera.
  "shared/social-world/SocialWorldCanvas.tsx",
]);

const AUDIO_OWNER = "shared/call/CallAudioSinks.tsx";

function walk(dir: string): string[] {
  const abs = resolve(ROOT, dir);
  let entries: string[];
  try { entries = readdirSync(abs); } catch { return []; }
  return entries.flatMap((e) => {
    const p = join(abs, e);
    if (statSync(p).isDirectory()) return walk(relative(ROOT, p));
    return /\.(tsx?|jsx?)$/.test(e) ? [relative(ROOT, p).replace(/\\/g, "/")] : [];
  });
}

describe("A2 — one audio owner for the call", () => {
  it("CallAudioSinks is the only surface that plays remote call audio", () => {
    const owner = read(AUDIO_OWNER);
    // It renders an <audio> element and nothing visual. Checked on the rendered
    // JSX, not on raw file text — the file's comments legitimately discuss
    // <video>, and matching prose would be testing the explanation.
    expect(owner).toContain("<audio ref={ref}");
    // Every sink is findable, so a receive-side probe can report whether it is
    // actually PLAYING — a paused sink is otherwise indistinguishable from
    // silence on the wire, which is how it hid for a whole round of debugging.
    expect(owner).toContain("data-call-audio-sink={personId}");
    // And a sink that cannot start must SAY so; the first version swallowed it.
    expect(owner).toContain("could not start");
    expect(owner).not.toMatch(/return\s*\(?\s*<video/);
    // Volume and mute are per-listener controls it owns.
    expect(owner).toContain("el.volume = volume;");
    expect(owner).toContain("el.muted = muted;");
  });

  it("is mounted by BOTH call providers, so it outlives any one view", () => {
    // Mounted in the provider rather than a panel: a participant must stay
    // audible no matter which view is on screen, or whether one is at all.
    for (const provider of [
      "client/src/features/call/CallContext.tsx",
      "client-aac/src/contexts/CallContext.tsx",
    ]) {
      const src = read(provider);
      expect(src).toContain("<CallAudioSinks");
      expect(src).toContain('from "@shared/call/CallAudioSinks"');
    }
  });

  it.each(VISUAL_SURFACES)("$file is visual-only ($why)", ({ file, marker }) => {
    expect(read(file)).toContain(marker);
  });

  it("the tile layout cannot route audio — it has no gain/mute props at all", () => {
    const src = read("shared/social-world/VideoTileLayout.tsx");
    // Removing these from VideoTileData is what stops a caller from believing
    // it can set a per-tile volume; nothing would read it.
    expect(src).not.toContain("gain?: number");
    expect(src).not.toContain("muted?: boolean");
    expect(src).not.toContain("el.volume");
  });

  it("no NEW call surface has appeared with audio left on", () => {
    const known = new Set([
      ...VISUAL_SURFACES.map((s) => s.file),
      ...NOT_CALL_SURFACES,
      AUDIO_OWNER,
    ]);

    const unclassified = CALL_DIRS
      .flatMap(walk)
      .filter((f) => !f.includes(".test."))
      .filter((f) => read(f).includes("srcObject"))
      .filter((f) => !known.has(f));

    // A new file here is not necessarily a bug — but it IS a decision. Classify
    // it as a visual surface (and mute it) or as a non-call surface.
    expect(unclassified).toEqual([]);
  });
});
