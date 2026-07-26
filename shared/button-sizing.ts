// shared/button-sizing.ts
//
// Lives in shared/ rather than client-shared/ for the same reason
// `button-color.ts` does: it is pure logic with no React or DOM, and every
// surface that renders a board button — both clients, the games, and the test
// suite — needs it under the one alias they all already resolve.
//
// The single source of truth for how a board button divides its height between
// icon and label, shared by the student's board and the clinician settings
// preview so the preview is accurate BY CONSTRUCTION rather than by someone
// remembering to keep two tables in step. (It previously wasn't: the preview
// laid its rows out with `flex: iconFlex/textFlex` while the real renderer
// ignored those numbers entirely — the icon area was hard-wired to `flex: 1`
// and the label to `maxHeight: 40%`. The preview was drawing a layout the app
// had stopped using.)
//
// HOW SIZING WORKS NOW. Both rows are flex items whose share comes from the
// level, and BOTH fill their share using container queries — the icon via
// `cqmin` (already how `.icon-fill-emoji` works) and the label via `cqh`/`cqw`.
// So the label is as large as its share allows, and the share is the only
// knob. That is what makes "text as large as the icons themselves" expressible
// at all: it is simply `iconFlex === textFlex` (level 5).
//
// There is deliberately NO absolute (rem) cap on the label. A cap would make
// the preview lie at large sizes — it would bite on a real 200px-tall button
// but not on an 80px preview tile — and the flex share is already the bound.

export interface RatioLevel {
  /** Share of the button's height given to the icon. */
  iconFlex: number;
  /** Share given to the label row. */
  textFlex: number;
  /** Most lines the label may wrap to. */
  maxLines: 1 | 2;
  /**
   * Only used for multi-character text icons (the `emoji` icon branch that
   * isn't a single grapheme), which can't fill their box the way a symbol or
   * a single emoji does. Real icons ignore this and fill their flex share.
   */
  iconScale: number;
}

/**
 * Level 3 is the default. The label's share climbs steadily so that a clinician
 * moving the slider sees a real change at every step, ending at 1:1 — text the
 * same size as the icon, which is what prompted this table's revision.
 */
export const RATIO_LEVELS: Record<number, RatioLevel> = {
  1: { iconFlex: 9, textFlex: 1, maxLines: 1, iconScale: 0.55 },
  2: { iconFlex: 4, textFlex: 1, maxLines: 2, iconScale: 0.5 },
  3: { iconFlex: 5, textFlex: 2, maxLines: 2, iconScale: 0.45 },
  4: { iconFlex: 3, textFlex: 2, maxLines: 2, iconScale: 0.35 },
  5: { iconFlex: 1, textFlex: 1, maxLines: 2, iconScale: 0.25 },
};

export const DEFAULT_RATIO_LEVEL = 3;

export function ratioLevel(level: number | undefined): RatioLevel {
  return RATIO_LEVELS[Math.max(1, Math.min(5, level ?? DEFAULT_RATIO_LEVEL))] ?? RATIO_LEVELS[DEFAULT_RATIO_LEVEL];
}

/** Fraction of the label row's height one line of text is allowed to occupy. */
const HEIGHT_FILL = 0.82;
/** Labels shorter than this stay on one line even when two are permitted. */
const WRAP_MIN_CHARS = 8;

/**
 * Roughly how wide one character is, in em. CJK and fullwidth glyphs are about
 * twice as wide as Latin/Cyrillic/Hebrew/Arabic, and treating them as narrow
 * would let a Chinese label overflow its button.
 */
function advanceEm(label: string): number {
  const CJK = /[　-鿿가-힯＀-￯]/;
  return CJK.test(label) ? 1.0 : 0.55;
}

/** How many lines this label will be laid out on. */
export function labelLines(label: string, level: RatioLevel): 1 | 2 {
  if (level.maxLines === 1) return 1;
  const text = label.trim();
  // Wrapping needs somewhere to break — a single long word can't use a second
  // line, so it gets shrunk by the width term instead.
  if (!/\s/.test(text)) return 1;
  return text.length > WRAP_MIN_CHARS ? 2 : 1;
}

/**
 * A CSS font-size for the label that fills its row without overflowing it.
 * Both terms are container-relative, so this expression is correct at any
 * button size — an 80px preview tile and a 300px board button alike.
 *   cqh term — fill the row's height, divided by the number of lines
 *   cqw term — shrink if the text is too long to fit the row's width
 */
export function labelFontSize(label: string, level: RatioLevel): string {
  const lines = labelLines(label, level);
  const perLine = Math.max(1, Math.ceil(label.trim().length / lines));
  const heightTerm = (HEIGHT_FILL * 100) / lines;
  const widthTerm = 100 / (advanceEm(label) * perLine);
  return `min(${heightTerm.toFixed(1)}cqh, ${widthTerm.toFixed(1)}cqw)`;
}
