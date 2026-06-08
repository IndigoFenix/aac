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
  /** The other declared params on the same tool. Used by applyFusionEntry
   *  to decide what to keep as outer siblings (e.g. `target` /
   *  `slot_index`) vs. what to fold into the wrapped item (e.g. for
   *  rebuild_board, `label` / `speech` / `glyph` belong INSIDE each
   *  button, even though `label`/`speech` are string-typed). Without
   *  this, a naive "strings go to outer scope" heuristic strips fields
   *  out of the item where they belong. */
  siblingParamNames: Set<string>;
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
    const allParamNames = Object.keys(properties);
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
        siblingParamNames: new Set(allParamNames.filter(n => n !== paramName)),
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

  // Schema-aware split: keys that match a DECLARED sibling param on
  // the same tool stay at the outer level (target, slot_index, etc.).
  // Everything else collapses into the wrapped item — for rebuild_board
  // that means label/speech/glyph end up INSIDE each button as
  // intended, instead of being stripped to the outer scope because
  // they happen to be string-typed.
  const siblings: Record<string, any> = {};
  const itemFields: Record<string, any> = {};
  for (const [k, v] of Object.entries(args)) {
    if (entry.siblingParamNames.has(k)) {
      siblings[k] = v;
    } else {
      itemFields[k] = v;
    }
  }

  // If the model emitted ONLY sibling-typed args (rare; e.g. a pure
  // slot_index call with no payload), `itemFields` is empty and we
  // don't want to invent an empty object. Otherwise wrap normally.
  const value = entry.paramIsArray
    ? (Object.keys(itemFields).length > 0 ? [itemFields] : [])
    : itemFields;

  return { ...siblings, [entry.paramName]: value };
}

/**
 * Collapse parallel fused calls that target the same (toolName, paramName)
 * when the param is an array. The model frequently emits ONE fused call
 * per item (e.g. six `RebuildBoardButtons` calls in a single response,
 * one per intended board button); without merging, each gets rewritten
 * to a single-item `rebuild_board` and the dispatch layer then handles
 * each one independently — wiping or overlaying as if six discrete
 * intents arrived, never as the one bulk rebuild the model meant.
 *
 * Input is the raw tool-call list returned by the provider. Output is a
 * new list where:
 *   - Each cluster of ≥1 fused calls targeting (tool, arrayParam) is
 *     replaced by ONE call with `{ [paramName]: [item1, item2, ...] }`
 *     (scalars from the first call in the cluster are preserved as
 *     siblings).
 *   - Non-fused calls and fused calls targeting non-array params pass
 *     through unchanged, in their original positions where possible.
 *
 * Order is preserved by the first appearance of each (tool, param) key.
 */
export function mergeFusedToolCalls<
  T extends { name?: string; arguments: string },
>(
  calls: T[],
  fusionMap: Map<string, FusionEntry> | undefined,
): T[] {
  if (!fusionMap || calls.length === 0) return calls.slice();

  type Cluster = {
    firstIndex: number;
    entry: FusionEntry;
    items: any[];
    scalars: Record<string, any>;
  };
  const clusters = new Map<string, Cluster>();
  const output: Array<T | { __cluster: string }> = [];

  for (let i = 0; i < calls.length; i++) {
    const call = calls[i];
    const entry = call.name ? fusionMap.get(call.name) : undefined;
    if (!entry || !entry.paramIsArray) {
      output.push(call);
      continue;
    }
    let args: Record<string, any> = {};
    try {
      args = call.arguments ? JSON.parse(call.arguments) : {};
    } catch {
      // Malformed args — fall back to passing the call through.
      output.push(call);
      continue;
    }

    // Per-call item(s): either the already-shaped paramName array, or
    // a single object built from the schema-aware split of loose args
    // (siblings stay outer, everything else folds into the item).
    let items: any[];
    let callSiblings: Record<string, any> = {};
    if (Array.isArray(args[entry.paramName])) {
      items = args[entry.paramName];
      for (const [k, v] of Object.entries(args)) {
        if (k !== entry.paramName && entry.siblingParamNames.has(k)) {
          callSiblings[k] = v;
        }
      }
    } else if (entry.paramName in args) {
      items = [args[entry.paramName]];
      for (const [k, v] of Object.entries(args)) {
        if (k !== entry.paramName && entry.siblingParamNames.has(k)) {
          callSiblings[k] = v;
        }
      }
    } else {
      const itemFields: Record<string, any> = {};
      for (const [k, v] of Object.entries(args)) {
        if (entry.siblingParamNames.has(k)) {
          callSiblings[k] = v;
        } else {
          itemFields[k] = v;
        }
      }
      items = Object.keys(itemFields).length > 0 ? [itemFields] : [];
    }

    const key = `${entry.toolName}::${entry.paramName}`;
    let cluster = clusters.get(key);
    if (!cluster) {
      cluster = { firstIndex: i, entry, items: [], scalars: { ...callSiblings } };
      clusters.set(key, cluster);
      output.push({ __cluster: key });
    } else {
      // Merge sibling values from later calls only when absent — the
      // first non-empty wins so we don't overwrite a meaningful value
      // with a later one.
      for (const [k, v] of Object.entries(callSiblings)) {
        if (!(k in cluster.scalars)) cluster.scalars[k] = v;
      }
    }
    cluster.items.push(...items);
  }

  // Materialize cluster markers into synthesized merged calls.
  const result: T[] = [];
  for (const slot of output) {
    if ((slot as any).__cluster) {
      const key = (slot as { __cluster: string }).__cluster;
      const cluster = clusters.get(key)!;
      const merged = {
        ...cluster.scalars,
        [cluster.entry.paramName]: cluster.items,
      };
      // Synthesize a call with the FUSED name preserved so downstream
      // detection/feedback (which reads `call.name`) still recognises it
      // as a fusion. applyFusionEntry will rewrite the name on its
      // normal pass.
      const synthesizedName =
        snakeToPascal(cluster.entry.toolName) +
        snakeToPascal(cluster.entry.paramName);
      result.push({
        name: synthesizedName,
        arguments: JSON.stringify(merged),
      } as T);
    } else {
      result.push(slot as T);
    }
  }
  return result;
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
