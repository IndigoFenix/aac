// server/services/guided-setup/flow-prompt-section.ts
//
// Renders the guided-flow system-prompt section. Appended LAST in the system
// prompt (prompt-kit's `trailingSection`) so the cached Anthropic prefix above
// it stays byte-identical between turns — volatile text early in the prompt
// turns cache READS (0.1x) into WRITES (1.25x).
//
// Deterministic: same inputs → byte-identical output.

export const GUIDED_FLOW_SECTION_HEADER = "=== Section: Guided Setup ===";

export interface GuidedSetupSectionAttrs {
  flow: string;
  account: string;
  term: string;
  /** "n/N" or "done" — see engine.stepPosition. */
  step: string;
  /**
   * Why the CURRENT step cannot be worked on, when it cannot (e.g. "consent").
   * Rendered ONLY then, immediately after `step`, so the header can never read
   * as an invitation to start a step the engine has locked: a bare
   * `step="2/4"` was enough for the model to open with step 2's first question
   * while the consent gate was shut.
   */
  blocked?: string;
  consent: string;
  lang: string;
}

/**
 * Attribute order is fixed so the rendered block is byte-stable. Optional
 * attributes are omitted when unset, so an unblocked step renders exactly the
 * bytes it did before `blocked` existed; a required one always renders, even
 * empty, because a silently missing attribute is harder to spot than `x=""`.
 */
const ATTR_ORDER: ReadonlyArray<keyof GuidedSetupSectionAttrs> = [
  "flow",
  "account",
  "term",
  "step",
  "blocked",
  "consent",
  "lang",
];

const OPTIONAL_ATTRS: ReadonlySet<keyof GuidedSetupSectionAttrs> = new Set(["blocked"]);

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/**
 * Wrap a step's prompt block in the `<guided_setup …>` tag and the section
 * header. `block` is trimmed; a trailing newline is added so the section
 * concatenates cleanly.
 */
export function renderGuidedSetupSection(
  attrs: GuidedSetupSectionAttrs,
  block: string,
): string {
  const attrText = ATTR_ORDER.filter((k) => !OPTIONAL_ATTRS.has(k) || !!attrs[k])
    .map((k) => `${k}="${escapeAttr(attrs[k] ?? "")}"`)
    .join(" ");
  const body = block.trim();
  return (
    `${GUIDED_FLOW_SECTION_HEADER}\n\n` +
    `<guided_setup ${attrText}>\n` +
    `${body}\n` +
    `</guided_setup>\n`
  );
}
