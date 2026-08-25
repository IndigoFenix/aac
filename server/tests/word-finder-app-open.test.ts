/**
 * An AI `open_app` that arrives while the WORD FINDER is open.
 *
 * THE FAILURE THIS REPLACES (observed live 2026-08-25). A child in the Word
 * Finder was searching for a jungle scene. The Speaker called
 * `open_app("picture_search", …)` five times over two minutes; every one was
 * refused by a hard gate, and nothing ever appeared on the screen. Searching
 * for a thing and being denied that exact thing is the opposite of what the
 * Word Finder is for — and it does not close itself, so the child had no way
 * out of the loop.
 *
 * Worse, the refusal only reached the Speaker. The same event object was
 * handed to the Board Manager unmodified, which renders `app_open_requested`
 * as `[APP OPEN] …` — so the board was rebuilt for pictures that were never
 * shown ("more pictures", in Hebrew, over an unchanged screen). A refusal has
 * to be legible to EVERY agent that sees the event, not just the one holding
 * the tool call.
 *
 * Two properties are pinned here:
 *   1. First open ASKS, an immediate repeat CONFIRMS (and only within the
 *      window, and only for the same app).
 *   2. A blocked open renders as a refusal, never as an open.
 *
 * DB-free and Coordinator-free: the decision is a pure function and the
 * rendering is a pure function, which is the whole reason the gate lives in
 * its own module.
 */

import { describe, test, expect } from "@jest/globals";
import {
  decideWordFinderOpen,
  wordFinderOpenAskNote,
  WORD_FINDER_OPEN_CONFIRM_MS,
} from "../services/dual-agent/word-finder-open-gate";
import { renderEventLine } from "../services/dual-agent/prompts/board-manager";
import type { AppOpenRequestedEvent } from "../services/dual-agent/agent-events";

const T0 = 1_700_000_000_000;

function openEvent(over: Partial<AppOpenRequestedEvent> = {}): AppOpenRequestedEvent {
  return {
    type: "app_open_requested",
    source: "speaker",
    timestamp: T0,
    appId: "picture_search",
    data: "jungle",
    ...over,
  };
}

describe("the Word Finder ask", () => {
  test("the first open is asked, not opened", () => {
    expect(decideWordFinderOpen(null, "picture_search", T0)).toEqual({ kind: "ask" });
  });

  test("an immediate repeat of the same app confirms", () => {
    const pending = { appId: "picture_search", at: T0 };
    expect(decideWordFinderOpen(pending, "picture_search", T0 + 1_500)).toEqual({
      kind: "confirmed",
    });
  });

  test("a repeat past the window is a fresh ask, not a stale yes", () => {
    const pending = { appId: "picture_search", at: T0 };
    expect(
      decideWordFinderOpen(pending, "picture_search", T0 + WORD_FINDER_OPEN_CONFIRM_MS + 1),
    ).toEqual({ kind: "ask" });
  });

  test("a DIFFERENT app never rides someone else's ask", () => {
    // The confirmation is per-app on purpose: "yes, open the pictures they
    // were looking for" must not become "yes, open YouTube".
    const pending = { appId: "picture_search", at: T0 };
    expect(decideWordFinderOpen(pending, "youtube", T0 + 100)).toEqual({ kind: "ask" });
  });

  test("the ask names the app and spells out BOTH branches", () => {
    // The old note said only "help the user find their word first", which a
    // model reads as "try again" — and it did, five times.
    const note = wordFinderOpenAskNote("restaurant");
    expect(note).toContain(`open_app("restaurant")`);
    expect(note.toLowerCase()).toContain("searching for");
    expect(note.toLowerCase()).toContain("changing the subject");
  });
});

describe("what the Board Manager is told", () => {
  test("an open that happened renders as an open", () => {
    expect(renderEventLine(openEvent())).toBe("[APP OPEN] picture_search (jungle)");
  });

  test("a REFUSED open never renders as an open", () => {
    const line = renderEventLine(openEvent({ blocked: "the Word Finder was open" }));
    expect(line).toContain("[APP OPEN REFUSED]");
    expect(line).toContain("picture_search (jungle)");
    expect(line).toContain("the Word Finder was open");
    // The exact regression: the board must not be built for a screen that
    // never appeared.
    expect(line).not.toMatch(/^\[APP OPEN\]/);
  });
});
