/**
 * context-sidebar.ts
 *
 * The CONTEXT SIDEBAR queue — the short strip of buttons the AI adds beside the
 * board (`add_context_button`) to keep a just-mentioned thing within reach: the
 * dog someone is talking about, grandma on the phone, the word the student was
 * hunting for a minute ago.
 *
 * A queue, not a board: it holds the last few, and a new arrival pushes the
 * oldest out. Small on purpose — it sits beside the board the student is
 * actually reading, and a strip that grew would eat the board.
 *
 * Pure, and now the ONLY definition. The rules used to be written twice, in
 * DualAgentContext (which owns the live list) and in home.tsx (which mirrors it
 * to apply symbol updates). The two matched labels differently — the provider
 * case-insensitively, home.tsx byte-exact — so a generated symbol could land on
 * one copy of the strip and not the other. Case-insensitive wins here: labels
 * come back from an image pipeline keyed by label, and it is the same rule the
 * board slots already use.
 */

/** A context-strip button. Structurally a board button minus placement — the
 *  strip lays them out itself. */
export interface ContextButton {
  label: string;
  iconRef: string;
  symbolPath?: string;
  imageKey?: string;
  sentence?: string;
  buttonType?: string;
  glyph?: string;
  glyphFallback?: string;
}

/** How many stay visible. More would crowd the board it sits beside. */
export const CONTEXT_BUTTON_LIMIT = 4;

function sameLabel(a: string | undefined, b: string | undefined): boolean {
  return (a ?? "").toLowerCase() === (b ?? "").toLowerCase();
}

/** A new context button arrived — append, and drop the oldest past the cap. */
export function addContextButton(
  list: ContextButton[],
  button: ContextButton,
  limit: number = CONTEXT_BUTTON_LIMIT,
): ContextButton[] {
  return [...list, button].slice(-limit);
}

/** The AI retired a context button (`context_button_remove`), by label. */
export function removeContextButton(list: ContextButton[], label: string): ContextButton[] {
  if (!label) return list;
  return list.filter((b) => !sameLabel(b.label, label));
}

/** An auto-generated symbol finished — attach it to every matching button. */
export function applyContextSymbolUpdate(
  list: ContextButton[],
  update: { buttonLabel: string; symbolPath: string },
): ContextButton[] {
  return list.map((b) =>
    sameLabel(b.label, update.buttonLabel) ? { ...b, symbolPath: update.symbolPath } : b,
  );
}
