// Unit tests for the presence-gate decisions
// (server/services/dual-agent/presence-gate.ts).
//
// The incident these exist for: on 2026-09-03 the AAC reported a student's
// sister present, greeted her aloud, and wrote "a person named X joined" into
// the permanent session summary. Only the student was there. The face matcher
// is measurably weak on family faces and will keep nominating the sister — so
// the tests below are not about the matcher being right. They pin the exact
// STRINGS the child's device produces when it is wrong, and the exact moments
// a name is allowed to survive.
//
// Everything here is pure: a real PresenceLedger builds honest entries, and
// the gate functions are called with plain data. No coordinator, no socket.

import {
  PresenceLedger,
  type PresenceEntry,
} from "@shared/aac/presence-ledger";
import {
  renderPeoplePresent,
  peoplePresentHeader,
  decideContextDemotion,
  decideSpeakerDemotion,
  speakerCandidatesLine,
  detectSelfDeclaredNames,
  type PresentFace,
} from "../services/dual-agent/presence-gate";

const STUDENT_ID = "stu-1";
const SISTER_ID = "con-sister";
const MOTHER_ID = "con-mother";

const STUDENT = "שחף";
const SISTER = "אופק";
const MOTHER = "ליאת";

/** A roster whose student/sister galleries sit inside the lookalike distance
 *  (0.4 apart, the measured pair was 0.4527) and whose mother does not. */
function buildLedger(): PresenceLedger {
  const ledger = new PresenceLedger();
  ledger.setRoster([
    { entityType: "student", entityId: STUDENT_ID, name: STUDENT, relationship: "student", faceSamples: [[0, 0, 0, 0]] },
    { entityType: "contact", entityId: SISTER_ID, name: SISTER, relationship: "Sister", faceSamples: [[0.4, 0, 0, 0]] },
    { entityType: "contact", entityId: MOTHER_ID, name: MOTHER, relationship: "Mother", faceSamples: [[3, 0, 0, 0]] },
  ]);
  ledger.setStudent(STUDENT_ID);
  return ledger;
}

const sisterPerson = { entityType: "contact" as const, entityId: SISTER_ID, name: SISTER, relationship: "Sister" };
const motherPerson = { entityType: "contact" as const, entityId: MOTHER_ID, name: MOTHER, relationship: "Mother" };

function face(over: Partial<PresentFace> = {}): PresentFace {
  return {
    matched: true,
    name: SISTER,
    entityType: "contact",
    entityId: SISTER_ID,
    relationship: "Sister",
    confidence: 0.26,
    cameraRole: "user",
    ...over,
  };
}

function entryOf(ledger: PresenceLedger, id: string, type: "student" | "contact" = "contact"): PresenceEntry {
  const e = ledger.get(type, id);
  if (!e) throw new Error(`no ledger entry for ${type}:${id}`);
  return e;
}

// ============================================================================

describe("renderPeoplePresent — the one-person lookalike case", () => {
  it("renders ONE line for one face, naming the pair and defaulting to the student", () => {
    const ledger = buildLedger();
    const now = 1_000_000;
    ledger.addEvidence(sisterPerson, { channel: "face_match", polarity: "for", strength: "weak", at: now, trackId: "t1" });

    const out = renderPeoplePresent({
      now,
      entries: ledger.current(now),
      faces: [face()],
      facesInFrame: { user: 1 },
      student: { entityId: STUDENT_ID, name: STUDENT },
      studentLookalikeKeys: ledger.get("student", STUDENT_ID)!.lookalikeOf,
    });

    expect(out).toBe(
      `[PEOPLE PRESENT] 1 face visible (user camera)\n` +
      `- the person at the device — best match ${SISTER} (Sister) 26%, ` +
      `but this is a lookalike pair with ${STUDENT} [THE STUDENT]; treat as the student unless verified.`,
    );
  });

  it("drops BOTH phrasings that manufactured a second person", () => {
    const ledger = buildLedger();
    const now = 1_000_000;
    ledger.addEvidence(sisterPerson, { channel: "face_match", polarity: "for", strength: "weak", at: now, trackId: "t1" });
    const out = renderPeoplePresent({
      now,
      entries: ledger.current(now),
      faces: [face()],
      student: { entityId: STUDENT_ID, name: STUDENT },
      studentLookalikeKeys: ledger.get("student", STUDENT_ID)!.lookalikeOf,
    });
    // "— in front of student" made the sister a person standing IN FRONT of
    // the student; the DEFAULT note then added the student as a second body.
    expect(out).not.toContain("in front of student");
    expect(out).not.toContain("DEFAULT to treating the person at the device as the student");
    expect(out.split("\n")).toHaveLength(2); // header + exactly one person
  });

  it("also collapses the mirror case: the student wins but a lookalike is contesting", () => {
    const ledger = buildLedger();
    const now = 1_000_000;
    ledger.addEvidence(
      { entityType: "student", entityId: STUDENT_ID, name: STUDENT },
      { channel: "face_match", polarity: "for", strength: "weak", at: now, trackId: "t1" },
    );
    const out = renderPeoplePresent({
      now,
      entries: ledger.current(now),
      faces: [face({ name: STUDENT, entityType: "student", entityId: STUDENT_ID, relationship: undefined, confidence: 0.31, ambiguousWith: `${SISTER} (Sister)` })],
      student: { entityId: STUDENT_ID, name: STUDENT },
      studentLookalikeKeys: ledger.get("student", STUDENT_ID)!.lookalikeOf,
    });
    expect(out).toContain(`best match ${STUDENT} [THE STUDENT] 31%`);
    expect(out).toContain(`lookalike pair with ${SISTER} (Sister)`);
    expect(out.split("\n")).toHaveLength(2);
  });

  it("does NOT collapse a non-lookalike single face — the mother is a real second person", () => {
    const ledger = buildLedger();
    const now = 1_000_000;
    ledger.addEvidence(motherPerson, { channel: "face_match", polarity: "for", strength: "weak", at: now, trackId: "t1" });
    const out = renderPeoplePresent({
      now,
      entries: ledger.current(now),
      faces: [face({ name: MOTHER, entityId: MOTHER_ID, relationship: "Mother", confidence: 0.72 })],
      student: { entityId: STUDENT_ID, name: STUDENT },
      studentLookalikeKeys: ledger.get("student", STUDENT_ID)!.lookalikeOf,
    });
    expect(out).not.toContain("lookalike pair with");
    expect(out).toContain(`- ${STUDENT} (student) [verified: assumed] [THE STUDENT]`);
    expect(out).toContain(`someone — possibly ${MOTHER} (Mother) 72%`);
  });
});

describe("renderPeoplePresent — header", () => {
  it("counts the RAW frame faces, not the capped batch we were sent", () => {
    const input = {
      now: 1,
      entries: [],
      faces: [face(), face({ entityId: MOTHER_ID, name: MOTHER })],
      facesInFrame: { user: 4 },
    };
    expect(peoplePresentHeader(input)).toBe("[PEOPLE PRESENT] 4 faces visible (user camera)");
  });

  it("names every camera that contributed", () => {
    expect(
      peoplePresentHeader({
        now: 1,
        entries: [],
        faces: [face(), face({ cameraRole: "environment", entityId: MOTHER_ID, name: MOTHER })],
        facesInFrame: { user: 1, environment: 2 },
      }),
    ).toBe("[PEOPLE PRESENT] 3 faces visible (user camera, environment camera)");
  });

  it("falls back to the batch size when the client sends no count, and singularises", () => {
    expect(peoplePresentHeader({ now: 1, entries: [], faces: [face()] }))
      .toBe("[PEOPLE PRESENT] 1 face visible (user camera)");
  });

  it("never claims fewer faces than it is about to list", () => {
    // A stale/partial count must not shrink the list below what we matched.
    expect(
      peoplePresentHeader({ now: 1, entries: [], faces: [face(), face({ entityId: MOTHER_ID })], facesInFrame: { user: 1 } }),
    ).toBe("[PEOPLE PRESENT] 2 faces visible (user camera)");
  });
});

describe("renderPeoplePresent — per-status lines", () => {
  const now = 2_000_000;

  it("renders a verified person by name and a hypothesis as 'someone — possibly'", () => {
    const ledger = buildLedger();
    // Mother: strong voice + a face → corroborated (two independent channels).
    ledger.addEvidence(motherPerson, { channel: "voice_match", polarity: "for", strength: "strong", at: now });
    ledger.addEvidence(motherPerson, { channel: "face_match", polarity: "for", strength: "weak", at: now, trackId: "t2" });
    // Sister: one weak face match → hypothesized, and lookalike-locked.
    ledger.addEvidence(sisterPerson, { channel: "face_match", polarity: "for", strength: "weak", at: now, trackId: "t1" });

    const out = renderPeoplePresent({
      now,
      entries: ledger.current(now),
      faces: [
        face({ name: MOTHER, entityId: MOTHER_ID, relationship: "Mother", confidence: 0.81 }),
        face(),
      ],
      student: { entityId: STUDENT_ID, name: STUDENT },
      studentLookalikeKeys: ledger.get("student", STUDENT_ID)!.lookalikeOf,
    });

    expect(out).toContain(`- ${STUDENT} (student) [verified: assumed] [THE STUDENT]`);
    expect(out).toContain(`- ${MOTHER} (Mother) 81% [verified: corroborated]`);
    expect(out).toContain(`- someone — possibly ${SISTER} (Sister) 26% (unverified;`);
    // The verification recipe is named, because "verify it" without a recipe
    // is what produced confident re-confirmation of lookalikes.
    expect(out).toContain("verify by: a clear voice match or a facilitator confirmation");
    // And the name never appears bare in a line a downstream renderer copies.
    expect(out).not.toContain(`- ${SISTER} (Sister) 26%`);
  });

  it("keeps a retracted person out of the block entirely", () => {
    const ledger = buildLedger();
    ledger.addEvidence(sisterPerson, { channel: "face_match", polarity: "for", strength: "weak", at: now, trackId: "t1" });
    ledger.addEvidence(sisterPerson, { channel: "observer_retraction", polarity: "against", strength: "strong", at: now + 10 });
    expect(entryOf(ledger, SISTER_ID).status).toBe("retracted");

    const out = renderPeoplePresent({
      now: now + 20,
      entries: ledger.current(now + 20), // `current` excludes retracted
      faces: [face(), face({ name: "Unknown #1", matched: false, entityId: undefined, entityType: undefined })],
      student: { entityId: STUDENT_ID, name: STUDENT },
      studentLookalikeKeys: ledger.get("student", STUDENT_ID)!.lookalikeOf,
    });
    expect(out).not.toContain(SISTER);
    expect(out).toContain("- Unknown #1 (no database match)");
  });

  it("keeps today's wording for unmatched faces", () => {
    const out = renderPeoplePresent({
      now,
      entries: [],
      faces: [face({ matched: false, name: "Unknown #1", entityId: undefined, entityType: undefined })],
    });
    expect(out).toContain("- Unknown #1 (no database match)");
  });
});

// ============================================================================

describe("decideContextDemotion", () => {
  const base = {
    enabled: true,
    updateType: "person_identified",
    key: SISTER,
    resolved: { entityType: "contact" as const, entityId: SISTER_ID },
  };

  it("takes the name off a hypothesis", () => {
    const d = decideContextDemotion({ ...base, status: "hypothesized" });
    expect(d).toEqual({ demote: true, key: "someone nearby", guessedName: SISTER, presenceStatus: "hypothesized" });
  });

  it("takes the name off a person the ledger has never seen", () => {
    expect(decideContextDemotion({ ...base, status: "absent" }).demote).toBe(true);
  });

  it("leaves corroborated and confirmed people alone", () => {
    expect(decideContextDemotion({ ...base, status: "corroborated" }).demote).toBe(false);
    expect(decideContextDemotion({ ...base, status: "confirmed" }).demote).toBe(false);
  });

  it("never touches the student", () => {
    expect(
      decideContextDemotion({
        ...base,
        key: STUDENT,
        resolved: { entityType: "student", entityId: STUDENT_ID },
        status: "assumed",
      }).demote,
    ).toBe(false);
  });

  it("leaves a generic key alone — 'a woman' is an observation, not an identification", () => {
    expect(decideContextDemotion({ ...base, key: "a woman", resolved: null, status: "absent" }).demote).toBe(false);
  });

  it("covers the prose channels too (person_gesture / person_indicates_object / other)", () => {
    for (const updateType of ["person_gesture", "person_indicates_object", "other", "new_person", "set_person_as_user", "voice_identified"]) {
      expect(decideContextDemotion({ ...base, updateType, status: "hypothesized" }).demote).toBe(true);
    }
  });

  it("never touches a retraction — it has to name who was struck", () => {
    expect(decideContextDemotion({ ...base, updateType: "misidentified", status: "retracted" }).demote).toBe(false);
  });

  it("passes everything through when the flag is off", () => {
    expect(decideContextDemotion({ ...base, enabled: false, status: "hypothesized" }).demote).toBe(false);
  });
});

// ============================================================================

describe("decideSpeakerDemotion", () => {
  const absentSister = {
    label: SISTER,
    resolved: { entityType: "contact" as const, entityId: SISTER_ID },
    status: "hypothesized" as const,
    hasFreshVoice: false,
  };
  const noParty = { label: "UNKNOWN", resolved: null, status: "absent" as const, hasFreshVoice: false };

  it("strips an unplaced roster name from the speaker", () => {
    const d = decideSpeakerDemotion({ enabled: true, speaker: absentSister, target: noParty });
    expect(d.demoteSpeaker).toBe(true);
    expect(d.guessedSpeaker).toBe(SISTER);
    expect(d.party).toBe("someone nearby");
    expect(d.demoteTarget).toBe(false);
  });

  it("keeps the name when a fresh enrolled voice places them — the parent calling from the next room", () => {
    const d = decideSpeakerDemotion({
      enabled: true,
      speaker: { ...absentSister, hasFreshVoice: true },
      target: noParty,
    });
    expect(d.demoteSpeaker).toBe(false);
  });

  it("keeps the name from corroborated upward", () => {
    for (const status of ["corroborated", "confirmed", "assumed"] as const) {
      expect(decideSpeakerDemotion({ enabled: true, speaker: { ...absentSister, status }, target: noParty }).demoteSpeaker)
        .toBe(false);
    }
  });

  it("strips an unplaced target as well, and independently", () => {
    const d = decideSpeakerDemotion({ enabled: true, speaker: noParty, target: absentSister });
    expect(d.demoteSpeaker).toBe(false);
    expect(d.demoteTarget).toBe(true);
    expect(d.guessedTarget).toBe(SISTER);
  });

  it("never strips the student", () => {
    const d = decideSpeakerDemotion({
      enabled: true,
      speaker: { label: STUDENT, resolved: { entityType: "student", entityId: STUDENT_ID }, status: "assumed", hasFreshVoice: false },
      target: noParty,
    });
    expect(d.demoteSpeaker).toBe(false);
  });

  it("leaves an UNKNOWN / non-roster label alone", () => {
    expect(decideSpeakerDemotion({ enabled: true, speaker: noParty, target: noParty }).demoteSpeaker).toBe(false);
  });

  it("passes everything through when the flag is off", () => {
    const d = decideSpeakerDemotion({ enabled: false, speaker: absentSister, target: absentSister });
    expect(d.demoteSpeaker).toBe(false);
    expect(d.demoteTarget).toBe(false);
  });
});

// ============================================================================

describe("speakerCandidatesLine", () => {
  it("states the student's capability as fact and closes with the anonymous option", () => {
    expect(
      speakerCandidatesLine({
        studentName: STUDENT,
        verbalAbility: "none",
        named: [{ name: MOTHER, relationship: "Mother" }],
      }),
    ).toBe(`Speaker candidates this session: ${STUDENT} (the student; cannot speak), DEVICE, ${MOTHER} (Mother — verified), someone nearby`);
  });

  it("says 'may speak' for anyone who can produce words", () => {
    for (const ability of ["single_words", "fluent", null, undefined] as const) {
      expect(speakerCandidatesLine({ studentName: STUDENT, verbalAbility: ability, named: [] }))
        .toBe(`Speaker candidates this session: ${STUDENT} (the student; may speak), DEVICE, someone nearby`);
    }
    expect(speakerCandidatesLine({ studentName: STUDENT, verbalAbility: "vocalizations", named: [] }))
      .toContain("cannot speak");
  });

  it("de-duplicates and handles a candidate with no relationship on file", () => {
    const line = speakerCandidatesLine({
      studentName: STUDENT,
      verbalAbility: "fluent",
      named: [{ name: MOTHER, relationship: "Mother" }, { name: MOTHER }, { name: "Giti" }],
    });
    expect(line).toBe(
      `Speaker candidates this session: ${STUDENT} (the student; may speak), DEVICE, ${MOTHER} (Mother — verified), Giti (verified), someone nearby`,
    );
  });
});

// ============================================================================

describe("detectSelfDeclaredNames", () => {
  const roster = [STUDENT, SISTER, MOTHER];

  it("finds a Hebrew self-declaration (no copula, so the lead word is the whole pattern)", () => {
    expect(detectSelfDeclaredNames(`את יודעת, אני ${SISTER}`, roster)).toEqual([SISTER]);
    expect(detectSelfDeclaredNames(`זו ${MOTHER}`, roster)).toEqual([MOTHER]);
  });

  it("finds the English forms", () => {
    expect(detectSelfDeclaredNames("hi, I'm Giti", ["Giti"])).toEqual(["Giti"]);
    expect(detectSelfDeclaredNames("this is Giti", ["Giti"])).toEqual(["Giti"]);
  });

  it("does not fire on a name merely mentioned — a sentence containing a name is not a claim about its speaker", () => {
    expect(detectSelfDeclaredNames(`איפה ${SISTER}?`, roster)).toEqual([]);
    expect(detectSelfDeclaredNames(`${SISTER} הביאה לך מים`, roster)).toEqual([]);
    expect(detectSelfDeclaredNames("", roster)).toEqual([]);
  });
});
