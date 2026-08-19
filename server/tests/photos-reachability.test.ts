/**
 * Can the AAC actually REACH the family photo album?
 *
 * The album shipped complete and unreachable, in three separate ways:
 *
 *   1. `photos` is `enabledByDefault: false` and had NO toggle anywhere in AAC
 *      Settings, so nothing short of hand-editing `app_config` could turn it on.
 *      The app, its server-side resolution and its prompt block all worked and
 *      none of it was ever switched on for anybody.
 *   2. The `<photos>` block — the one carrying the captions — is built only in
 *      the Speaker's TOOL branch. The default session is live native audio with
 *      tools suppressed, where the Speaker saw the bare word "Photos" and had no
 *      idea whose faces were inside, so it could never offer "want to see
 *      Grandma?".
 *   3. The Board Manager — the only agent that can open anything in that mode —
 *      was never given the captions at all, so its launch button could only
 *      open the grid, never the photo the student just asked about.
 *
 * The settings toggle is a UI fact and is asserted in the panel, not here. What
 * these tests hold is the prompt half of 2 and 3, in both Speaker shapes.
 *
 * PATTERN NOTE (2026-08-19, Daniel): photos is categorized as an APP. Its
 * captions render as one more data line on the "photos" entry INSIDE
 * <apps_context> — never as a separate block with its own rules. A lone
 * special-cased block taught the Board Manager that photos worked differently,
 * which is exactly the confusion these tests now guard against.
 */

import { describe, test, expect } from "@jest/globals";
import { buildSpeakerPrompt } from "../services/dual-agent/prompts/speaker.js";
import { buildBoardManagerPrompt } from "../services/dual-agent/prompts/board-manager.js";
import { getAppDefinition } from "../services/dual-agent/app-registry.js";

const PHOTOS_APP = {
  id: "photos",
  name: "Photos",
  description: getAppDefinition("photos")!.description,
  queryHint: getAppDefinition("photos")!.queryHint,
};

const LIBRARY = {
  count: 4,
  captions: ["Grandma at my birthday", "Rex the dog"],
  truncated: false,
  uncaptionedCount: 1,
};

const base = {
  studentName: "Alex",
  persona: "",
  muteState: "unmuted" as const,
  useDirectAudio: false,
};

// ── Speaker, live native audio (the DEFAULT — tools suppressed) ─────────────

describe("Speaker <activities> — the album in the shape that was blind", () => {
  const liveAudio = { ...base, liveAudio: true, enabledApps: [PHOTOS_APP] };

  test("carries the captions, not just the word 'Photos'", () => {
    const prompt = buildSpeakerPrompt({ ...liveAudio, photoLibrary: LIBRARY });

    expect(prompt).toContain("<activities>");
    expect(prompt).toContain("4 family photos");
    // Verbatim — these are what the query is matched against.
    expect(prompt).toContain("Grandma at my birthday");
    expect(prompt).toContain("Rex the dog");
    // 2026-08-19 (Daniel): the live Speaker opens the album itself.
    expect(prompt).toContain('open_app("photos"');
  });

  test("keeps the uncaptioned safety rule in this shape too", () => {
    const prompt = buildSpeakerPrompt({ ...liveAudio, photoLibrary: LIBRARY });
    expect(prompt).toContain("NEVER guess who is in an uncaptioned one");
  });

  test("drops the uncaptioned warning when every photo has a caption", () => {
    const prompt = buildSpeakerPrompt({
      ...liveAudio,
      photoLibrary: { ...LIBRARY, uncaptionedCount: 0 },
    });
    expect(prompt).toContain("4 family photos");
    expect(prompt).not.toContain("NEVER guess who is in an uncaptioned one");
  });

  test("says nothing about photos for a student with none", () => {
    const prompt = buildSpeakerPrompt({ ...liveAudio, photoLibrary: undefined });
    expect(prompt).not.toContain("family photo");
  });

  test("never claims the Speaker can see the pictures", () => {
    const prompt = buildSpeakerPrompt({ ...liveAudio, photoLibrary: LIBRARY });
    expect(prompt).toContain("never describe one you were not told is on screen");
  });
});

// ── Board Manager — the only agent that can open it in live audio ───────────

function bmPrompt(opts: { photoLibrary?: any; apps?: any[] }): string {
  const { base: prompt } = buildBoardManagerPrompt({
    studentName: "Alex",
    availableBoards: [],
    enabledApps: opts.apps ?? [PHOTOS_APP],
    photoLibrary: opts.photoLibrary,
  } as any);
  return prompt;
}

describe("Board Manager — photos as a per-app data line in <apps_context>", () => {
  test("captions live INSIDE <apps_context>, never in a block of their own", () => {
    const prompt = bmPrompt({ photoLibrary: LIBRARY });

    expect(prompt).not.toContain("<photos_context>");
    const captionAt = prompt.indexOf("Grandma at my birthday");
    expect(captionAt).toBeGreaterThan(prompt.indexOf("<apps_context>"));
    expect(captionAt).toBeLessThan(prompt.indexOf("</apps_context>"));
    // The data line names the app entry and the query rule.
    expect(prompt).toContain('"photos" holds 4');
    expect(prompt).toContain("caption words, verbatim");
  });

  test("wraps captions as untrusted — a caretaker typed them", () => {
    const prompt = bmPrompt({ photoLibrary: LIBRARY });
    const captionIndex = prompt.indexOf("Grandma at my birthday");
    // The wrapper must sit around the caption, not merely exist in the prompt.
    expect(prompt.slice(Math.max(0, captionIndex - 40), captionIndex)).toMatch(/untrusted|<data|"""/i);
  });

  test("tells it NOT to invent a query when nothing is captioned", () => {
    const prompt = bmPrompt({
      photoLibrary: { count: 3, captions: [], truncated: false, uncaptionedCount: 3 },
    });
    expect(prompt).toContain("none captioned");
    expect(prompt).toContain("NO \`data\`/\`appQuery\`");
  });

  test("no data line for a student with no photos", () => {
    expect(bmPrompt({ photoLibrary: undefined })).not.toContain('"photos" holds');
    expect(bmPrompt({ photoLibrary: { count: 0, captions: [], truncated: false, uncaptionedCount: 0 } }))
      .not.toContain('"photos" holds');
  });

  test("absent when the photos app is switched OFF, even with a library", () => {
    // A disabled app must be invisible to the AI, not merely ungated on press —
    // otherwise it authors a button that the coordinator then drops.
    const prompt = bmPrompt({
      photoLibrary: LIBRARY,
      apps: [{ id: "drawing", name: "Drawing", description: "A canvas." }],
    });
    expect(prompt).not.toContain('"photos" holds');
    expect(prompt).not.toContain("Grandma at my birthday");
  });
});

// ── The registry contract the launch button depends on ─────────────────────

describe("photos registry entry", () => {
  test("declares a queryHint, so the BM schema exposes appQuery for it", () => {
    expect(PHOTOS_APP.queryHint).toBeDefined();
    // Optional, unlike picture_search: browsing is a legitimate outcome here.
    expect(PHOTOS_APP.queryHint).toContain("optional");
  });

  test("is still OFF by default — an empty album should not surface", () => {
    expect(getAppDefinition("photos")!.enabledByDefault).toBe(false);
  });
});
