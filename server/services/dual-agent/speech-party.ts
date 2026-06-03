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

/** Identifies the AI itself. The AI may also be referred to by its
 *  configured name; pass that name in when available. */
export function isDeviceTarget(value: string | undefined, aiName?: string): boolean {
  if (!value) return false;
  const v = value.trim().toUpperCase();
  if (v === PARTY_DEVICE) return true;
  if (aiName && value.trim().toLowerCase() === aiName.trim().toLowerCase()) return true;
  return false;
}

/** Identifies the active user. Accepts the literal "USER" token OR the
 *  student's actual name (case-insensitive match). */
export function isUserTarget(value: string | undefined, studentName?: string): boolean {
  if (!value) return false;
  const v = value.trim().toUpperCase();
  if (v === PARTY_USER) return true;
  if (studentName && value.trim().toLowerCase() === studentName.trim().toLowerCase()) return true;
  return false;
}

export function isUnknownTarget(value: string | undefined): boolean {
  if (!value) return false;
  return value.trim().toUpperCase() === PARTY_UNKNOWN;
}
