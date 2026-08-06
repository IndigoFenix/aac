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
// DB-free (test:unit): the module has no session state.

import { buttonActionFromOpen, renderableBoardCover } from "../services/dual-agent/board-launch";

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
