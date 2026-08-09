/**
 * Smart-home action helpers — shared by server (press gating, agent context)
 * and clients (settings editor / button handlers).
 *
 * Home actions are clinician-authored slots stored in `aac_settings.home_actions`
 * (jsonb, mirrors `permitted_websites`). A `spoken` slot actuates on the DEVICE:
 * the AAC utters `command` aloud through the student-voice pipeline and the
 * family's own smart speaker acts on it. An `alexa`/`google` slot actuates on the
 * SERVER, through the provider seam in `server/services/smart-home/` — it has no
 * `command`; `announce` (defaulting to the label) is what the device says so the
 * press isn't silent. See planning-docs/smart-home-actions.md.
 *
 * Home actions are deliberately EXCLUDED from the AI-editable settings whitelists
 * in `server/services/memory-schema/aac-settings-memory-schema.ts` — the AI may surface an existing
 * action, but must never author or alter an actuation command.
 *
 * `normalizeHomeActions` is the single sanitization chokepoint: everything
 * downstream (prompt context, press gate, client buttons) reads the column
 * through it, never raw.
 */

import type { HomeAction } from "./schema";

/** Trim a value only if it is a string; anything else becomes "". */
function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Every action type the seam knows how to dispatch. */
const HOME_ACTION_TYPES = ["spoken", "alexa", "google"] as const;

function isHomeActionType(value: string): value is HomeAction["type"] {
  return (HOME_ACTION_TYPES as readonly string[]).includes(value);
}

/**
 * Defensively parse the `home_actions` jsonb column into usable slots.
 *
 * Every row needs a non-empty `id` + `label` and a KNOWN `type`. Beyond that
 * the rules are per-type:
 *  - `spoken` additionally requires a non-empty `command` (without the phrase
 *    there is nothing to utter, so the slot is a dead press).
 *  - `alexa`/`google` carry no `command` — any authored one is DROPPED, since
 *    a cloud slot actuates server-side — and an optional trimmed `announce`.
 *
 * Trims strings, drops duplicate ids (first VALID one wins) and defaults
 * `enabled` to true. Non-array input yields [].
 */
export function normalizeHomeActions(raw: unknown): HomeAction[] {
  if (!Array.isArray(raw)) return [];
  const out: HomeAction[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;
    const id = str(row.id);
    const label = str(row.label);
    const type = str(row.type);
    if (!id || !label) continue;
    if (!isHomeActionType(type)) continue;
    // Per-type requirements are checked BEFORE the id is claimed, so a
    // half-filled row never shadows a later valid one with the same id.
    const command = type === "spoken" ? str(row.command) : "";
    if (type === "spoken" && !command) continue;
    if (seen.has(id)) continue;
    seen.add(id);

    const action: HomeAction = { id, label, type };
    if (type === "spoken") {
      action.command = command;
    } else {
      // Cloud slot: the server actuates; `announce` is what the device says.
      // Left unset it falls back to the label at press time.
      const announce = str(row.announce);
      if (announce) action.announce = announce;
    }
    const icon = str(row.icon);
    if (icon) action.icon = icon;
    const description = str(row.description);
    if (description) action.description = description;
    if (row.requiresConfirmation === true) action.requiresConfirmation = true;
    action.enabled = row.enabled !== false;
    out.push(action);
  }
  return out;
}

/** The subset the student may actually fire (disabled slots stay authored but inert). */
export function enabledHomeActions(list: HomeAction[]): HomeAction[] {
  return list.filter((a) => a.enabled !== false);
}

/**
 * Look up an action by id among ENABLED actions only — this backs the
 * server-side press gate, so a disabled slot must be unfindable.
 */
export function findHomeAction(list: HomeAction[], id: string): HomeAction | undefined {
  const target = str(id);
  if (!target) return undefined;
  return enabledHomeActions(list).find((a) => a.id === target);
}
