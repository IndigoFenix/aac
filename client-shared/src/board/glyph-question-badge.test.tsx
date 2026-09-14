/**
 * The six WH-words (what/who/where/when/why/how) and the bare `question` key
 * are all `tone: "question"`, all `modifier.transform: "badge"`, and all
 * anchor `corner: "top-right"` — every one of them draws the identical ❓
 * mark. The AI habitually stacks two of them on one slot ("what.question",
 * "how.question" — see the registry comment on the `question` key), which
 * used to render two adjacent ❓ badges in the same corner instead of one.
 *
 * `renderToStaticMarkup` needs no DOM, so this stays inside the project's
 * `testEnvironment: 'node'` client config (jest.config.client.js) rather than
 * pulling in jsdom/@testing-library for a single assertion.
 */
import { describe, it, expect } from "@jest/globals";
import { renderToStaticMarkup } from "react-dom/server";
import * as React from "react";
import { GlyphCompositor } from "@shared/glyph-compositor.tsx";

function questionBadgeCount(glyph: string): number {
  const markup = renderToStaticMarkup(React.createElement(GlyphCompositor, { glyph }));
  return (markup.match(/❓/g) ?? []).length;
}

describe("GlyphCompositor — redundant question-tone badges", () => {
  it("collapses a WH-word + the `question` key on one slot to ONE badge", () => {
    // "what.question" parses to head "thing" with modifiers ["what", "question"]
    // (`what` expands via its registry `expandsTo: "thing.what"`).
    expect(questionBadgeCount("what.question")).toBe(1);
  });

  it("collapses two WH-words on the same slot to ONE badge", () => {
    expect(questionBadgeCount("apple.what.how")).toBe(1);
  });

  it("still draws the ❓ badge for a single question-tone modifier", () => {
    expect(questionBadgeCount("apple.what")).toBe(1);
  });

  it("leaves an unrelated badge (a different tone) on the same slot alone", () => {
    // `what` (❓, tone "question") and `hot` (🔥, tone "comment") both draw a
    // badge; only the question-tone dedup applies, not a general
    // one-badge-per-slot cap.
    const markup = renderToStaticMarkup(
      React.createElement(GlyphCompositor, { glyph: "apple.what.hot" }),
    );
    expect((markup.match(/❓/g) ?? []).length).toBe(1);
    expect((markup.match(/🔥/g) ?? []).length).toBe(1);
  });
});
