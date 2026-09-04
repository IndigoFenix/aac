// server/services/dual-agent/speech-party.ts
//
// Speaker / target identity helpers for the three-agent flow. The
// Observer emits transcripts tagged with one of these party identifiers;
// Speaker and BoardManager use the helpers to decide who an utterance is
// "from" / "to" without doing string comparisons inline.
//
// The literal strings "DEVICE", "USER", and "UNKNOWN" are reserved. The
// active student's name (case-insensitive) is also recognized as USER —
// the Observer model occasionally writes the actual name instead of the
// literal token and we treat them as equivalent.

export const PARTY_DEVICE = "DEVICE";
export const PARTY_USER = "USER";
export const PARTY_UNKNOWN = "UNKNOWN";
/**
 * A real person in the room whose NAME the presence ledger has not verified.
 *
 * Distinct from UNKNOWN, which says "we do not know that anyone is there".
 * This one asserts presence and withholds only the identity — which is what
 * the ledger actually knows, and what keeps a guessed sister from being
 * greeted by name (planning-docs/aac-presence-ledger.md §4, §6). Routing is
 * unaffected: reply buttons are built off `targetIsUser`, never off the name.
 */
export const PARTY_NEARBY = "someone nearby";

/** True when a party label is the anonymised nearby-person token. */
export function isNearbyParty(value: string | undefined): boolean {
  if (!value) return false;
  return value.trim().toLowerCase() === PARTY_NEARBY;
}

/** Lowercase, punctuation-stripped word tokens of a name/value. The
 *  Observer model writes names with trailing punctuation ("שחף!"),
 *  honorifics, or in full ("שחף סוחמי") even when the system only knows
 *  the first name — so we compare on whole-word tokens, not raw strings. */
function nameTokens(s: string): string[] {
  return s
    .trim()
    .toLowerCase()
    .replace(/[!?.,…״”“"'`׳()[\]{}:;]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/** True when `value` refers to the same party as any of `names`. Matches
 *  if the whole token sequences are equal, OR the name's GIVEN name (first
 *  token) appears in `value` and one side's tokens are a subset of the
 *  other's. This makes a first-name config match a full-name target (and
 *  vice-versa): the Observer routinely tags speech with the student's FULL
 *  name while the system caches only the first name. Token-level matching
 *  avoids the exact-string mismatch that silently dropped board rebuilds
 *  for facilitator questions.
 *
 *  A shared SURNAME alone must never match: a caretaker usually carries
 *  the student's family name, and any-token matching made the attribution
 *  trust gate read the mother ("לילית זיסמן") as the non-verbal student
 *  ("הדר זיסמן") — every utterance she aimed at her daughter was demoted
 *  to ambient hearsay (no caption, no board rebuild). Likewise two full
 *  names that share a given name but differ in surname ("הדר לוי" vs
 *  "הדר זיסמן") are different people and do not match. */
function matchesAnyName(value: string, names: (string | undefined)[]): boolean {
  const valTokens = nameTokens(value);
  if (valTokens.length === 0) return false;
  const valJoined = valTokens.join(" ");
  for (const n of names) {
    if (!n) continue;
    const nTokens = nameTokens(n);
    if (nTokens.length === 0) continue;
    if (valJoined === nTokens.join(" ")) return true;
    if (!valTokens.includes(nTokens[0])) continue;
    const [shorter, longer] =
      valTokens.length <= nTokens.length ? [valTokens, nTokens] : [nTokens, valTokens];
    if (shorter.every((t) => longer.includes(t))) return true;
  }
  return false;
}

/** Identifies the AI itself. The AI may also be referred to by its
 *  configured name(s); pass any known forms in (full and/or short). */
export function isDeviceTarget(
  value: string | undefined,
  ...aiNames: (string | undefined)[]
): boolean {
  if (!value) return false;
  if (value.trim().toUpperCase() === PARTY_DEVICE) return true;
  return matchesAnyName(value, aiNames);
}

/** Identifies the active user. Accepts the literal "USER" token OR any
 *  known form of the student's name (first, full, with punctuation). */
export function isUserTarget(
  value: string | undefined,
  ...studentNames: (string | undefined)[]
): boolean {
  if (!value) return false;
  if (value.trim().toUpperCase() === PARTY_USER) return true;
  return matchesAnyName(value, studentNames);
}

export function isUnknownTarget(value: string | undefined): boolean {
  if (!value) return false;
  return value.trim().toUpperCase() === PARTY_UNKNOWN;
}
