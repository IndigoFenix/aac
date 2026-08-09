// Launch buttons — the pure half of "pressing this button OPENS something".
//
// The board case is the newest: the Board Manager can OFFER a pre-built board
// as a button (`open.board`) instead of committing to set_board. Two rules have
// to hold for that to be usable by a child:
//   1. The press must route to the board-open round-trip, never to speech —
//      a board button that "says" its label is a dead end.
//   2. The button must show a picture. When the AI gives no glyph we fall back
//      to the board's own cover art, but ONLY when the device can actually draw
//      it: the builder's default placeholder and legacy Widgit paths render as
//      a broken image, which is worse than the AI's invented glyph.
//
// The FOURTH kind is a smart-home action (`open.home`). It ACTUATES rather than
// navigates, and it is the one kind whose spoken text is NOT the AI's: the
// client utters the slot's `command` verbatim, because a wake-word phrase only
// works said exactly. Its gate is the enabled-slot lookup, and an id that no
// longer resolves must degrade to a plain speak button, never a dead press.
//
// DB-free (test:unit): the module has no session state.

import type { HomeAction } from "@shared/schema";
import {
  buttonActionFromOpen,
  renderableBoardCover,
  renderableEmojiIcon,
} from "../services/dual-agent/board-launch";
import {
  buildBoardManagerPrompt,
  buildBoardManagerToolDeclarations,
  renderEventLine,
  type BoardManagerPromptConfig,
  type BoardManagerToolConfig,
} from "../services/dual-agent/prompts/board-manager";

describe("buttonActionFromOpen", () => {
  it("a button with no launch target speaks its sentence", () => {
    expect(buttonActionFromOpen(undefined, "I want water"))
      .toEqual({ type: "speak", text: "I want water" });
    expect(buttonActionFromOpen({}, "I want water"))
      .toEqual({ type: "speak", text: "I want water" });
  });

  it("open.board becomes an open_board action carrying the KEY", () => {
    expect(buttonActionFromOpen({ board: "ice_cream_vendor" }, "ignored"))
      .toEqual({ type: "open_board", boardKey: "ice_cream_vendor" });
  });

  it("still maps the app and website targets", () => {
    expect(buttonActionFromOpen({ app: "drawing" }, "x"))
      .toEqual({ type: "open_app", appId: "drawing" });
    expect(buttonActionFromOpen({ website: "https://example.com" }, "x"))
      .toEqual({ type: "open_website", url: "https://example.com" });
  });

  it("keeps the website → app → board precedence of the parse layer", () => {
    expect(buttonActionFromOpen({ website: "https://example.com", app: "drawing", board: "snack" }, "x"))
      .toEqual({ type: "open_website", url: "https://example.com" });
    expect(buttonActionFromOpen({ app: "drawing", board: "snack" }, "x"))
      .toEqual({ type: "open_app", appId: "drawing" });
  });
});

// ---------------------------------------------------------------------------
// Smart-home actions — the fourth launchable kind.
// ---------------------------------------------------------------------------

const LIGHTS: HomeAction = {
  id: "lights_on",
  label: "Lights on",
  icon: "💡",
  type: "spoken",
  command: "Alexa, turn on the lights",
  enabled: true,
};
const FAN_OFF: HomeAction = {
  id: "fan_off",
  label: "Fan off",
  type: "spoken",
  command: "Alexa, turn off the fan",
  enabled: false,
};
/** A cloud slot: the SERVER actuates, so there is no command — only what the
 *  device says while it happens. */
const CLOUD_LIGHTS: HomeAction = {
  id: "cloud_lights",
  label: "Lights on",
  type: "alexa",
  announce: "turning on the lights",
  enabled: true,
};
const CLOUD_DOOR: HomeAction = {
  id: "cloud_door",
  label: "Open the door",
  type: "google",
  requiresConfirmation: true,
  enabled: true,
};

describe("buttonActionFromOpen — home actions", () => {
  it("open.home becomes a run_home_action carrying the COMMAND and label", () => {
    expect(buttonActionFromOpen({ home: "lights_on" }, "I want the lights on", [LIGHTS]))
      .toEqual({
        type: "run_home_action",
        actionId: "lights_on",
        command: "Alexa, turn on the lights",
        label: "Lights on",
      });
  });

  it("ignores the AI's speakText — the wake-word phrase must be said exactly", () => {
    const action = buttonActionFromOpen({ home: "lights_on" }, "please make it bright", [LIGHTS]);
    expect(action.text).toBeUndefined();
    expect(action.command).toBe("Alexa, turn on the lights");
  });

  it("an unknown id degrades to a plain speak button", () => {
    expect(buttonActionFromOpen({ home: "nope" }, "I want the lights on", [LIGHTS]))
      .toEqual({ type: "speak", text: "I want the lights on" });
    // …and so does an id with no slot list at all (a session with none configured).
    expect(buttonActionFromOpen({ home: "lights_on" }, "I want the lights on"))
      .toEqual({ type: "speak", text: "I want the lights on" });
  });

  it("a DISABLED slot is unfirable — findHomeAction only sees enabled ones", () => {
    expect(buttonActionFromOpen({ home: "fan_off" }, "turn the fan off", [LIGHTS, FAN_OFF]))
      .toEqual({ type: "speak", text: "turn the fan off" });
  });

  it("a CLOUD slot carries `announce` instead of a command — the server actuates", () => {
    expect(buttonActionFromOpen({ home: "cloud_lights" }, "make it bright", [CLOUD_LIGHTS]))
      .toEqual({
        type: "run_home_action",
        actionId: "cloud_lights",
        label: "Lights on",
        announce: "turning on the lights",
      });
  });

  it("an announce-less cloud slot falls back to the LABEL, resolved server-side", () => {
    const action = buttonActionFromOpen({ home: "cloud_door" }, "x", [CLOUD_DOOR]);
    expect(action.announce).toBe("Open the door");
    expect(action.command).toBeUndefined();
  });

  it("requiresConfirmation rides along so the client can show its confirm step", () => {
    expect(buttonActionFromOpen({ home: "cloud_door" }, "x", [CLOUD_DOOR]).requiresConfirmation)
      .toBe(true);
    // …and stays absent when the slot doesn't ask for one.
    expect(buttonActionFromOpen({ home: "lights_on" }, "x", [LIGHTS]).requiresConfirmation)
      .toBeUndefined();
    expect(buttonActionFromOpen({ home: "cloud_lights" }, "x", [CLOUD_LIGHTS]).requiresConfirmation)
      .toBeUndefined();
  });

  it("a spoken slot with no phrase is a dead press — it degrades to speech", () => {
    const phraseless: HomeAction = { id: "broken", label: "Broken", type: "spoken", enabled: true };
    expect(buttonActionFromOpen({ home: "broken" }, "I want the lights on", [phraseless]))
      .toEqual({ type: "speak", text: "I want the lights on" });
  });

  it("home is LAST in precedence — the navigating kinds keep priority", () => {
    expect(buttonActionFromOpen({ board: "snack", home: "lights_on" }, "x", [LIGHTS]))
      .toEqual({ type: "open_board", boardKey: "snack" });
    expect(buttonActionFromOpen({ app: "drawing", home: "lights_on" }, "x", [LIGHTS]))
      .toEqual({ type: "open_app", appId: "drawing" });
  });
});

describe("renderableEmojiIcon", () => {
  it("takes the slot's emoji", () => {
    expect(renderableEmojiIcon("💡")).toEqual({ iconRef: "💡" });
  });

  it("rejects a FontAwesome class — that's the blank-speech-bubble sentinel", () => {
    expect(renderableEmojiIcon("fas fa-lightbulb")).toBeUndefined();
  });

  it("no icon → nothing to fall back to (the AI's glyph must carry the button)", () => {
    expect(renderableEmojiIcon(undefined)).toBeUndefined();
    expect(renderableEmojiIcon("   ")).toBeUndefined();
  });
});

describe("renderEventLine — a fired home action", () => {
  it("shows the agents a [HOME] line so they can follow up", () => {
    expect(renderEventLine({
      type: "home_action_requested",
      source: "client",
      timestamp: 0,
      actionId: "lights_on",
      label: "Lights on",
    })).toBe(`[HOME] The user triggered "Lights on"`);
  });
});

describe("<home_context> — only when the student HAS home actions", () => {
  const promptFor = (homeActions?: BoardManagerPromptConfig["homeActions"]): string =>
    buildBoardManagerPrompt({ studentName: "Ada", muteState: "unmuted", homeActions }).base;

  it("a student with no slots never sees the block", () => {
    expect(promptFor()).not.toContain("<home_context>");
    expect(promptFor([])).not.toContain("<home_context>");
  });

  it("lists each slot as an id/label pair, with the author's hint appended", () => {
    const prompt = promptFor([
      { id: "lights_on", label: "Lights on", description: "when they say it's dark" },
      { id: "fan_off", label: "Fan off" },
    ]);
    expect(prompt).toContain(`- "lights_on" (Lights on) — when they say it's dark`);
    expect(prompt).toContain(`- "fan_off" (Fan off)`);
    expect(prompt).toContain("</home_context>");
  });

  it("skips the note explainer when no slot carries a description", () => {
    expect(promptFor([{ id: "fan_off", label: "Fan off" }]))
      .not.toContain("author's note");
  });
});

// The button schema is inlined on EVERY button of EVERY rebuild, and Gemini
// Flash answers a branchy schema with MALFORMED_FUNCTION_CALL. So each `open`
// sub-field must be absent entirely — not merely empty — when its list is.
describe("open.home schema — omit-when-empty discipline", () => {
  const openSchema = (config: BoardManagerToolConfig): Record<string, unknown> | undefined => {
    const decls = buildBoardManagerToolDeclarations(config)
      .flatMap(t => (t as { functionDeclarations?: any[] }).functionDeclarations ?? []);
    const rebuild = decls.find(d => d.name === "rebuild_board");
    const button = rebuild?.parametersJsonSchema?.properties?.buttons?.items;
    return button?.properties?.open;
  };
  const base: BoardManagerToolConfig = { availableBoards: [], hasLoadedBoard: false };

  it("no launch targets at all → no `open` field", () => {
    expect(openSchema(base)).toBeUndefined();
  });

  it("home actions alone are enough to open the field", () => {
    const open = openSchema({ ...base, homeActions: [{ id: "lights_on", label: "Lights on" }] });
    expect(Object.keys((open as any).properties)).toEqual(["home"]);
    // Allowed ids are enumerated inline — the model has no other list to read.
    expect((open as any).description).toContain(`"lights_on" (Lights on)`);
  });

  it("without home actions the `home` sub-field does not exist", () => {
    const open = openSchema({ ...base, availableBoards: [{ key: "snack", name: "Snack" }] });
    expect((open as any).properties).not.toHaveProperty("home");
  });
});

describe("renderableBoardCover", () => {
  it("takes an emoji cover", () => {
    expect(renderableBoardCover({ iconRef: "🍦" })).toEqual({ iconRef: "🍦" });
  });

  it("takes a resolved image URL", () => {
    expect(renderableBoardCover({ symbolPath: "/api/symbols/abc123.svg" }))
      .toEqual({ symbolPath: "/api/symbols/abc123.svg" });
    expect(renderableBoardCover({ symbolPath: "https://cdn.example.com/x.png" }))
      .toEqual({ symbolPath: "https://cdn.example.com/x.png" });
  });

  it("rejects the builder's default placeholder — it is not an image path", () => {
    expect(renderableBoardCover({ symbolPath: "syntaacx_logo" })).toBeUndefined();
  });

  it("rejects legacy Widgit / SymbolStix paths (they would render broken)", () => {
    expect(renderableBoardCover({ symbolPath: "[widgit]widgit rebus\\c\\communicate.emf" })).toBeUndefined();
    expect(renderableBoardCover({ symbolPath: "[sstix#]50026.emf" })).toBeUndefined();
  });

  it("rejects a FontAwesome iconRef — that's the blank-speech-bubble sentinel", () => {
    expect(renderableBoardCover({ iconRef: "fas fa-comment" })).toBeUndefined();
  });

  it("prefers the emoji when a board carries both", () => {
    expect(renderableBoardCover({ iconRef: "🍎", symbolPath: "/api/symbols/x.svg" }))
      .toEqual({ iconRef: "🍎" });
  });

  it("no cover at all → nothing to fall back to", () => {
    expect(renderableBoardCover(undefined)).toBeUndefined();
    expect(renderableBoardCover({})).toBeUndefined();
  });
});
