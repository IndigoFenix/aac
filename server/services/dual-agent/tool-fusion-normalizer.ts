// server/services/dual-agent/tool-fusion-normalizer.ts
//
// Generic recovery from a Gemini-Flash quirk where the model fuses a
// tool's name with one of its param names into a single PascalCase
// identifier and emits THAT as the tool name.
//
//   declared: rebuild_board(buttons)
//   model    : RebuildBoardButtons({speech, sentence, label})
//
//   declared: suggest_construction_buttons(slot_index, head_candidates, modifier_candidates)
//   model    : SuggestConstructionButtonsHeadCandidates({symbol, label})
//
// The fused name carries the param name in its suffix, and the args are
// usually a single instance of what the param's array would hold. We
// build a lookup from the declared tool schemas once per invocation,
// then on each incoming tool call check if its name is a known fusion
// and rewrite it into the canonical { tool, { paramName: [arg] } } form.
//
// Anything that doesn't fit the fusion pattern is left alone — the
// caller can still warn or drop unknown calls.

import type { FunctionDeclaration } from "@google/genai";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FusionEntry {
  /** The real (declared) tool name. */
  toolName: string;
  /** The param name the trailing fused segment matched. */
  paramName: string;
  /** Whether the declared param is an array — controls how we wrap a
   *  single-object arg. */
  paramIsArray: boolean;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build a lookup of every plausible `<ToolPascal><ParamPascal>` fusion
 * across a tool set. The map's keys are the fused PascalCase names; the
 * values describe how to rewrite a call back to its declared form.
 *
 * Snake_case tool names and param names are converted to PascalCase by
 * uppercasing the first character of each underscore-split segment and
 * joining with no separator.
 */
export function buildFusionMap(
  declarations: FunctionDeclaration[],
): Map<string, FusionEntry> {
  const map = new Map<string, FusionEntry>();
  for (const decl of declarations) {
    if (!decl.name) continue;
    const toolPascal = snakeToPascal(decl.name);
    const schema = decl.parametersJsonSchema as
      | { properties?: Record<string, { type?: string }> }
      | undefined;
    const properties = schema?.properties ?? {};
    for (const [paramName, paramSchema] of Object.entries(properties)) {
      const paramPascal = snakeToPascal(paramName);
      const fused = toolPascal + paramPascal;
      // Skip the degenerate case where the fused name happens to equal
      // the real tool name (would never trigger anyway, but keeps the
      // map clean).
      if (fused === decl.name) continue;
      map.set(fused, {
        toolName: decl.name,
        paramName,
        paramIsArray: (paramSchema as { type?: string })?.type === "array",
      });
    }
  }
  return map;
}

/**
 * Apply a fusion entry to incoming args. Returns the rewritten args
 * object that should be paired with `entry.toolName`.
 *
 *   - If args already contains the right wrapper key (`paramName`),
 *     args is returned unchanged.
 *   - If the declared param is an array and args is a single object,
 *     args is wrapped as `[args]` under the param name.
 *   - Otherwise args is placed under the param name as-is.
 *
 * `slot_index` (or other scalar siblings) is preserved when present so
 * the model doesn't lose context if it happened to include one.
 */
export function applyFusionEntry(
  entry: FusionEntry,
  args: Record<string, any>,
): Record<string, any> {
  // Already shaped correctly — just rename the tool, no arg surgery.
  if (entry.paramName in args) return args;

  // Pull aside any scalar siblings the model included (e.g. slot_index)
  // so they stay on the rewritten call. Object-shaped fields go into
  // the wrapped param.
  const scalars: Record<string, any> = {};
  const remainder: Record<string, any> = {};
  for (const [k, v] of Object.entries(args)) {
    if (v === null || ["string", "number", "boolean"].includes(typeof v)) {
      scalars[k] = v;
    } else {
      remainder[k] = v;
    }
  }

  // If a recognizable single-object value is present, use it; else the
  // entire `args` (sans scalars) becomes the wrapped value.
  const candidate = Object.keys(remainder).length > 0 ? remainder : args;

  const value = entry.paramIsArray
    ? (Array.isArray(candidate) ? candidate : [candidate])
    : candidate;

  return { ...scalars, [entry.paramName]: value };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function snakeToPascal(s: string): string {
  return s
    .split("_")
    .filter(Boolean)
    .map(p => p.charAt(0).toUpperCase() + p.slice(1))
    .join("");
}
