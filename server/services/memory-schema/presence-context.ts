/**
 * presence-context.ts
 *
 * The seam between the live coordinator's presence ledger and everything that
 * writes a DURABLE record — the Monitor's memory ops, the rolling summary, the
 * close summary (planning-docs/aac-presence-ledger.md §6.1, §6.2).
 *
 * Why a registry and not a parameter: the memory ops are static field objects
 * shared by every session, reached through a generic `DBOperationContext`, and
 * the summarizers run in two different processes' worth of call stacks. Handing
 * each of them a ledger reference would mean threading one object through a
 * dozen signatures that have nothing to do with presence. Instead the
 * coordinator registers a PROVIDER for its session and every consumer looks it
 * up by session id.
 *
 * Two invariants this file exists to hold:
 *
 *  1. **Keyed by SESSION, never by student.** Two sessions of the same student
 *     can overlap (a clinician mirror beside the AAC device), and their
 *     ledgers are different. A student-keyed registry would let one session's
 *     verified list authorize the other's writes.
 *
 *  2. **No provider ⇒ byte-identical to the old behaviour.** The coordinator
 *     registers a provider ONLY when `aacSettings.presenceLedger` is on, so
 *     "a provider exists" IS the feature flag. Every function here returns
 *     undefined / "" / ok when there is none, and every caller must treat that
 *     as "do exactly what you did before".
 *
 * Pure-ish: the logic lives in `@shared/aac/presence-ledger`; this module only
 * owns the registry and the refusal wording.
 */

import {
  PresenceLedger,
  renderPresenceLists,
  checkDurablePresenceWrite,
  isStatusAtLeast,
  type PresenceLists,
  type PresenceListItem,
  type PresenceLedgerSnapshot,
  type PresenceStatus,
} from "@shared/aac/presence-ledger";

// ============================================================================
// The registry
// ============================================================================

/**
 * A PROVIDER, not a snapshot: the ledger keeps moving for the whole session
 * (a name hypothesized at minute 3 can be retracted at minute 30), and a
 * durable write must be checked against the ledger as it stands at WRITE time,
 * not as it stood when the session opened.
 */
type PresenceListsProvider = () => PresenceLists;

const providers = new Map<string, PresenceListsProvider>();

/** Called by the coordinator at session start — only when the student's
 *  `presenceLedger` flag is on. */
export function setPresenceListsProvider(sessionId: string, fn: PresenceListsProvider): void {
  if (!sessionId) return;
  providers.set(sessionId, fn);
}

/** Called by the coordinator at session close. Leaking a provider would keep a
 *  closed session's ledger alive for the life of the process. */
export function clearPresenceListsProvider(sessionId: string): void {
  if (!sessionId) return;
  providers.delete(sessionId);
}

/** How many providers are live. Diagnostics only (a leak shows up here). */
export function presenceProviderCount(): number {
  return providers.size;
}

/**
 * The session's current lists, or undefined when the feature is off for this
 * session. A provider that throws is treated as "off": a broken ledger must
 * never take the Monitor's memory writes down with it.
 */
export function getPresenceLists(sessionId: string | undefined | null): PresenceLists | undefined {
  if (!sessionId) return undefined;
  const fn = providers.get(sessionId);
  if (!fn) return undefined;
  try {
    const lists = fn();
    return isPresenceLists(lists) ? lists : undefined;
  } catch (err) {
    console.warn(
      `[presence-context] provider for session ${sessionId} threw — treating presence as unavailable:`,
      err instanceof Error ? err.message : String(err),
    );
    return undefined;
  }
}

function isPresenceLists(x: unknown): x is PresenceLists {
  const l = x as PresenceLists | undefined;
  return (
    !!l &&
    Array.isArray(l.verified) &&
    Array.isArray(l.unverified) &&
    Array.isArray(l.retracted)
  );
}

/**
 * The `[PRESENCE — system verified]` block for this session's summarizers and
 * the Monitor, or "" when the feature is off.
 *
 * Code hands the model the ANSWER instead of asking it to infer presence from
 * the conversation log — the inference is exactly what turned one weak face
 * match into "a person named X joined" in the permanent summary.
 */
export function presenceContextForSession(sessionId: string | undefined | null): string {
  const lists = getPresenceLists(sessionId);
  return lists ? renderPresenceLists(lists) : "";
}

/**
 * The same block from a STORED snapshot (`chat_sessions.presence_ledger`),
 * for the close summary — which runs after the coordinator has torn its
 * provider down. Guarded: a snapshot from an older writer, a truncated jsonb,
 * or a null column must yield undefined, never throw into the summary path.
 */
export function presenceListsFromSnapshot(snapshot: unknown): PresenceLists | undefined {
  if (!snapshot || typeof snapshot !== "object") return undefined;
  const s = snapshot as Partial<PresenceLedgerSnapshot>;
  if (!Array.isArray(s.entries)) return undefined;
  try {
    const ledger = PresenceLedger.fromSnapshot(s as PresenceLedgerSnapshot);
    const lists = ledger.lists();
    if (!lists.verified.length && !lists.unverified.length && !lists.retracted.length) {
      return undefined;
    }
    return lists;
  } catch (err) {
    console.warn(
      "[presence-context] presence_ledger snapshot unreadable — falling back to prompt-only guidance:",
      err instanceof Error ? err.message : String(err),
    );
    return undefined;
  }
}

/** The block rendered straight from a stored snapshot, or "" when unreadable. */
export function presenceContextFromSnapshot(snapshot: unknown): string {
  const lists = presenceListsFromSnapshot(snapshot);
  return lists ? renderPresenceLists(lists) : "";
}

// ============================================================================
// The durable-write gate
// ============================================================================

/**
 * The refusal the AI reads. It NAMES THE TOKEN and says what to write instead:
 * the board validator taught this the hard way — feedback that only said "that
 * was rejected" produced 139 rejected rebuilds in a row because the model had
 * nothing to change.
 */
function refusalMessage(token: string, reason: string, what: string): string {
  return (
    `Refused: ${what} claims "${token}" was present, and ${token} is not verified present this session. ` +
    `${reason}. Rewrite it without the presence claim — "asked for ${token}", "talked about ${token}" — ` +
    `or drop the name. Check the [PRESENCE — system verified] block for who may be recorded as present.`
  );
}

/**
 * Pure pre-write check. Returns ok when the feature is off for this session,
 * when the text is empty, or when nothing in it claims an unverified person was
 * present. Exported separately from `assertPresenceSafe` so tests (and any
 * caller that wants to report rather than throw) can see the verdict.
 */
export function checkPresenceSafe(
  text: unknown,
  sessionId: string | undefined | null,
): { ok: true } | { ok: false; token: string; reason: string } {
  const lists = getPresenceLists(sessionId);
  if (!lists) return { ok: true };
  return checkDurablePresenceWrite(collectStrings(text).join("\n"), lists);
}

/**
 * Throws when the value being written claims an unverified person was present.
 * The memory-tool bridge surfaces a thrown message to the Monitor as the op's
 * error, which is how the model learns to rephrase — the same channel the
 * `autoAddContacts` refusal already uses.
 *
 * `value` may be a string, an array, or an object: a `Student_People` entry is
 * `{ Name, Relationship }` and a contact update is a whole patch, so every
 * string reachable inside it is scanned.
 */
export function assertPresenceSafe(
  value: unknown,
  sessionId: string | undefined | null,
  what = "this entry",
): void {
  const verdict = checkPresenceSafe(value, sessionId);
  if (verdict.ok) return;
  throw new Error(refusalMessage(verdict.token, verdict.reason, what));
}

/** Every string reachable in a memory value, so an object-shaped entry is
 *  scanned as thoroughly as a plain note. Bounded depth: memory values are
 *  small, and a cycle must not hang a write. */
function collectStrings(value: unknown, depth = 0, out: string[] = []): string[] {
  if (depth > 4 || out.length > 200) return out;
  if (typeof value === "string") {
    if (value.trim()) out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectStrings(v, depth + 1, out);
    return out;
  }
  if (value && typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) {
      collectStrings(v, depth + 1, out);
    }
  }
  return out;
}

// ============================================================================
// Contact provenance (§6.2)
// ============================================================================

export interface ContactProvenance {
  /** The session whose ledger authorized the row. */
  sessionId: string;
  /** Ledger status of this name at creation time, or "unverified" when the
   *  ledger never heard of them (a name the Monitor produced on its own). */
  presence: PresenceStatus | "unverified";
  /** The ledger's own words for WHY — "face lookalike of X", "corroborated by
   *  face + voice". A clinician reviewing an autoAdded row sees the evidence,
   *  not just the guess. */
  reason: string;
  at: string;
}

function findListed(lists: PresenceLists, name: string): PresenceListItem | undefined {
  const needle = name.trim();
  if (!needle) return undefined;
  for (const item of [...lists.verified, ...lists.unverified, ...lists.retracted]) {
    if (item.name?.trim() === needle) return item;
  }
  return undefined;
}

/** True when `name` was struck from this session. A retracted person is the one
 *  case where a contact row must NOT be created: the row would outlive the
 *  correction that produced it. */
export function isRetractedName(lists: PresenceLists, name: string): boolean {
  const needle = name.trim();
  return lists.retracted.some((i) => i.name?.trim() === needle);
}

export function retractedContactRefusal(name: string): string {
  return (
    `Refused: "${name}" was RETRACTED this session — the identification was corrected. ` +
    `Do not create a contact for ${name}. If someone really is new here, wait for a verified identification.`
  );
}

/**
 * The `provenance` value for a row the AI is creating. Null when the feature is
 * off for this session — today's rows carry no provenance and must keep not
 * carrying one, so a clinician can tell "created before the ledger" from
 * "created with no evidence".
 */
export function contactProvenanceFor(
  name: string,
  sessionId: string | undefined | null,
  now: Date = new Date(),
): ContactProvenance | null {
  const lists = getPresenceLists(sessionId);
  if (!lists || !sessionId) return null;
  const item = findListed(lists, name);
  return {
    sessionId,
    presence: item?.status ?? "unverified",
    reason: item?.reason ?? "Monitor-created",
    at: now.toISOString(),
  };
}

/** Whether the ledger places `name` at or above `min` this session. Used by
 *  callers that gate an action on a rung of the permanence ladder (§5). */
export function presenceAtLeast(
  lists: PresenceLists,
  name: string,
  min: PresenceStatus,
): boolean {
  const item = findListed(lists, name);
  if (!item) return false;
  return isStatusAtLeast(item.status, min);
}
