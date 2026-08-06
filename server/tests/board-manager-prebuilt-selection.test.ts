// The Board Manager's instructions for OPENING a pre-built board.
//
// Motivated by session 043b0b6f (2026-08-04): the family spent 20 minutes
// talking about buying ice cream with an "Ice Cream Vendor" board sitting in
// <prebuilt_boards>, and set_board was never called once across 60 invocations.
// The Observer even flagged it by name via update_context — exactly what its own
// prompt tells it to do — and the Board Manager answered no_change: "the context
// update is an observation, not a new conversational turn."
//
// Nothing was broken. The prompt listed the board and never said what would make
// it the right surface, while <when_to_act> told it to default to no_change on
// observations. Two gaps this covers:
//   1. The author's auto-select hint is free text written by a parent or
//      clinician. The placeholder teaches a condition ("During mealtimes") but
//      people write a topic ("לקנות גלידה" — "to buy ice cream"). The prompt must
//      say what that trailing text IS and to read a topic as a trigger.
//   2. The Observer's board flag must be an exception to the ambient-observation
//      default, or the handshake it is told to perform has no receiving end.
import { buildBoardManagerPrompt } from "../services/dual-agent/prompts/board-manager";
import type { BoardManagerPromptConfig } from "../services/dual-agent/prompts/board-manager";

const grid = { rows: 4, cols: 4 };

const base: BoardManagerPromptConfig = {
  studentName: "שחף",
  muteState: "unmuted",
};

// The real board list from the session, hint included verbatim.
const withBoards = (): BoardManagerPromptConfig => ({
  ...base,
  availableBoards: [
    { id: "1", key: "home", name: "Home", grid },
    { id: "2", key: "ice_cream_vendor", name: "Ice Cream Vendor", hint: "לקנות גלידה", grid },
    { id: "3", key: "board_5", name: "לוח למידת אותיות בעברית", hint: "אותיות", grid },
  ],
});

const promptOf = (config: BoardManagerPromptConfig) => buildBoardManagerPrompt(config).base;

describe("board manager prompt — reading a hand-authored auto-select hint", () => {
  it("says what the text after the board name is", () => {
    const prompt = promptOf(withBoards());
    expect(prompt).toContain("the author's note on WHEN to open");
  });

  // The whole failure mode: authors write topics, not conditions. If the model
  // is left to infer that "לקנות גלידה" is a trigger, it reads as a subtitle.
  it("tells the model to read a bare topic as a trigger", () => {
    const prompt = promptOf(withBoards());
    expect(prompt).toMatch(/bare TOPIC or activity/);
    expect(prompt).toMatch(/rather than a condition/);
  });

  it("reads a note that merely describes the contents as a trigger too", () => {
    const prompt = promptOf(withBoards());
    expect(prompt).toMatch(/description of the board's contents/);
  });

  // Asking by name is the least ambiguous possible request, not the expected
  // one. Selection has to be driven by what the conversation is ABOUT.
  it("directs matching on subject rather than on wording", () => {
    const prompt = promptOf(withBoards());
    expect(prompt).toMatch(/Judge fit by the SUBJECT of the conversation, not by phrasing/);
  });

  it("still renders the board list with keys and hints", () => {
    const prompt = promptOf(withBoards());
    expect(prompt).toContain(`key: "ice_cream_vendor"  name: "Ice Cream Vendor"  — לקנות גלידה`);
  });
});

describe("board manager prompt — when to reach for set_board", () => {
  it("prefers a fitting pre-built board over authoring one", () => {
    const prompt = promptOf(withBoards());
    expect(prompt).toMatch(/pre-built .+ that fits beats one you write/);
  });

  // Guards against the opposite failure: thrashing the surface on every mention.
  it("bounds the eagerness so the board is not re-opened or swapped mid-activity", () => {
    const prompt = promptOf(withBoards());
    expect(prompt).toMatch(/not on a single passing mention/);
    expect(prompt).toMatch(/never when it is already loaded/);
    expect(prompt).toMatch(/Stay on it while the activity continues/);
  });

  // The Observer's <available_boards> block promises it will flag a matching
  // situation via update_context "so the right surface can come up". Before
  // this, nothing on the receiving side acted on that.
  it("makes the Observer's context flag actionable instead of ambient", () => {
    const prompt = promptOf(withBoards());
    expect(prompt).toMatch(/\[CONTEXT\]` update naming a pre-built/);
    expect(prompt).toMatch(/EXCEPTION: an observation that a pre-built .+ situation has arrived/);
  });

  // The no_change default has to survive intact for everything else.
  it("keeps the ambient-observation default for ordinary scene context", () => {
    const prompt = promptOf(withBoards());
    expect(prompt).toContain("**DO NOT rebuild on ambient observations.**");
    expect(prompt).toMatch(/Defaulting to no_change on observations is correct/);
  });

  // A session with no pre-built boards must not be told about a tool surface
  // and an exception that do not apply to it.
  it("emits none of this when the user has no pre-built boards", () => {
    const prompt = promptOf(base);
    expect(prompt).not.toContain("<prebuilt_boards>");
    expect(prompt).not.toMatch(/beats one you write/);
    expect(prompt).not.toMatch(/EXCEPTION: an observation/);
    // …while the baseline rule it carves out of stays put.
    expect(prompt).toContain("**DO NOT rebuild on ambient observations.**");
  });
});

// The other half of the ice-cream failure: set_board is all-or-nothing. When
// the model isn't sure the moment has arrived it has to choose between taking
// the user's words away and doing nothing. A board-launch button is the middle
// option — the AI offers, the user decides.
describe("board manager prompt — offering a board as a button", () => {
  it("teaches the OFFER alternative and what pressing it does", () => {
    const prompt = promptOf(withBoards());
    expect(prompt).toContain("<board_buttons>");
    expect(prompt).toMatch(/open: \{ board: "<key>" \}/);
    expect(prompt).toMatch(/Pressing it loads that/);
  });

  it("routes the UNSURE case to an offer instead of a load", () => {
    const prompt = promptOf(withBoards());
    expect(prompt).toMatch(/If you are UNSURE, OFFER the board instead of loading it/);
    expect(prompt).toMatch(/Topic mentioned once, in passing → OFFER/);
    expect(prompt).toMatch(/Topic is now what the conversation is about → `set_board`/);
  });

  it("keeps board buttons from crowding out the user's own words", () => {
    const prompt = promptOf(withBoards());
    expect(prompt).toMatch(/ONE or TWO board/);
    expect(prompt).toMatch(/Never offer the .+ that is already loaded/);
  });

  it("offers the board's own icon as the visual when no glyph is given", () => {
    const prompt = promptOf(withBoards());
    expect(prompt).toMatch(/omit the glyph to use the .+'s own icon/);
  });

  it("is absent entirely for a user with no pre-built boards", () => {
    expect(promptOf(base)).not.toContain("<board_buttons>");
  });
});
