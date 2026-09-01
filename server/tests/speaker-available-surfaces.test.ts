// The Speaker's <available_surfaces> block — pre-built boards it can put on
// screen without owning the tool that loads them.
//
// PROD 2026-08-31, session 426dba70 (עופר). The child asked out loud for the
// book "תירס חם". The board existed, was auto-selectable, and its author hint
// was the exact words he used. The Speaker named it correctly — "let's open
// the interactive Hot Corn story" — and then, one turn later, said:
//
//   "I'm sorry, Opher, it seems I can't open the APP for תירס חם right now.
//    It isn't available to me."
//
// Two separate defects produced that sentence, and this file pins the second.
// (The first was the board KEY: every Hebrew board keyed as `board_N`, so the
// Board Manager had no usable handle — see server/tests/board-keys.test.ts.)
//
// The Speaker's own defect: <available_surfaces> listed board NAMES under the
// sentence "You do not load them yourself" — a limit with no consequence
// attached and no verb. So a board request fell through to <apps>, whose
// "NOTHING FITS? Say you can't" rule fired on it. The block now states the
// MECHANISM (saying it is what opens it) and forbids the two things the
// Speaker actually said: calling a board an app, and calling it unavailable.

import { buildSpeakerPrompt } from "../services/dual-agent/prompts/speaker.js";
import { T } from "../services/memory-schema/canonical-terms.js";

const boards = [
  { key: "הנסיך_הקטן", name: "הנסיך הקטן", hint: "little prince" },
  { key: "ספרי_ילדים.תירס_חם_סיפור_אינטראקטיבי", name: "תירס חם - סיפור אינטראקטיבי", hint: "תירס חם" },
];
const apps = [{ id: "book_reader", name: "Book Reader", description: "reads a book aloud" }];

const base = {
  studentName: "עופר", persona: "", muteState: "unmuted" as const,
  liveAudio: true, useDirectAudio: true,
};

const surfaces = (prompt: string) =>
  prompt.slice(prompt.indexOf("<available_surfaces>"), prompt.indexOf("</available_surfaces>"));

describe("Speaker <available_surfaces>", () => {
  test("lists the boards by name, with the author hint", () => {
    const block = surfaces(buildSpeakerPrompt({ ...base, availableBoards: boards }));
    expect(block).toContain('"תירס חם - סיפור אינטראקטיבי"');
    expect(block).toContain("תירס חם");
    expect(block).toContain('"הנסיך הקטן"');
  });

  test("says these are NOT apps", () => {
    const block = surfaces(buildSpeakerPrompt({ ...base, availableBoards: boards }));
    expect(block).toContain("NOT apps");
    expect(block).toContain("Never call one an app");
  });

  test("forbids telling the user a listed board is unavailable", () => {
    // The exact sentence the child heard. A board on this list is by
    // definition reachable, so "unavailable" is always a false statement.
    const block = surfaces(buildSpeakerPrompt({ ...base, availableBoards: boards }));
    expect(block).toContain("never tell the user one is unavailable");
  });

  test("gives the MECHANISM, not just the limit — saying it is what opens it", () => {
    const block = surfaces(buildSpeakerPrompt({ ...base, availableBoards: boards }));
    expect(block).toMatch(/SAY you are opening one[\s\S]*and it opens/);
  });

  test("names the surface with the canonical term, as the Board Manager does", () => {
    const block = surfaces(buildSpeakerPrompt({ ...base, availableBoards: boards }));
    expect(block).toContain(T.board);
  });

  test("is absent when the student has no pre-built boards", () => {
    const prompt = buildSpeakerPrompt({ ...base, availableBoards: [] });
    expect(prompt).not.toContain("<available_surfaces>");
  });
});

describe("Speaker <apps> — the board carve-out", () => {
  const appsBlock = (p: string) => p.slice(p.indexOf("<apps>"), p.indexOf("</apps>"));

  test("tells the app catalogue that a board request is not an app request", () => {
    // Without this, "NOTHING FITS? Say you can't" is the only rule that
    // matches a board request, and it produces a refusal.
    const block = appsBlock(buildSpeakerPrompt({ ...base, enabledApps: apps, availableBoards: boards }));
    expect(block).toContain("NOT EVERY ASK IS AN APP");
    expect(block).toContain(`A ${T.board} in <available_surfaces>`);
  });

  test("puts the carve-out BEFORE the refusal rule it is an exception to", () => {
    const block = appsBlock(buildSpeakerPrompt({ ...base, enabledApps: apps, availableBoards: boards }));
    expect(block.indexOf("NOT EVERY ASK IS AN APP")).toBeLessThan(block.indexOf("NOTHING FITS?"));
  });

  test("does NOT point at <available_surfaces> when that block was never rendered", () => {
    // A dangling cross-reference to a block the model cannot see is worse than
    // no cross-reference: it invites the model to invent what was in it.
    const prompt = buildSpeakerPrompt({ ...base, enabledApps: apps, availableBoards: [] });
    expect(prompt).toContain("<apps>");
    expect(prompt).not.toContain("NOT EVERY ASK IS AN APP");
    expect(prompt).not.toContain("<available_surfaces>");
  });

  test("keeps the original refusal rule for things that really are missing", () => {
    const block = appsBlock(buildSpeakerPrompt({ ...base, enabledApps: apps, availableBoards: boards }));
    expect(block).toContain("NOTHING FITS?");
    expect(block).toContain("Never open the nearest-sounding app instead");
  });
});
