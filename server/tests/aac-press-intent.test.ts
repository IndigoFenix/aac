import { describe, it, expect } from "@jest/globals";
import type { BoardButton } from "@shared/schema";
import { isMetaButton, pressIntentFor, shouldSpeakLocally } from "@shared/aac/press-intent";

const btn = (extra: Partial<BoardButton> = {}): BoardButton =>
  ({ id: "b", label: "hello", spokenText: "hello there", ...extra }) as BoardButton;

describe("pressIntentFor", () => {
  it("treats a plain button as an utterance, preferring spokenText", () => {
    expect(pressIntentFor(btn())).toEqual({ kind: "speak", text: "hello there", meta: false });
  });

  it("falls back to the label when there is no spokenText", () => {
    const intent = pressIntentFor(btn({ spokenText: undefined }));
    expect(intent).toEqual({ kind: "speak", text: "hello", meta: false });
  });

  it("routes a board link ONLY when a loader is wired", () => {
    const b = btn({ action: { type: "link", toBoardId: "brd", toPageId: "pg" } as any });
    // Constructed path: a loader exists, so the board wins over the page.
    expect(pressIntentFor(b, { canNavigateToBoard: true })).toEqual({ kind: "navigate-board", boardId: "brd" });
    // AI dynamic path: no loader, so it must fall through rather than go dead.
    expect(pressIntentFor(b)).toEqual({ kind: "navigate-page", pageId: "pg" });
  });

  it("falls all the way through to speech when a board link has no page either", () => {
    const b = btn({ action: { type: "link", toBoardId: "brd" } as any });
    expect(pressIntentFor(b).kind).toBe("speak");
  });

  it("classifies the navigation actions", () => {
    expect(pressIntentFor(btn({ action: { type: "back" } as any }))).toEqual({ kind: "page-back" });
    expect(pressIntentFor(btn({ action: { type: "home" } as any }))).toEqual({ kind: "page-home" });
  });

  it("treats the exitBoard FLAG as an exit, like the action", () => {
    expect(pressIntentFor(btn({ action: { type: "exit" } as any }))).toEqual({ kind: "exit", instruction: "" });
    expect(pressIntentFor(btn({ exitBoard: true } as any))).toEqual({ kind: "exit", instruction: "" });
  });

  it("carries the exit button's DIRECTIVE, which is the only thing saying what the press meant", () => {
    // Home-board buttons put a tag in action.text ([FEELINGS], [HELP], …).
    // Dropping it leaves the agents a bare "they left the board" to guess from.
    expect(
      pressIntentFor(btn({ exitBoard: true, action: { type: "exit", text: "[FEELINGS]" } } as any)),
    ).toEqual({ kind: "exit", instruction: "[FEELINGS]" });
  });

  it("classifies the launchers, and needs their payload to do it", () => {
    expect(pressIntentFor(btn({ action: { type: "open_website", url: "https://x" } as any })))
      .toEqual({ kind: "open-website", url: "https://x", label: "hello" });
    expect(pressIntentFor(btn({ action: { type: "open_app", appId: "youtube" } as any })))
      .toEqual({ kind: "open-app", appId: "youtube" });
    expect(pressIntentFor(btn({ action: { type: "open_board", boardKey: "food" } as any })))
      .toEqual({ kind: "open-board", boardKey: "food" });
    // A launcher missing its payload is not a launcher — it must not go dead.
    expect(pressIntentFor(btn({ action: { type: "open_app" } as any })).kind).toBe("speak");
  });

  it("carries an open_app query through to the launch intent", () => {
    // The Board Manager is the ONLY thing that can open an app in a live-audio
    // session, so dropping `appData` here turns "yes, show me an owl" into a
    // picture search on nothing — with no error anywhere to explain it.
    expect(
      pressIntentFor(btn({ action: { type: "open_app", appId: "picture_search", appData: "an owl" } as any })),
    ).toEqual({ kind: "open-app", appId: "picture_search", appData: "an owl" });
  });

  it("carries the confirmation flag on a home action", () => {
    expect(pressIntentFor(btn({ action: { type: "run_home_action", actionId: "a1" } as any })))
      .toEqual({ kind: "home-action", actionId: "a1", requiresConfirmation: false });
    expect(pressIntentFor(btn({ action: { type: "run_home_action", actionId: "a1", requiresConfirmation: true } as any })))
      .toEqual({ kind: "home-action", actionId: "a1", requiresConfirmation: true });
  });

  it("marks board-meta presses so they are never voiced locally", () => {
    for (const buttonType of ["suggestion", "wordfinder", "more", "narrow"]) {
      const intent = pressIntentFor(btn({ buttonType } as any));
      expect(intent).toMatchObject({ kind: "speak", meta: true });
    }
    expect(pressIntentFor(btn({ buttonType: "sentence" } as any))).toMatchObject({ meta: false });
  });
});

describe("isMetaButton", () => {
  it("is false for a button with no type at all", () => {
    expect(isMetaButton(btn())).toBe(false);
  });
});

describe("shouldSpeakLocally", () => {
  const speech = { kind: "speak", text: "hi", meta: false } as const;

  it("voices an ordinary utterance", () => {
    expect(shouldSpeakLocally(speech, {})).toBe(true);
  });

  it("stays silent for anything that is not speech", () => {
    expect(shouldSpeakLocally({ kind: "page-back" }, {})).toBe(false);
  });

  it("stays silent for meta presses — they would be spurious utterances", () => {
    expect(shouldSpeakLocally({ ...speech, meta: true }, {})).toBe(false);
  });

  it("stays silent when the server is already voicing the press", () => {
    expect(shouldSpeakLocally(speech, { suppressLocalSpeech: true })).toBe(false);
  });

  it("stays silent under the header audio mute — this path was the leak", () => {
    expect(shouldSpeakLocally(speech, { outputMuted: true })).toBe(false);
  });
});
