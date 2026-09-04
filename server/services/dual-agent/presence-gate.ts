// server/services/dual-agent/presence-gate.ts
//
// The DECISIONS the presence ledger drives, as pure functions over plain data.
//
// Background: planning-docs/aac-presence-ledger.md. `shared/aac/presence-ledger.ts`
// owns the status algebra and the one formatter; this module owns the places the
// coordinator has to ASK it something — what `[PEOPLE PRESENT]` should read,
// whether an Observer context update may keep the name it guessed, whether a
// transcript's speaker label survives, and which names the Observer is allowed
// to pick from in the first place.
//
// They live here rather than inline in agent-coordinator.ts for one reason: the
// coordinator cannot be instantiated in a unit test without a websocket, a
// session cache and three live agents, so any decision written inline is a
// decision nobody can pin. Every function below takes plain data and returns
// plain data, so `server/tests/presence-gate.test.ts` can hold the exact strings
// the child's device will show.
//
// Nothing here reads the clock, the DB, or `this`.

import {
  isStatusAtLeast,
  renderPerson,
  entityKey,
  PRESENCE_LEDGER_DEFAULTS,
  type PresenceEntry,
  type PresenceEntityType,
  type PresenceStatus,
} from "@shared/aac/presence-ledger";
import { PARTY_NEARBY } from "./speech-party";
import type { VerbalAbility } from "@shared/aac/verbal-ability";

// ============================================================================
// [PEOPLE PRESENT]
// ============================================================================

/** One face from the current batch — the per-batch snapshot that supplies the
 *  score and the on-file description the ledger itself does not carry. */
export interface PresentFace {
  matched: boolean;
  /** Display name, or "Unknown #N" for an unmatched face. */
  name: string;
  entityType?: PresenceEntityType;
  entityId?: string;
  relationship?: string;
  confidence: number;
  description?: string;
  cameraRole?: "user" | "environment" | "unknown";
  /** The doppelgänger the matcher could not separate this face from, if any. */
  ambiguousWith?: string;
}

export interface PeoplePresentInput {
  now: number;
  /** `ledger.current(now)` — the entries that still count as being in the room. */
  entries: PresenceEntry[];
  /** This batch's face snapshot. */
  faces: PresentFace[];
  /** RAW pre-cap face count per camera role, straight from the client. The
   *  number of people we list can never exceed this, so it is printed. */
  facesInFrame?: Record<string, number>;
  student?: { entityId: string; name: string };
  /** Entity keys the roster says are lookalikes of the student. */
  studentLookalikeKeys?: string[];
  presenceTtlMs?: number;
}

const CAMERA_LABELS: Array<[string, string]> = [
  ["user", "user camera"],
  ["environment", "environment camera"],
];

function faceCount(input: PeoplePresentInput): number {
  const counts = input.facesInFrame;
  if (counts) {
    let total = 0;
    for (const v of Object.values(counts)) if (Number.isFinite(v)) total += v;
    // A count that is smaller than what we actually matched is a stale/partial
    // report; never print fewer faces than we are about to list.
    if (total >= input.faces.length && total > 0) return total;
  }
  return input.faces.length;
}

function cameraClause(input: PeoplePresentInput): string {
  const seen = new Set<string>();
  for (const key of Object.keys(input.facesInFrame ?? {})) {
    if ((input.facesInFrame?.[key] ?? 0) > 0) seen.add(key);
  }
  for (const f of input.faces) if (f.cameraRole) seen.add(f.cameraRole);
  const labels = CAMERA_LABELS.filter(([role]) => seen.has(role)).map(([, label]) => label);
  return labels.length ? ` (${labels.join(", ")})` : "";
}

export function peoplePresentHeader(input: PeoplePresentInput): string {
  const n = faceCount(input);
  return `[PEOPLE PRESENT] ${n} face${n === 1 ? "" : "s"} visible${cameraClause(input)}`;
}

/**
 * The one-face lookalike case, which is the whole reason this rewrite exists.
 *
 * Today's block renders the camera suffix "— in front of student" on the
 * matched sibling AND appends "DEFAULT to treating the person at the device as
 * the student", so a single face in a single chair arrives at the Observer as
 * two people: the sister in front of the student. Rendered as one sentence it
 * is unambiguous — one person, best guess named, treated as the student.
 */
function lookalikeOnePersonLine(input: PeoplePresentInput): string | null {
  if (input.faces.length !== 1) return null;
  const f = input.faces[0];
  if (!f.matched || !f.entityId || !f.entityType) return null;
  if (f.cameraRole === "environment") return null;
  const student = input.student;
  if (!student) return null;

  const studentKey = entityKey("student", student.entityId);
  const faceKey = entityKey(f.entityType, f.entityId);
  const lookalikes = new Set(input.studentLookalikeKeys ?? []);
  const entryLookalikes = new Set(
    input.entries.find((e) => entityKey(e.entityType, e.entityId) === faceKey)?.lookalikeOf ?? [],
  );

  let partner: string | null = null;
  if (faceKey === studentKey) {
    // The student won this frame, but a relative is close enough that the next
    // frame may well flip. Name the pair rather than let the flip look like an
    // arrival.
    partner = f.ambiguousWith ?? null;
    if (!partner) return null;
  } else {
    if (!lookalikes.has(faceKey) && !entryLookalikes.has(studentKey)) return null;
    partner = student.name;
  }

  const pct = `${Math.round((f.confidence <= 1 ? f.confidence * 100 : f.confidence))}%`;
  const best = f.relationship ? `${f.name} (${f.relationship})` : f.name;
  const bestTag = faceKey === studentKey ? " [THE STUDENT]" : "";
  const partnerTag = faceKey === studentKey ? "" : " [THE STUDENT]";
  return (
    `- the person at the device — best match ${best}${bestTag} ${pct}, ` +
    `but this is a lookalike pair with ${partner}${partnerTag}; treat as the student unless verified.`
  );
}

/**
 * `[PEOPLE PRESENT]`, rendered from the LEDGER rather than from the raw batch.
 *
 * Every named line goes through `renderPerson(entry, "observer")`, so a
 * hypothesis arrives as "someone — possibly X (unverified; verify by: …)" and
 * cannot be read as a person who is here. Unmatched faces keep today's wording:
 * an unknown face is a real observation and needs no grading.
 */
export function renderPeoplePresent(input: PeoplePresentInput): string {
  const header = peoplePresentHeader(input);
  const ttl = input.presenceTtlMs ?? PRESENCE_LEDGER_DEFAULTS.presenceTtlMs;

  const solo = lookalikeOnePersonLine(input);
  if (solo) return `${header}\n${solo}`;

  const faceFor = (e: PresenceEntry): PresentFace | undefined =>
    input.faces.find((f) => f.matched && f.entityType === e.entityType && f.entityId === e.entityId);

  const lines: string[] = [];
  for (const entry of input.entries) {
    const f = faceFor(entry);
    const isStudent = entry.entityType === "student";
    const rendered = renderPerson(entry, "observer", {
      now: input.now,
      presenceTtlMs: ttl,
      ...(f && Number.isFinite(f.confidence) ? { confidence: f.confidence } : {}),
      ...(f?.description ? { description: f.description } : {}),
    });
    lines.push(`- ${rendered}${isStudent ? " [THE STUDENT]" : ""}`);
  }
  for (const f of input.faces) {
    if (f.matched) continue;
    lines.push(`- ${f.name} (no database match)`);
  }
  if (!lines.length) return "";

  // The identity default, unchanged in substance: nobody is confidently
  // somebody else, so the person at the device is the student.
  const sawStudent = input.faces.some((f) => f.matched && f.entityType === "student");
  const confidentOther = input.entries.some(
    (e) => e.entityType !== "student" && isStatusAtLeast(e.status, "corroborated"),
  );
  let note = "";
  if (!sawStudent) {
    note = confidentOther
      ? `\n(NOTE: a non-student known person is identified above and the student is not among the faces — the active user is that person, not the student.)`
      : `\n(NOTE: no face is confidently identified. DEFAULT to treating the person at the device as the student unless you have clear evidence otherwise — do not call set_person_as_user for a non-student on weak grounds.)`;
  }
  return `${header}\n${lines.join("\n")}${note}`;
}

// ============================================================================
// Context-update demotion (Observer → every renderer)
// ============================================================================

/** Update types whose `key` is a claim about WHO someone is, and therefore a
 *  claim the ledger gets to grade. `misidentified` is deliberately absent — a
 *  retraction must keep its name or nothing downstream knows who was struck. */
export const PERSON_KEYED_UPDATES: ReadonlySet<string> = new Set([
  "new_person",
  "person_identified",
  "set_person_as_user",
  "voice_identified",
  "person_gesture",
  "person_indicates_object",
  "other",
]);

export interface ContextDemotionInput {
  enabled: boolean;
  updateType: string;
  key: string;
  /** The roster person `key` resolved to, or null when it named nobody on file
   *  ("a woman", "the therapist") — a generic key is not a name to launder. */
  resolved: { entityType: PresenceEntityType; entityId: string } | null;
  status: PresenceStatus | "absent";
}

export type ContextDemotion =
  | { demote: false }
  | { demote: true; key: string; guessedName: string; presenceStatus: PresenceStatus | "absent" };

/**
 * Should this context update lose the name it carries?
 *
 * Yes when the key resolves to a real roster person the ledger has not got to
 * `corroborated`. The student is exempt by construction (they are `assumed`),
 * and a key that resolves to nobody is left completely alone: "a woman came in"
 * is an observation, not an identification.
 */
export function decideContextDemotion(input: ContextDemotionInput): ContextDemotion {
  if (!input.enabled) return { demote: false };
  if (!PERSON_KEYED_UPDATES.has(input.updateType)) return { demote: false };
  const resolved = input.resolved;
  if (!resolved) return { demote: false };
  if (resolved.entityType === "student") return { demote: false };
  if (isStatusAtLeast(input.status, "corroborated")) return { demote: false };
  return {
    demote: true,
    key: PARTY_NEARBY,
    guessedName: input.key,
    presenceStatus: input.status,
  };
}

// ============================================================================
// Attribution candidate gate (transcripts)
// ============================================================================

export interface SpeakerPartyInput {
  /** The label the Observer wrote. */
  label?: string;
  resolved: { entityType: PresenceEntityType; entityId: string } | null;
  status: PresenceStatus | "absent";
  /** A fresh enrolled-voice match for THIS person, within the voice TTL. The
   *  parent-calling-from-the-next-room case the sibling doc protects. */
  hasFreshVoice: boolean;
}

export interface SpeakerDemotionInput {
  enabled: boolean;
  speaker: SpeakerPartyInput;
  target: SpeakerPartyInput;
}

export interface SpeakerDemotionDecision {
  demoteSpeaker: boolean;
  demoteTarget: boolean;
  guessedSpeaker?: string;
  guessedTarget?: string;
  party: string;
}

function partyLosesItsName(p: SpeakerPartyInput): boolean {
  if (!p.resolved) return false;
  if (p.resolved.entityType === "student") return false;
  if (p.hasFreshVoice) return false;
  return !isStatusAtLeast(p.status, "corroborated");
}

/**
 * A speaker label is ROUTING, never evidence — so it may be stripped without
 * anything downstream breaking. `routeTranscribedInner` builds reply buttons
 * off `targetIsUser`, not off who spoke, and USER-targeted speech reaches the
 * Speaker as context whether it is named or UNKNOWN. Nothing is lost here
 * except the name.
 */
export function decideSpeakerDemotion(input: SpeakerDemotionInput): SpeakerDemotionDecision {
  const out: SpeakerDemotionDecision = { demoteSpeaker: false, demoteTarget: false, party: PARTY_NEARBY };
  if (!input.enabled) return out;
  if (partyLosesItsName(input.speaker)) {
    out.demoteSpeaker = true;
    out.guessedSpeaker = input.speaker.label;
  }
  if (partyLosesItsName(input.target)) {
    out.demoteTarget = true;
    out.guessedTarget = input.target.label;
  }
  return out;
}

// ============================================================================
// Speaker candidate list (appended to every [HEARD SPEECH] turn)
// ============================================================================

export interface SpeakerCandidatesInput {
  studentName: string;
  verbalAbility?: VerbalAbility | null;
  /** Non-student candidates: ledger status ≥ corroborated, or a fresh
   *  enrolled-voice match. Order is the caller's. */
  named: Array<{ name: string; relationship?: string }>;
  deviceLabel?: string;
}

/**
 * The list the Observer is allowed to pick a speaker from.
 *
 * The prompt used to point at "[PEOPLE PRESENT] in general" and add that
 * UNKNOWN costs more than a wrong guess — so the model guessed. An explicit,
 * per-turn, code-built list removes the judgement call: everyone else is
 * "someone nearby", and the device builds the reply buttons either way.
 */
export function speakerCandidatesLine(input: SpeakerCandidatesInput): string {
  const ability = input.verbalAbility;
  const canSpeak = ability === "none" || ability === "vocalizations" ? "cannot speak" : "may speak";
  const parts = [`${input.studentName} (the student; ${canSpeak})`, input.deviceLabel ?? "DEVICE"];
  const seen = new Set<string>();
  for (const p of input.named) {
    const name = (p.name ?? "").trim();
    if (!name) continue;
    const k = name.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    parts.push(p.relationship ? `${name} (${p.relationship} — verified)` : `${name} (verified)`);
  }
  parts.push(PARTY_NEARBY);
  return `Speaker candidates this session: ${parts.join(", ")}`;
}

// ============================================================================
// Self-declaration detection (audit only, weight 0)
// ============================================================================

/** Introducers after which a following name is a CLAIM about the speaker's own
 *  identity. Hebrew has no copula, so "אני X" / "זו X" / "זה X" are the whole
 *  pattern; English needs the verb. */
const SELF_DECLARATION_LEADS = ["אני", "זו", "זאת", "זה", "i'm", "i am", "this is"];

/**
 * "את יודעת, אני אופק" is a sentence containing a name. It is not evidence that
 * its speaker is that person — which is exactly why this returns an audit-only
 * finding and never a promotion. Returns the roster names declared, in order.
 */
export function detectSelfDeclaredNames(text: string, rosterNames: string[]): string[] {
  if (!text) return [];
  const hay = text.toLowerCase();
  const out: string[] = [];
  for (const raw of rosterNames) {
    const name = (raw ?? "").trim();
    if (name.length < 2) continue;
    const needle = name.toLowerCase();
    let idx = hay.indexOf(needle);
    while (idx !== -1) {
      const before = hay.slice(Math.max(0, idx - 24), idx);
      if (SELF_DECLARATION_LEADS.some((lead) => new RegExp(`${escapeRe(lead)}\\s*$`).test(before))) {
        out.push(name);
        break;
      }
      idx = hay.indexOf(needle, idx + 1);
    }
  }
  return out;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
