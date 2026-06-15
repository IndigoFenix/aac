// shared/interlocutor-register.ts
//
// "Register" of the person the user is currently talking to — peer vs helper —
// a GENERAL signal (not social-trainer-specific) that shapes the AAC board:
//
//   - helper  → a caretaker / parent / teacher / therapist. Needs & requests
//               are first-class ("I want…", "help", "all done"), plus politeness.
//   - peer    → a friend / another kid. A back-and-forth conversation, NOT a
//               request desk: reactions, ask-backs, sharing, greetings.
//   - unknown → no signal yet; the board offers a balanced mix.
//
// Sources (see the BoardManager <conversation_register> block + coordinator):
//   - KNOWN contacts: classified deterministically from their relationship /
//     team-member role / student-link via `classifyContactRegister`.
//   - UNKNOWN people: inferred live by the Observer from the camera.
//   - The social-trainer peer: registered as `peer` (the same legitimate
//     "a peer is present" signal a real peer contact carries — NOT the bot's
//     internal state).

export type InterlocutorRegister = "peer" | "helper" | "unknown";

/** Relationship keywords that mark a caretaker / professional (needs-oriented). */
const HELPER_TERMS = [
  "parent", "mom", "mum", "mother", "dad", "father", "grandma", "grandpa",
  "grandmother", "grandfather", "guardian", "nurse", "doctor", "therapist",
  "slp", "speech", "ot", "pt", "teacher", "aide", "assistant", "carer",
  "caregiver", "caretaker", "helper", "staff", "counselor", "counsellor",
  "babysitter", "nanny", "support worker", "tutor",
];

/** Relationship keywords that mark a conversational peer (back-and-forth). */
const PEER_TERMS = [
  "friend", "buddy", "classmate", "schoolmate", "peer", "pal", "mate",
  "brother", "sister", "sibling", "twin", "cousin",
];

/** Whole-word match (not substring) so short abbreviations like "ot"/"pt"/"slp"
 *  don't fire inside unrelated words (e.g. "br[ot]her"). Terms are plain
 *  words/spaces, safe to embed in the regex. */
function matchesAny(text: string, terms: string[]): boolean {
  return terms.some((t) => new RegExp(`\\b${t}\\b`).test(text));
}

export interface ClassifiableContact {
  relationship?: string | null;
  /** Formal IEP/TALA team-member role (therapist/teacher/aide/…) — a strong
   *  helper signal when present. */
  role?: string | null;
  customRole?: string | null;
  /** When the contact links to ANOTHER student, they're a peer by definition. */
  linkedStudentId?: string | null;
}

/** Deterministically classify a known contact's register from its metadata.
 *  Order: student-link (peer) → formal team role (helper) → relationship text. */
export function classifyContactRegister(c: ClassifiableContact): InterlocutorRegister {
  // Another student is unambiguously a peer.
  if (c.linkedStudentId) return "peer";
  // Formal IEP/TALA team members are professionals → helpers.
  if (c.role && c.role.trim().length > 0) return "helper";

  const text = `${c.relationship ?? ""} ${c.customRole ?? ""}`.toLowerCase();
  if (!text.trim()) return "unknown";
  // Peer terms win ties (a "big brother who helps" still reads peer-ish for
  // conversation practice); check peer first only when there's no helper term.
  const isHelper = matchesAny(text, HELPER_TERMS);
  const isPeer = matchesAny(text, PEER_TERMS);
  if (isPeer && !isHelper) return "peer";
  if (isHelper && !isPeer) return "helper";
  if (isPeer && isHelper) return "helper"; // mixed (e.g. "older sister, helps out") → needs-safe default
  return "unknown";
}
