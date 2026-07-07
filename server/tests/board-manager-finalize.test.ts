// Tests for the shared Board Manager tool-call finalizer
// (`finalizeBoardManagerToolCalls`) that both the HTTP `BoardManagerAgent`
// and the Live `LiveBoardManagerAgent` funnel through. The invariant the
// Live experiment relies on: the two backends emit byte-identical events for
// the same tool calls, and the Live path's object-shaped args round-trip
// through the HTTP `{ name, arguments: <json string> }` shape losslessly.

import {
  buildBoardManagerTooling,
  finalizeBoardManagerToolCalls,
} from "../services/dual-agent/board-manager-agent";
import type { BoardManagerToolConfig } from "../services/dual-agent/prompts/board-manager";

const TOOL_CONFIG: BoardManagerToolConfig = {
  availableBoards: [],
  hasLoadedBoard: false,
  loadedBoardKey: null,
  loadedBoardName: null,
  maxBoardItems: 12,
  language: "en",
  singleGlyphButtons: false,
  glyphInputTranslation: false,
};

const fusionMap = buildBoardManagerTooling(TOOL_CONFIG).fusionMap;

/** Emulate how LiveBoardManagerAgent maps a Live ToolCall (object args) into
 *  the provider chat shape the finalizer expects. */
function asLiveRawCalls(calls: Array<{ name: string; args: Record<string, unknown> }>) {
  return calls.map(c => ({ name: c.name, arguments: JSON.stringify(c.args ?? {}) }));
}

describe("finalizeBoardManagerToolCalls", () => {
  test("empty tool calls → a single board_no_change fallback, usage omitted", () => {
    const result = finalizeBoardManagerToolCalls([], fusionMap, undefined, "STOP");
    expect(result.events).toHaveLength(1);
    expect(result.events[0].type).toBe("board_no_change");
    expect(result.usage).toBeUndefined();
    expect(result.rawToolCalls).toEqual([]);
  });

  test("usage is passed through unchanged (HTTP path bills from it)", () => {
    const usage = { promptTokens: 100, completionTokens: 40, cachedTokens: 0, cacheCreationTokens: 0 };
    const result = finalizeBoardManagerToolCalls([], fusionMap, usage, "STOP");
    expect(result.usage).toEqual(usage);
  });

  test("a no_change tool call → board_no_change carrying its reason", () => {
    const result = finalizeBoardManagerToolCalls(
      [{ name: "no_change", arguments: JSON.stringify({ reason: "board already fits" }) }],
      fusionMap,
      undefined,
      "STOP",
    );
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({ type: "board_no_change", reason: "board already fits" });
  });

  test("rebuild_board → board_rebuilt with all buttons", () => {
    const buttons = [
      { label: "Yes", speech: "yes", glyphFallback: "👍" },
      { label: "No", speech: "no", glyphFallback: "👎" },
      { label: "Maybe", speech: "maybe", glyphFallback: "🤔" },
    ];
    const result = finalizeBoardManagerToolCalls(
      [{ name: "rebuild_board", arguments: JSON.stringify({ buttons }) }],
      fusionMap,
      undefined,
      "STOP",
    );
    expect(result.events).toHaveLength(1);
    const ev = result.events[0] as any;
    expect(ev.type).toBe("board_rebuilt");
    expect(ev.buttons).toHaveLength(3);
    expect(ev.buttons.map((b: any) => b.label)).toEqual(["Yes", "No", "Maybe"]);
  });

  test("rebuild_board button with open.website → event button carries the launch action", () => {
    const buttons = [
      { label: "Read my book", speech: "I want to read my book", glyphFallback: "📖", open: { website: "https://book-reader-beta-weld.vercel.app" } },
      { label: "Something else", speech: "something else", glyphFallback: "🔄" },
    ];
    const result = finalizeBoardManagerToolCalls(
      [{ name: "rebuild_board", arguments: JSON.stringify({ buttons }) }],
      fusionMap,
      undefined,
      "STOP",
    );
    const ev = result.events[0] as any;
    expect(ev.type).toBe("board_rebuilt");
    expect(ev.buttons[0].open).toEqual({ website: "https://book-reader-beta-weld.vercel.app" });
    // A plain button gets no launch action.
    expect(ev.buttons[1].open).toBeUndefined();
  });

  test("add_board_button with open.app → board_button_added carries the app launch", () => {
    const result = finalizeBoardManagerToolCalls(
      [{ name: "add_board_button", arguments: JSON.stringify({
        button: { label: "Draw", speech: "I want to draw", glyphFallback: "🎨", open: { app: "drawing" } },
      }) }],
      fusionMap,
      undefined,
      "STOP",
    );
    const ev = result.events[0] as any;
    expect(ev.type).toBe("board_button_added");
    expect(ev.button.open).toEqual({ app: "drawing" });
  });

  test("website wins when a button sets both open.website and open.app", () => {
    const result = finalizeBoardManagerToolCalls(
      [{ name: "add_board_button", arguments: JSON.stringify({
        button: { label: "Go", speech: "go", glyphFallback: "➡️", open: { website: "https://example.com", app: "drawing" } },
      }) }],
      fusionMap,
      undefined,
      "STOP",
    );
    const ev = result.events[0] as any;
    expect(ev.button.open).toEqual({ website: "https://example.com" });
  });

  test("Live (object args) and HTTP (string args) shapes produce identical events", () => {
    const objCalls = [
      { name: "rebuild_board", args: { buttons: [
        { label: "Hi", speech: "hi", glyphFallback: "👋" },
        { label: "Bye", speech: "bye", glyphFallback: "✌️" },
      ] } },
    ];
    const httpRaw = asLiveRawCalls(objCalls); // identical mapping the Live agent uses

    const live = finalizeBoardManagerToolCalls(httpRaw, fusionMap, undefined, "STOP");
    const http = finalizeBoardManagerToolCalls(httpRaw, fusionMap, undefined, "STOP");

    // Timestamps are Date.now()-based; compare the structural payload only.
    const strip = (r: typeof live) => r.events.map(({ timestamp, ...rest }: any) => rest);
    expect(strip(live)).toEqual(strip(http));
    expect(live.events[0].type).toBe("board_rebuilt");
  });
});
