// games/world-lab/src/board-island.tsx
//
// The lab's response board — the SAME renderer the AAC uses. It mounts a
// small React root that draws the shared `<BoardButtonVisual>` (client-shared)
// in a 2×4 grid, exactly as `AppMiniBoard` does during a game, fed by the
// quest host's board view through the same `lockedBoardFrom` shape. The glyph
// composition is the shared `GlyphCompositor` with the lab's bundled-icon
// resolver, so a button reads pixel-identical to the student's real board.
//
// Plus the FOOTER (concept-parser.md design contract): Yes / No / More are the
// always-present response affordances, and Speak opens the VOCABULARY — every
// word the concept parser understands (its `LEXICON`), each drawn with its glyph
// icon (if the registry has one). Tapping words composes a sentence; Play parses
// it and reports the intent, exercising the real parser end-to-end.
//
// The lab is otherwise vanilla TS; this is the only React island, wrapped in
// an imperative handle (mount / set / dispose) the vanilla host drives.

import { StrictMode, useEffect, useMemo, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { BoardButtonVisual } from "@client-shared/board/BoardButtonVisual";
import type { BoardButtonInput, BoardRenderDeps, GlyphRenderProps, IconVisual } from "@client-shared/board/types";
// The component lives in the .tsx (the bare `@shared/glyph-compositor`
// resolves to the types-only .ts) — import it explicitly, as the AAC does.
import { GlyphCompositor } from "@shared/glyph-compositor.tsx";
import type { QuestBoardView } from "@shared/symbol-game/quest-host";
import { LEXICON } from "@shared/symbol-game/parse-intent";
import { labImageResolver } from "./glyph-resolver";

// Icon/text sizing mirrors AppMiniBoard's 4-row column, so the buttons read the
// same on the lab bench as in the student's board.
const ICON_FONT = "clamp(1rem, calc((100dvh - 10.5rem) / 4 * 0.45), 6rem)";
const TEXT_FONT = "clamp(0.5rem, calc((100dvh - 10.5rem) / 4 * 0.10), 1.25rem)";

/** The lab's Glyph wrapper: the shared compositor with the bundled-icon
 *  resolver (the AAC injects its own; the lab injects this). */
function LabGlyph(p: GlyphRenderProps) {
  return (
    <GlyphCompositor
      glyph={p.glyph ?? p.fallback ?? ""}
      resolveImage={labImageResolver}
      noBackground={p.noBackground}
      ariaLabel={p.ariaLabel}
      fillSlot
    />
  );
}

/** Glyph-first icon resolution (game buttons always carry a composed glyph;
 *  fall back to the emoji iconRef). */
const resolveIcon = (button: BoardButtonInput): IconVisual => {
  if (button.glyph || button.glyphFallback) {
    return { kind: "glyph", glyph: button.glyph, fallback: button.glyphFallback };
  }
  if (button.iconRef) return { kind: "emoji", text: button.iconRef };
  return { kind: "placeholder" };
};

const deps: BoardRenderDeps = { resolveIcon, GlyphComponent: LabGlyph };

function BoardStrip({ view, onSelect }: { view: QuestBoardView | null; onSelect: (id: string) => void }) {
  const options = view?.options.slice(0, 8) ?? [];
  return (
    <div className="quest-boardpanel-inner">
      <div className="quest-boardpanel-prompt">{view?.promptText ?? ""}</div>
      <div
        className="quest-boardpanel-grid"
        style={{
          gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
          gridTemplateRows: "repeat(4, minmax(0, 1fr))",
        }}
      >
        {options.map((o, i) => {
          const button: BoardButtonInput = {
            label: o.label,
            glyph: o.glyph,
            iconRef: o.iconRef,
            sentence: o.spokenText,
          };
          return (
            <BoardButtonVisual
              key={o.id + i}
              button={button}
              deps={deps}
              variant="board"
              onClick={() => onSelect(o.id)}
              iconFontSize={ICON_FONT}
              textFontSize={TEXT_FONT}
              borderClassName="board-btn-border"
            />
          );
        })}
      </div>
    </div>
  );
}

// ── Footer: the always-present response affordances (concept-parser.md §3) ────

function Footer({
  onAffirm,
  onDecline,
  onMore,
  onSpeak,
}: {
  onAffirm: () => void;
  onDecline: () => void;
  onMore: () => void;
  onSpeak: () => void;
}) {
  return (
    <div className="lab-footer">
      <button className="lab-footer-btn lab-yes" onClick={onAffirm}>✓ Yes</button>
      <button className="lab-footer-btn lab-no" onClick={onDecline}>✗ No</button>
      <button className="lab-footer-btn" onClick={onMore}>⋯ More</button>
      <button className="lab-footer-btn lab-speak" onClick={onSpeak}>💬 Speak</button>
    </div>
  );
}

// ── Speak menu: the parser's whole vocabulary, grouped, with glyph icons ──────

const CATEGORY_ORDER = ["person", "verb", "attribute", "quantity", "relation", "question", "connective", "social"] as const;
const CATEGORY_LABEL: Record<string, string> = {
  person: "People",
  verb: "Actions",
  attribute: "Descriptions",
  quantity: "Amounts",
  relation: "Links",
  question: "Questions",
  connective: "Joiners",
  social: "Social",
};
const WORD_LABEL: Record<string, string> = {
  i_me: "I / me",
  dont_understand: "don't understand",
  in_order_to: "in order to",
};
const wordLabel = (w: string): string => WORD_LABEL[w] ?? w.replace(/_/g, " ");

/** The parser vocabulary, grouped by lexical category in a friendly order. */
function useVocabularyGroups() {
  return useMemo(() => {
    const byCat = new Map<string, string[]>();
    for (const [word, lex] of Object.entries(LEXICON)) {
      const arr = byCat.get(lex.cat) ?? [];
      arr.push(word);
      byCat.set(lex.cat, arr);
    }
    return CATEGORY_ORDER.filter((c) => byCat.has(c)).map((c) => ({
      cat: c,
      label: CATEGORY_LABEL[c] ?? c,
      words: byCat.get(c)!,
    }));
  }, []);
}

function SpeakMenu({ onClose, onSpeak }: { onClose: () => void; onSpeak: (sentence: string) => void }) {
  const groups = useVocabularyGroups();
  const [words, setWords] = useState<string[]>([]);
  const sentence = words.join(" + ");

  const play = () => {
    if (!words.length) return;
    onSpeak(sentence); // the host parses, compiles, and drives the creature (then toasts)
    setWords([]);
  };

  return (
    <div className="lab-speak-overlay" data-dwell-trap onClick={onClose}>
      <div className="lab-speak-panel" onClick={(e) => e.stopPropagation()}>
        <div className="lab-speak-head">
          <span>Speak — the parser vocabulary</span>
          <button className="lab-footer-btn" onClick={onClose}>✕ Close</button>
        </div>
        <div className="lab-speak-compose">
          <div className="lab-speak-sentence">{sentence || <span className="lab-dim">tap words to build a sentence…</span>}</div>
          <button className="lab-footer-btn" disabled={!words.length} onClick={() => setWords((w) => w.slice(0, -1))}>⌫</button>
          <button className="lab-footer-btn" disabled={!words.length} onClick={() => setWords([])}>Clear</button>
          <button className="lab-footer-btn lab-speak" disabled={!words.length} onClick={play}>▶ Play</button>
        </div>
        <div className="lab-speak-scroll">
          {groups.map((g) => (
            <section key={g.cat} className="lab-speak-group">
              <h4>{g.label}</h4>
              <div className="lab-speak-grid">
                {g.words.map((w) => (
                  <button key={w} className="lab-word" title={w} onClick={() => setWords((cur) => [...cur, w])}>
                    <span className="lab-word-icon">
                      <LabGlyph glyph={w} fallback={w} ariaLabel={w} noBackground />
                    </span>
                    <span className="lab-word-label">{wordLabel(w)}</span>
                  </button>
                ))}
              </div>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── The island: board + footer + (optional) speak menu, with imperative set ───

function BoardApp({
  onSelect,
  onSpeak,
  registerSet,
}: {
  onSelect: (id: string) => void;
  onSpeak: (sentence: string) => void;
  registerSet: (fn: (v: QuestBoardView | null) => void) => void;
}) {
  const [view, setView] = useState<QuestBoardView | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => {
    registerSet(setView);
  }, [registerSet]);
  return (
    <>
      <BoardStrip view={view} onSelect={onSelect} />
      <Footer
        onAffirm={() => onSpeak("yes")}
        onDecline={() => onSpeak("no")}
        onMore={() => onSpeak("more")}
        onSpeak={() => setMenuOpen(true)}
      />
      {menuOpen && <SpeakMenu onClose={() => setMenuOpen(false)} onSpeak={onSpeak} />}
    </>
  );
}

export interface BoardIsland {
  set(view: QuestBoardView | null): void;
  dispose(): void;
}

/** Mount the board island into `container`; `onSelect` fires a board button id
 *  (the host owns the voice, so the board never speaks). `onSpeak` sends a composed
 *  AAC sentence (or a footer word) to the host, which parses + drives a creature. */
export function mountBoardIsland(
  container: HTMLElement,
  onSelect: (id: string) => void,
  onSpeak: (sentence: string) => void = () => {},
): BoardIsland {
  const root: Root = createRoot(container);
  let setViewRef: ((v: QuestBoardView | null) => void) | null = null;
  root.render(
    <StrictMode>
      <BoardApp onSelect={onSelect} onSpeak={onSpeak} registerSet={(fn) => (setViewRef = fn)} />
    </StrictMode>,
  );
  return {
    set: (view) => setViewRef?.(view),
    dispose: () => root.unmount(),
  };
}
