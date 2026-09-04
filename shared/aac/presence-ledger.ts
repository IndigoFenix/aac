// shared/aac/presence-ledger.ts
//
// Session-scoped provenance record for WHO IS IN THE ROOM, and the single
// formatter every consumer must pass a person's name through.
//
// Background (planning-docs/aac-presence-ledger.md): on 2026-09-03 the AAC
// reported a student's sister present, greeted her aloud, and wrote "a person
// named X joined" into the permanent session summary. Nobody but the student
// was there. The face matcher is measurably weak on family faces (min distance
// student↔sister 0.4527, well inside the 0.6 match threshold), so it WILL keep
// nominating the sister several times per session. Prompt hedges cannot hold:
// a hedge addressed to one model never survives that model's output — the
// Observer overrode it in so many words ("certain identification despite the
// low confidence percentage"), and the Speaker only ever saw the laundered
// name.
//
// So presence is a typed claim owned by code, not by any agent:
//   * agents contribute EVIDENCE; only this module derives a STATUS;
//   * promotion needs INDEPENDENT evidence — the Observer's confirmation does
//     not count as a second channel against a weak face line, because the
//     Observer was shown that line;
//   * a speaker label is routing, never evidence (weight 0, audit only);
//   * the grade travels with the name: `renderPerson` runs on the LLM's
//     OUTPUT, which is the one step an LLM cannot launder.
//
// Pure logic, mirroring shared/aac/verbal-ability.ts: no I/O, no server
// imports, unit-testable, importable by the client debug panel.

// ============================================================================
// Types
// ============================================================================

export type PresenceStatus =
  | "assumed" // the student: default occupant of the device, never downgraded
  | "hypothesized" // one weak signal; the Observer may verify it, nobody else may use it
  | "corroborated" // two independent channels agree, or one strong channel sustained
  | "confirmed" // a human said so, or strong biometrics + Observer over a sustained track
  | "retracted"; // explicitly struck this session; blocks re-promotion

export type PresenceEntityType = "student" | "user" | "contact";

export type EvidenceChannel =
  | "face_match" // per batch: distance, runner-up gap, trackId, cameraRole
  | "voice_match" // per batch: similarity, sampleCount
  | "observer_visual" // person_identified / new_person(name) / set_person_as_user
  | "observer_retraction" // misidentified
  | "human_confirm" // facilitator/clinician UI; client correct_identity ("not them") = against
  | "speech_attribution" // transcript speaker field — AUDIT ONLY, weight 0
  | "self_declaration"; // "I'm X" heard in a transcript — AUDIT ONLY, weight 0

export type EvidenceStrength = "weak" | "strong";

export interface EvidenceEntry {
  channel: EvidenceChannel;
  at: number;
  polarity: "for" | "against";
  strength: EvidenceStrength;
  trackId?: string;
  detail?: Record<string, number | string | boolean>;
}

export interface PresenceEntry {
  entityType: PresenceEntityType;
  entityId: string;
  name: string;
  relationship?: string;
  status: PresenceStatus;
  /** When the current status was reached. */
  since: number;
  /** Time of the last "for" evidence of any channel (audit included). */
  lastSupport: number;
  /** Entity keys of roster members whose galleries sit within `lookalikeDistance`. */
  lookalikeOf: string[];
  /** Bounded ring, newest last. */
  evidence: EvidenceEntry[];
  /**
   * True when the ONLY support is audit-only channels (speech_attribution /
   * self_declaration). Such an entry exists for the record — the Monitor must
   * still be told the name was mentioned — but `statusOf` reports "absent" and
   * it can never leave `lists().unverified`. `status` is kept at the safe
   * floor ("hypothesized") so a consumer reading the field directly can never
   * mistake it for presence.
   */
  auditOnly?: boolean;
  /**
   * Support has aged out: the person is no longer CURRENT (they drop out of
   * `[PEOPLE PRESENT]`), but the session still remembers them — a name
   * mentioned at minute 3 must still reach the Monitor's "mentioned or
   * guessed, NOT verified present" list at minute 40. Set by `tick`, cleared
   * by the next "for" evidence. Thresholds: `hypothesisTtlMs` for a
   * hypothesis or an audit-only mention, `presenceTtlMs` for a verified
   * person. The student is never stale.
   */
  stale?: boolean;
}

export interface RosterPerson {
  entityType: PresenceEntityType;
  entityId: string;
  name: string;
  relationship?: string;
  /** Stored face descriptors; used ONLY to precompute lookalike pairs. */
  faceSamples?: number[][];
}

export interface PresenceLedgerOptions {
  /** A hypothesis with no fresh support goes stale after this. */
  hypothesisTtlMs: number;
  /** After this without support, a verified person goes stale and renders as
   *  "was here earlier". */
  presenceTtlMs: number;
  /** A retraction blocks re-entry for this long; afterwards only a strong signal re-enters. */
  retractionHoldMs: number;
  /** Two different channels must land within this window to corroborate. */
  corroborationWindowMs: number;
  /** Consecutive strong face batches on ONE track that count as sustained. */
  sustainedBatches: number;
  /** Gallery distance under which two roster members are a lookalike pair. */
  lookalikeDistance: number;
  /** Evidence ring size per entity. */
  evidenceRing: number;
}

export const PRESENCE_LEDGER_DEFAULTS: PresenceLedgerOptions = {
  hypothesisTtlMs: 120_000,
  presenceTtlMs: 300_000,
  retractionHoldMs: 600_000,
  corroborationWindowMs: 90_000,
  sustainedBatches: 3,
  // 0.50: measured min distances from one student's stored faces to relatives
  // were sister 0.4527, brother 0.5508 — the sister pair must be locked.
  lookalikeDistance: 0.5,
  evidenceRing: 40,
};

export function entityKey(t: PresenceEntityType, id: string): string {
  return `${t}:${id}`;
}

export interface PresenceListItem {
  entityType: PresenceEntityType;
  entityId: string;
  name: string;
  relationship?: string;
  status: PresenceStatus;
  reason: string;
}

export interface PresenceLists {
  verified: PresenceListItem[];
  unverified: PresenceListItem[];
  retracted: PresenceListItem[];
}

export interface PresenceLedgerSnapshot {
  version: 1;
  createdAt: number;
  entries: Array<PresenceEntry & { timeline: Array<{ at: number; status: PresenceStatus }> }>;
}

// ============================================================================
// Status algebra
// ============================================================================

/** Audit-only channels: recorded for forensics, weight 0 for derivation.
 *  A sentence containing a name is not evidence that its speaker is that
 *  person, and a speaker label is a routing decision, not an observation. */
const AUDIT_CHANNELS: ReadonlySet<EvidenceChannel> = new Set<EvidenceChannel>([
  "speech_attribution",
  "self_declaration",
]);

/** Channels whose "against" polarity retracts an entry. */
const RETRACTING_CHANNELS: ReadonlySet<EvidenceChannel> = new Set<EvidenceChannel>([
  "observer_retraction",
  "human_confirm",
]);

const RANKS: Record<PresenceStatus | "absent", number> = {
  absent: 0,
  retracted: 0,
  hypothesized: 1,
  corroborated: 2,
  confirmed: 3,
  assumed: 3,
};

export function statusRank(s: PresenceStatus | "absent"): number {
  return RANKS[s] ?? 0;
}

export function isStatusAtLeast(s: PresenceStatus | "absent", min: PresenceStatus): boolean {
  return statusRank(s) >= statusRank(min);
}

/**
 * Face strength, computed by the feeder — never by an LLM.
 *
 * Deliberately NOT "confidence ≥ 0.6": on the incident device no batch in 553
 * ever reached it. A close distance with a clear runner-up gap, or a match the
 * matcher itself did not flag borderline, is the realistic strong signal — and
 * an attribute veto or an ambiguous runner-up kills it outright.
 */
export function faceEvidenceStrength(m: {
  distance: number;
  runnerUpDistance?: number;
  borderline: boolean;
  ambiguousWith?: string;
  vetoPassed?: boolean;
}): EvidenceStrength {
  if (m.vetoPassed === false) return "weak";
  if (m.ambiguousWith) return "weak";
  const gap = (m.runnerUpDistance ?? Infinity) - m.distance;
  if (!m.borderline) return "strong";
  if (m.distance <= 0.42 && gap >= 0.1) return "strong";
  return "weak";
}

// ============================================================================
// The ledger
// ============================================================================

function euclidean(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return Infinity;
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  return Math.sqrt(sum);
}

function minGalleryDistance(a: number[][], b: number[][]): number {
  let best = Infinity;
  for (const x of a) for (const y of b) best = Math.min(best, euclidean(x, y));
  return best;
}

export class PresenceLedger {
  private readonly opts: PresenceLedgerOptions;
  private readonly map = new Map<string, PresenceEntry>();
  private readonly roster = new Map<string, RosterPerson>();
  private readonly lookalikes = new Map<string, string[]>();
  private readonly timelines = new Map<string, Array<{ at: number; status: PresenceStatus }>>();
  private studentKey: string | undefined;

  constructor(opts?: Partial<PresenceLedgerOptions>) {
    this.opts = { ...PRESENCE_LEDGER_DEFAULTS, ...(opts ?? {}) };
  }

  /** Roster load: names + galleries. Computes the lookalike pairs (min pairwise
   *  euclidean under `lookalikeDistance`). Does NOT create presence entries —
   *  being on the roster is not evidence of being in the room. */
  setRoster(people: RosterPerson[]): void {
    this.roster.clear();
    for (const p of people) this.roster.set(entityKey(p.entityType, p.entityId), { ...p });
    this.recomputeLookalikes();
  }

  private recomputeLookalikes(): void {
    this.lookalikes.clear();
    const people = Array.from(this.roster.values());
    for (let i = 0; i < people.length; i++) {
      for (let j = i + 1; j < people.length; j++) {
        const a = people[i];
        const b = people[j];
        if (!a.faceSamples?.length || !b.faceSamples?.length) continue;
        if (minGalleryDistance(a.faceSamples, b.faceSamples) >= this.opts.lookalikeDistance) continue;
        const ka = entityKey(a.entityType, a.entityId);
        const kb = entityKey(b.entityType, b.entityId);
        this.pushLookalike(ka, kb);
        this.pushLookalike(kb, ka);
      }
    }
    // Existing entries inherit the recomputed sets.
    for (const [key, entry] of this.map) entry.lookalikeOf = [...(this.lookalikes.get(key) ?? [])];
  }

  private pushLookalike(key: string, other: string): void {
    const list = this.lookalikes.get(key) ?? [];
    if (!list.includes(other)) list.push(other);
    this.lookalikes.set(key, list);
  }

  /** The device's default occupant. Always "assumed"; never downgraded, not
   *  even by a lookalike lock — the student is who the device belongs to. */
  setStudent(entityId: string): void {
    const key = entityKey("student", entityId);
    this.studentKey = key;
    const now = Date.now();
    let entry = this.map.get(key);
    if (!entry) {
      const rp = this.roster.get(key);
      entry = {
        entityType: "student",
        entityId,
        name: rp?.name ?? entityId,
        relationship: rp?.relationship,
        status: "assumed",
        since: now,
        lastSupport: now,
        lookalikeOf: [...(this.lookalikes.get(key) ?? [])],
        evidence: [],
      };
      this.map.set(key, entry);
      this.timelines.set(key, [{ at: now, status: "assumed" }]);
    } else if (entry.status !== "assumed") {
      entry.status = "assumed";
      entry.since = now;
      this.pushTimeline(key, now, "assumed");
    }
    entry.auditOnly = false;
  }

  addEvidence(
    person: RosterPerson | { entityType: PresenceEntityType; entityId: string; name: string; relationship?: string },
    ev: Omit<EvidenceEntry, "at"> & { at?: number },
  ): PresenceEntry {
    const key = entityKey(person.entityType, person.entityId);
    const at = ev.at ?? Date.now();

    const samples = (person as RosterPerson).faceSamples;
    if (samples?.length && !this.roster.has(key)) {
      this.roster.set(key, { ...(person as RosterPerson) });
      this.recomputeLookalikes();
    }

    let entry = this.map.get(key);
    if (!entry) {
      entry = {
        entityType: person.entityType,
        entityId: person.entityId,
        name: person.name,
        relationship: person.relationship ?? this.roster.get(key)?.relationship,
        status: "hypothesized",
        since: at,
        lastSupport: at,
        lookalikeOf: [...(this.lookalikes.get(key) ?? [])],
        evidence: [],
      };
      this.map.set(key, entry);
      this.timelines.set(key, []);
    } else {
      if (person.name) entry.name = person.name;
      if (person.relationship) entry.relationship = person.relationship;
    }

    const record: EvidenceEntry = {
      channel: ev.channel,
      at,
      polarity: ev.polarity,
      strength: ev.strength,
      ...(ev.trackId !== undefined ? { trackId: ev.trackId } : {}),
      ...(ev.detail !== undefined ? { detail: ev.detail } : {}),
    };
    entry.evidence.push(record);
    if (entry.evidence.length > this.opts.evidenceRing) {
      entry.evidence.splice(0, entry.evidence.length - this.opts.evidenceRing);
    }
    if (ev.polarity === "for") {
      entry.lastSupport = at;
      entry.stale = false;
    }

    this.updateStatus(key, entry, at);
    return entry;
  }

  /**
   * Decay pass. Nothing is ever REMOVED: an entity mentioned this session must
   * still be reportable at session end as "mentioned or guessed, NOT verified
   * present" — deleting the hypothesis would quietly delete the warning with
   * it. Instead the entry is marked `stale`, which drops it out of `current()`
   * (what `[PEOPLE PRESENT]` renders) while `entries()` and `lists()` keep it.
   *
   * Status is never lowered by decay either: corroborated/confirmed entries
   * hold their grade for the session — only their WORDING ages (renderPerson
   * says "was here earlier").
   */
  tick(now: number = Date.now()): void {
    for (const [key, entry] of this.map) {
      if (key === this.studentKey) continue;
      this.updateStatus(key, entry, now);
      entry.stale = this.isStaleAt(key, entry, now);
    }
  }

  /** Entries still counting as present right now: not stale, not retracted.
   *  This is the list `[PEOPLE PRESENT]` renders. A pure query — it computes
   *  staleness at `now` rather than trusting the last `tick`. */
  current(now: number = Date.now()): PresenceEntry[] {
    const out: PresenceEntry[] = [];
    for (const [key, entry] of this.map) {
      if (entry.status === "retracted") continue;
      if (this.isStaleAt(key, entry, now)) continue;
      out.push(entry);
    }
    return out;
  }

  isCurrent(entityType: PresenceEntityType, entityId: string, now: number = Date.now()): boolean {
    const key = entityKey(entityType, entityId);
    const entry = this.map.get(key);
    if (!entry || entry.status === "retracted") return false;
    return !this.isStaleAt(key, entry, now);
  }

  get(entityType: PresenceEntityType, entityId: string): PresenceEntry | undefined {
    return this.map.get(entityKey(entityType, entityId));
  }

  statusOf(entityType: PresenceEntityType, entityId: string): PresenceStatus | "absent" {
    const entry = this.map.get(entityKey(entityType, entityId));
    if (!entry) return "absent";
    if (entry.auditOnly) return "absent";
    return entry.status;
  }

  isAtLeast(entityType: PresenceEntityType, entityId: string, min: PresenceStatus): boolean {
    return isStatusAtLeast(this.statusOf(entityType, entityId), min);
  }

  entries(): PresenceEntry[] {
    return Array.from(this.map.values());
  }

  lists(now: number = Date.now()): PresenceLists {
    const out: PresenceLists = { verified: [], unverified: [], retracted: [] };
    for (const entry of this.map.values()) {
      const item: PresenceListItem = {
        entityType: entry.entityType,
        entityId: entry.entityId,
        name: entry.name,
        ...(entry.relationship ? { relationship: entry.relationship } : {}),
        status: entry.status,
        reason: this.reasonFor(entry, now),
      };
      if (entry.status === "retracted") out.retracted.push(item);
      else if (entry.auditOnly || entry.status === "hypothesized") out.unverified.push(item);
      else out.verified.push(item);
    }
    return out;
  }

  snapshot(): PresenceLedgerSnapshot {
    return {
      version: 1,
      createdAt: Date.now(),
      entries: Array.from(this.map.entries()).map(([key, e]) => ({
        ...e,
        lookalikeOf: [...e.lookalikeOf],
        evidence: e.evidence.slice(-this.opts.evidenceRing).map((x) => ({ ...x })),
        timeline: (this.timelines.get(key) ?? []).map((x) => ({ ...x })),
      })),
    };
  }

  static fromSnapshot(s: PresenceLedgerSnapshot, opts?: Partial<PresenceLedgerOptions>): PresenceLedger {
    const ledger = new PresenceLedger(opts);
    for (const raw of s.entries ?? []) {
      const { timeline, ...rest } = raw;
      const key = entityKey(rest.entityType, rest.entityId);
      ledger.map.set(key, {
        ...rest,
        lookalikeOf: [...(rest.lookalikeOf ?? [])],
        evidence: (rest.evidence ?? []).map((x) => ({ ...x })),
      });
      ledger.timelines.set(key, (timeline ?? []).map((x) => ({ ...x })));
      if (rest.entityType === "student" && rest.status === "assumed") ledger.studentKey = key;
      for (const other of rest.lookalikeOf ?? []) ledger.pushLookalike(key, other);
    }
    return ledger;
  }

  // -- internals ------------------------------------------------------------

  /** A hypothesis (or a bare mention) ages out fast; a verified person keeps
   *  standing for `presenceTtlMs`. The student never ages out — the device is
   *  hers. Retracted entries are not aged: they are excluded outright. */
  private isStaleAt(key: string, entry: PresenceEntry, now: number): boolean {
    if (key === this.studentKey || entry.status === "assumed") return false;
    if (entry.status === "retracted") return false;
    const soft = entry.auditOnly || entry.status === "hypothesized";
    const ttl = soft ? this.opts.hypothesisTtlMs : this.opts.presenceTtlMs;
    return now - entry.lastSupport > ttl;
  }

  private pushTimeline(key: string, at: number, status: PresenceStatus): void {
    const line = this.timelines.get(key) ?? [];
    line.push({ at, status });
    this.timelines.set(key, line);
  }

  private updateStatus(key: string, entry: PresenceEntry, now: number): void {
    if (key === this.studentKey) {
      entry.auditOnly = false;
      if (entry.status !== "assumed") {
        entry.status = "assumed";
        entry.since = now;
        this.pushTimeline(key, now, "assumed");
      }
      return;
    }

    const derived = this.derive(entry, now);
    entry.auditOnly = derived === "absent";
    const target: PresenceStatus = derived === "absent" ? "hypothesized" : derived;

    let next: PresenceStatus;
    if (target === "retracted") {
      next = "retracted";
    } else {
      // Monotonic within the session: a reached grade never falls back on its
      // own (only a retraction takes it away). `retracted` ranks 0, so a valid
      // re-entry rises out of it normally.
      next = statusRank(target) > statusRank(entry.status) ? target : entry.status;
    }
    if (next !== entry.status) {
      entry.status = next;
      entry.since = now;
      this.pushTimeline(key, now, next);
    }
  }

  private derive(entry: PresenceEntry, _now: number): PresenceStatus | "absent" {
    const all = entry.evidence;

    // --- retraction ---------------------------------------------------------
    let againstAt: number | undefined;
    for (const e of all) {
      if (e.polarity !== "against" || !RETRACTING_CHANNELS.has(e.channel)) continue;
      if (againstAt === undefined || e.at > againstAt) againstAt = e.at;
    }

    let usable = all.filter((e) => !AUDIT_CHANNELS.has(e.channel));
    if (againstAt !== undefined) {
      const reentered = usable.some(
        (e) =>
          e.polarity === "for" &&
          e.at > againstAt! &&
          e.strength === "strong" &&
          e.at >= againstAt! + this.opts.retractionHoldMs,
      );
      if (!reentered) return "retracted";
      // Re-entered: only evidence from after the retraction counts again.
      usable = usable.filter((e) => e.at > againstAt!);
    }

    const fors = usable.filter((e) => e.polarity === "for");
    if (fors.length === 0) return "absent";

    const locked = entry.lookalikeOf.length > 0;

    // --- confirmed ----------------------------------------------------------
    if (fors.some((e) => e.channel === "human_confirm")) return "confirmed";

    const run = this.sustainedFaceRun(fors);
    if (!locked && run !== undefined) {
      const observerAfter = fors.some((e) => e.channel === "observer_visual" && e.at >= run);
      if (observerAfter) return "confirmed";
      return "corroborated";
    }

    // --- corroborated -------------------------------------------------------
    const voiceStrong = fors.some((e) => e.channel === "voice_match" && e.strength === "strong");
    if (voiceStrong && fors.some((e) => e.channel === "face_match")) return "corroborated";
    if (this.hasIndependentPair(fors, locked)) return "corroborated";

    // --- hypothesized -------------------------------------------------------
    return "hypothesized";
  }

  /** `at` of the first entry of the earliest run of `sustainedBatches`
   *  consecutive STRONG face matches sharing one trackId, or undefined.
   *  A face entry with no trackId gets no sustained credit at all (§7: without
   *  the client tracker the server's per-camera approximation is too weak). */
  private sustainedFaceRun(fors: EvidenceEntry[]): number | undefined {
    const faces = fors.filter((e) => e.channel === "face_match").sort((a, b) => a.at - b.at);
    let run = 0;
    let startedAt = 0;
    let prevTrack: string | undefined;
    for (const e of faces) {
      if (e.strength === "strong" && e.trackId) {
        if (run > 0 && prevTrack === e.trackId) {
          run += 1;
        } else {
          run = 1;
          startedAt = e.at;
        }
        prevTrack = e.trackId;
      } else {
        run = 0;
        prevTrack = undefined;
      }
      if (run >= this.opts.sustainedBatches) return startedAt;
    }
    return undefined;
  }

  /**
   * Two DIFFERENT channels within the corroboration window.
   *
   * The independence rule, restated because it is the one people relax: the
   * Observer's confirmation does not count against a weak or ambiguous face
   * line, because the Observer was SHOWN that line. It counts against a strong
   * face line, against voice, and on its own only as a hypothesis.
   *
   * A lookalike-locked entity additionally needs the pair to contain a strong
   * voice match or a human confirmation — face and Observer, in any
   * combination, can never take it past `hypothesized`.
   */
  private hasIndependentPair(fors: EvidenceEntry[], locked: boolean): boolean {
    for (let i = 0; i < fors.length; i++) {
      for (let j = i + 1; j < fors.length; j++) {
        const a = fors[i];
        const b = fors[j];
        if (a.channel === b.channel) continue;
        if (Math.abs(a.at - b.at) > this.opts.corroborationWindowMs) continue;
        const pair = [a, b];
        const face = pair.find((e) => e.channel === "face_match");
        const observer = pair.find((e) => e.channel === "observer_visual");
        if (face && observer && face.strength === "weak") continue; // primed, not independent
        if (locked) {
          const unlocking = pair.some(
            (e) => (e.channel === "voice_match" && e.strength === "strong") || e.channel === "human_confirm",
          );
          if (!unlocking) continue;
        }
        return true;
      }
    }
    return false;
  }

  private nameOfKey(key: string): string {
    const entry = this.map.get(key);
    if (entry) return entry.name;
    const rp = this.roster.get(key);
    if (rp) return rp.name;
    return key;
  }

  /** Human-readable provenance for the §6.1 lists. Never a verdict — a reason. */
  private reasonFor(entry: PresenceEntry, _now: number): string {
    const fors = entry.evidence.filter((e) => e.polarity === "for");
    const count = (ch: EvidenceChannel) => fors.filter((e) => e.channel === ch).length;
    const speech = count("speech_attribution");
    const declared = count("self_declaration");
    const faces = count("face_match");
    const voices = count("voice_match");
    const seen = count("observer_visual");

    if (entry.status === "retracted") {
      const last = entry.evidence
        .filter((e) => e.polarity === "against" && RETRACTING_CHANNELS.has(e.channel))
        .slice(-1)[0];
      return last?.channel === "human_confirm"
        ? "retracted by a human correction"
        : "retracted by the Observer as a misidentification";
    }

    if (entry.auditOnly) {
      const bits: string[] = [];
      if (speech) bits.push(speech === 1 ? "speech label only" : `${speech} speech labels only`);
      if (declared) bits.push("self-declared only");
      return bits.join(", ") || "no supporting evidence";
    }

    if (entry.status === "assumed") return "the student — occupant of the device";
    if (entry.status === "confirmed") {
      return count("human_confirm")
        ? "confirmed by a human"
        : "sustained strong face match on one track, confirmed by the Observer";
    }
    if (entry.status === "corroborated") {
      const channels: string[] = [];
      if (faces) channels.push("face");
      if (voices) channels.push("voice");
      if (seen) channels.push("Observer sighting");
      return `corroborated by ${channels.join(" + ") || "two channels"}`;
    }

    const bits: string[] = [];
    if (entry.lookalikeOf.length) {
      bits.push(`face lookalike of ${entry.lookalikeOf.map((k) => this.nameOfKey(k)).join(", ")}`);
    } else if (faces) {
      bits.push(faces === 1 ? "1 unconfirmed face match" : `${faces} unconfirmed face matches`);
    }
    if (voices) bits.push(voices === 1 ? "1 unconfirmed voice match" : `${voices} unconfirmed voice matches`);
    if (seen) {
      if (!entry.lookalikeOf.length && !faces && !voices) bits.push("Observer guess, no biometric data");
      else bits.push("Observer sighting");
    }
    if (speech) bits.push(speech === 1 ? "1 speech label" : `${speech} speech labels`);
    if (declared) bits.push("self-declared");
    return bits.join(", ") || "unverified";
  }
}

// ============================================================================
// The boundary formatter
// ============================================================================

export type PersonAudience = "observer" | "speaker" | "board" | "log" | "monitor";

function effectiveStatus(entry: PresenceEntry): PresenceStatus {
  return entry.auditOnly ? "hypothesized" : entry.status;
}

function formatConfidence(c: number | undefined): string {
  if (c === undefined || !Number.isFinite(c)) return "";
  const pct = c <= 1 ? Math.round(c * 100) : Math.round(c);
  return `${pct}%`;
}

/**
 * The ONLY way a ledger entity's name reaches a prompt, a wire message, or a
 * durable record. It runs on the LLM's output, so it cannot be argued with.
 *
 * The Observer keeps the name (it is the verifier, and it needs the on-file
 * description to check against) plus an explicit recipe for what would promote
 * the guess. Everyone downstream gets "someone nearby" — no name to launder.
 */
export function renderPerson(
  entry: PresenceEntry,
  audience: PersonAudience,
  opts?: {
    now?: number;
    description?: string;
    confidence?: number;
    relationship?: string;
    /** Cutoff for "was here earlier"; defaults to PRESENCE_LEDGER_DEFAULTS.
     *  Only consulted when the entry carries no `stale` flag of its own. */
    presenceTtlMs?: number;
  },
): string {
  const status = effectiveStatus(entry);
  const rel = opts?.relationship ?? entry.relationship;
  const named = rel ? `${entry.name} (${rel})` : entry.name;
  const conf = formatConfidence(opts?.confidence);
  const withConf = conf ? `${named} ${conf}` : named;

  if (status === "retracted") {
    if (audience === "log") return `${entry.name} (retracted)`;
    if (audience === "monitor") return `${entry.name} — retracted`;
    return `(retracted: ${entry.name} — treat as not present)`;
  }

  if (status === "hypothesized") {
    switch (audience) {
      case "observer": {
        const parts = ["unverified"];
        if (opts?.description) parts.push(`on file: ${opts.description}`);
        parts.push(`verify by: ${verificationRecipe(entry)}`);
        return `someone — possibly ${withConf} (${parts.join("; ")})`;
      }
      case "speaker":
      case "board":
        return "someone nearby";
      case "log":
        return `someone (unverified guess: ${entry.name})`;
      case "monitor":
        return `${named} — NOT verified present`;
    }
  }

  // assumed / corroborated / confirmed
  const now = opts?.now ?? Date.now();
  const ttl = opts?.presenceTtlMs ?? PRESENCE_LEDGER_DEFAULTS.presenceTtlMs;
  // The ledger's own verdict wins when it says "stale". A `stale: false` does
  // NOT suppress the clock: `addEvidence` clears the flag on every "for", so a
  // ledger that is never ticked would otherwise report a person from twenty
  // minutes ago as still in the room.
  const stale = status !== "assumed" && (entry.stale === true || now - entry.lastSupport > ttl);
  const earlier = stale ? " — was here earlier" : "";
  switch (audience) {
    case "observer":
      return `${withConf} [verified: ${status}]${earlier}`;
    case "speaker":
    case "board":
      return `${named}${earlier}`;
    case "log":
      return `${entry.name} (verified)${earlier}`;
    case "monitor":
      return `${named} — verified${stale ? ", was here earlier" : ""}`;
  }
}

/** What would actually promote this hypothesis — named, because "verify it"
 *  without a recipe is what produced confident re-confirmation of lookalikes. */
function verificationRecipe(entry: PresenceEntry): string {
  return entry.lookalikeOf.length
    ? "a clear voice match or a facilitator confirmation"
    : "a sustained clear face match plus your own visual check, or a facilitator confirmation";
}

function listLabel(item: PresenceListItem): string {
  return item.relationship ? `${item.name} (${item.relationship})` : item.name;
}

/** The §6.1 block. Code hands the Monitor and both summarizers the answer
 *  instead of letting them infer presence from the conversation log. */
export function renderPresenceLists(lists: PresenceLists): string {
  const verified = lists.verified.map(listLabel).join(", ") || "—";
  const unverified = lists.unverified.map((i) => `${listLabel(i)} — ${i.reason}`).join("; ") || "—";
  const retracted = lists.retracted.map((i) => `${listLabel(i)} — ${i.reason}`).join("; ") || "—";
  return [
    "[PRESENCE — system verified]",
    `Present (verified): ${verified}`,
    `Mentioned or guessed, NOT verified present: ${unverified}`,
    `Retracted this session: ${retracted}`,
    'Record presence ONLY for the verified list. Names in the second list may appear as "asked for", "talked about", never as "was here".',
  ].join("\n");
}

// ============================================================================
// Durable-write validator
// ============================================================================

/**
 * Presence verbs, Hebrew and English. Word boundaries are done with letter
 * lookarounds, NOT \b: \b is defined over [A-Za-z0-9_], so between a space and
 * a Hebrew letter there is no boundary at all and every Hebrew pattern would
 * silently stop matching (the same class of bug that keyed Hebrew boards
 * "board_N").
 */
export const PRESENCE_VERBS =
  /(?<![\p{L}\p{N}])(?:נוכחת|נוכח|הצטרפה|הצטרף|נכנסה|נכנס|הגיעה|הגיע|נמצאת|נמצא|הייתה\s+כאן|היה\s+כאן|present|joined|entered|arrived|came\s+in|was\s+here|is\s+here|showed\s+up)(?![\p{L}\p{N}])/iu;

/** How far from the name a presence verb still counts as a claim about them. */
const PRESENCE_PROXIMITY = 60;

/**
 * Last line of defence on durable writes (Student_Notes, Student_People,
 * context_notes, auto-prompt, summaries): an unverified or retracted name
 * co-occurring with a presence verb is rejected, and the rejection NAMES THE
 * TOKEN — feedback that does not name the token produced 139 rejected board
 * rebuilds before anyone noticed. It is lexical, not a parser, and is not
 * expected to be complete: "asked for X" / "talked about X" must pass.
 */
export function checkDurablePresenceWrite(
  text: string,
  lists: PresenceLists,
): { ok: true } | { ok: false; token: string; reason: string } {
  if (!text) return { ok: true };

  const scanner = new RegExp(PRESENCE_VERBS.source, "giu");
  const spans: Array<[number, number]> = [];
  let m: RegExpExecArray | null;
  while ((m = scanner.exec(text)) !== null) {
    spans.push([m.index, m.index + m[0].length]);
    if (m[0].length === 0) scanner.lastIndex += 1;
  }
  if (spans.length === 0) return { ok: true };

  const verifiedNames = new Set(lists.verified.map((i) => i.name));
  const seen = new Set<string>();
  for (const item of [...lists.unverified, ...lists.retracted]) {
    const name = item.name?.trim();
    if (!name || name.length < 2) continue;
    if (verifiedNames.has(name) || seen.has(name)) continue;
    seen.add(name);
    let idx = text.indexOf(name);
    while (idx !== -1) {
      const start = idx;
      const end = idx + name.length;
      for (const [vs, ve] of spans) {
        if (ve >= start - PRESENCE_PROXIMITY && vs <= end + PRESENCE_PROXIMITY) {
          return {
            ok: false,
            token: name,
            reason: `${name} is not verified present this session; describe them as asked-for/talked-about, not as present`,
          };
        }
      }
      idx = text.indexOf(name, idx + 1);
    }
  }
  return { ok: true };
}
