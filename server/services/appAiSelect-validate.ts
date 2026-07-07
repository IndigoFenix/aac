// server/services/appAiSelect-validate.ts
// Pure validation + rate-limiting for the app-ai/select endpoint, split out from
// appAiService.ts so tests can exercise it WITHOUT importing @google/genai /
// credit-ledger (which drag in heavier deps). See appAiService.ts for the LLM call.

export interface AppAiSelectOption {
  id: string;
  label: string;
  description?: string;
}
export interface AppAiSelectRequest {
  options: AppAiSelectOption[];
  instruction?: string;
  context?: string;
}
export interface AppAiSelectResult {
  selectedId: string;
  reason?: string;
}

// Input bounds — keep the prompt small and the surface abuse-resistant.
export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 50;
export const MAX_LABEL = 200;
export const MAX_TEXT = 2000;

/**
 * Validate + normalize a raw request body into an AppAiSelectRequest, or return
 * a reason string. Pure (no I/O) so it's unit-testable without the LLM.
 */
export function normalizeSelectRequest(
  body: unknown,
): { ok: true; value: AppAiSelectRequest } | { ok: false; error: string } {
  if (!body || typeof body !== "object") return { ok: false, error: "invalid body" };
  const b = body as Record<string, unknown>;

  const rawOptions = b.options;
  if (!Array.isArray(rawOptions)) return { ok: false, error: "options must be an array" };
  if (rawOptions.length < MIN_OPTIONS) return { ok: false, error: `at least ${MIN_OPTIONS} options required` };
  if (rawOptions.length > MAX_OPTIONS) return { ok: false, error: `too many options (max ${MAX_OPTIONS})` };

  const seen = new Set<string>();
  const options: AppAiSelectOption[] = [];
  for (const raw of rawOptions) {
    const o = raw as Record<string, unknown>;
    const id = typeof o?.id === "string" ? o.id.trim() : "";
    const label = typeof o?.label === "string" ? o.label.trim() : "";
    if (!id || !label) return { ok: false, error: "each option needs a non-empty id and label" };
    if (seen.has(id)) return { ok: false, error: `duplicate option id: ${id}` };
    seen.add(id);
    const description = typeof o?.description === "string" ? o.description.slice(0, MAX_TEXT) : undefined;
    options.push({ id, label: label.slice(0, MAX_LABEL), description });
  }

  const instruction = typeof b.instruction === "string" ? b.instruction.slice(0, MAX_TEXT) : undefined;
  const context = typeof b.context === "string" ? b.context.slice(0, MAX_TEXT) : undefined;
  return { ok: true, value: { options, instruction, context } };
}

// ── Per-caller rate limit (in-memory sliding window) ──
// Backstop against a runaway app; not a billing control (the ledger is).
export const WINDOW_MS = 60_000;
export const MAX_PER_WINDOW = 30;
const hits = new Map<string, number[]>();

export function allowAppAiSelect(key: string): boolean {
  const now = Date.now();
  const recent = (hits.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= MAX_PER_WINDOW) {
    hits.set(key, recent);
    return false;
  }
  recent.push(now);
  hits.set(key, recent);
  return true;
}
