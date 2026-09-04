// Unit tests for the presence ledger (shared/aac/presence-ledger.ts): the
// status derivation, the lookalike lock, decay, retraction, the boundary
// formatter and the durable-write validator.
//
// Motivated by the 2026-09-03 incident — the student's sister reported
// present, greeted aloud, and written into the permanent summary, with only
// the student in the room. The replay suite at the bottom drives the real
// (anonymised) face/Observer/transcript sequence from that failure class
// through the ledger and asserts the sister never gets past a hypothesis.
// See planning-docs/aac-presence-ledger.md.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  PRESENCE_LEDGER_DEFAULTS,
  PRESENCE_VERBS,
  PresenceLedger,
  checkDurablePresenceWrite,
  entityKey,
  faceEvidenceStrength,
  isStatusAtLeast,
  renderPerson,
  renderPresenceLists,
  statusRank,
  type PresenceEntry,
  type PresenceLists,
  type PresenceStatus,
  type RosterPerson,
} from "@shared/aac/presence-ledger";
import { TrackIdentityResolver } from "@shared/aac/face-track-identity";

const STUDENT_ID = "s1";
const SISTER = { entityType: "contact" as const, entityId: "sis", name: "אופק", relationship: "Sister" };
const MOTHER = { entityType: "contact" as const, entityId: "mom", name: "ליאת", relationship: "Mother" };
const THERAPIST = { entityType: "contact" as const, entityId: "ther", name: "Giti", relationship: "Therapist" };

/** 128-d descriptors: `spike` at `slot` and zeros elsewhere, so the pairwise
 *  euclidean distance between two of them is trivially predictable. */
function descriptor(slot: number, spike: number): number[] {
  const v = new Array<number>(128).fill(0);
  v[slot] = spike;
  return v;
}

/** student ↔ sister sit 0.46 apart (the measured family number); everyone else
 *  is far away. */
function lookalikeRoster(): RosterPerson[] {
  return [
    { entityType: "student", entityId: STUDENT_ID, name: "שחף", faceSamples: [descriptor(0, 0)] },
    { ...SISTER, faceSamples: [descriptor(0, 0.46)] },
    { ...MOTHER, faceSamples: [descriptor(1, 5)] },
  ];
}

function makeLedger(withRoster = false): PresenceLedger {
  const ledger = new PresenceLedger();
  if (withRoster) ledger.setRoster(lookalikeRoster());
  ledger.setStudent(STUDENT_ID);
  return ledger;
}

// ============================================================================
// Status algebra
// ============================================================================

describe("statusRank / isStatusAtLeast", () => {
  it("ranks absent and retracted at the floor", () => {
    expect(statusRank("absent")).toBe(0);
    expect(statusRank("retracted")).toBe(0);
    expect(statusRank("hypothesized")).toBe(1);
    expect(statusRank("corroborated")).toBe(2);
    expect(statusRank("confirmed")).toBe(3);
    expect(statusRank("assumed")).toBe(3);
  });

  it("gates rungs by rank", () => {
    expect(isStatusAtLeast("corroborated", "corroborated")).toBe(true);
    expect(isStatusAtLeast("confirmed", "corroborated")).toBe(true);
    expect(isStatusAtLeast("assumed", "confirmed")).toBe(true);
    expect(isStatusAtLeast("hypothesized", "corroborated")).toBe(false);
    expect(isStatusAtLeast("retracted", "hypothesized")).toBe(false);
    expect(isStatusAtLeast("absent", "hypothesized")).toBe(false);
  });
});

describe("faceEvidenceStrength", () => {
  it("is strong when the matcher did not flag it borderline", () => {
    expect(faceEvidenceStrength({ distance: 0.55, borderline: false })).toBe("strong");
  });

  it("is strong for a close borderline match with a clear runner-up gap", () => {
    expect(faceEvidenceStrength({ distance: 0.4, runnerUpDistance: 0.55, borderline: true })).toBe("strong");
    // No runner-up at all = infinite gap.
    expect(faceEvidenceStrength({ distance: 0.414, borderline: true })).toBe("strong");
  });

  it("is weak for a borderline match that is too far or too crowded", () => {
    expect(faceEvidenceStrength({ distance: 0.45, borderline: true })).toBe("weak");
    expect(faceEvidenceStrength({ distance: 0.4, runnerUpDistance: 0.45, borderline: true })).toBe("weak");
  });

  it("is weak whenever a runner-up PERSON is ambiguous, however good the score", () => {
    expect(faceEvidenceStrength({ distance: 0.2, borderline: false, ambiguousWith: "contact:sis" })).toBe("weak");
  });

  it("is weak when the attribute veto failed", () => {
    expect(faceEvidenceStrength({ distance: 0.2, borderline: false, vetoPassed: false })).toBe("weak");
    expect(faceEvidenceStrength({ distance: 0.2, borderline: false, vetoPassed: true })).toBe("strong");
  });
});

describe("entityKey / defaults", () => {
  it("keys by type and id", () => {
    expect(entityKey("contact", "sis")).toBe("contact:sis");
  });

  it("ships the documented tuning", () => {
    expect(PRESENCE_LEDGER_DEFAULTS).toEqual({
      hypothesisTtlMs: 120_000,
      presenceTtlMs: 300_000,
      retractionHoldMs: 600_000,
      corroborationWindowMs: 90_000,
      sustainedBatches: 3,
      lookalikeDistance: 0.5,
      evidenceRing: 40,
    });
  });
});

// ============================================================================
// Derivation
// ============================================================================

describe("PresenceLedger — the student", () => {
  it("is assumed present and stays assumed", () => {
    const ledger = makeLedger(true);
    expect(ledger.statusOf("student", STUDENT_ID)).toBe("assumed");
    ledger.tick(PRESENCE_LEDGER_DEFAULTS.hypothesisTtlMs * 10);
    expect(ledger.statusOf("student", STUDENT_ID)).toBe("assumed");
  });

  it("is never downgraded by the lookalike lock, and still records evidence", () => {
    const ledger = makeLedger(true);
    const entry = ledger.addEvidence(
      { entityType: "student", entityId: STUDENT_ID, name: "שחף" },
      { channel: "face_match", polarity: "for", strength: "weak", at: 1000 },
    );
    expect(entry.lookalikeOf).toEqual([entityKey("contact", "sis")]);
    expect(entry.evidence).toHaveLength(1);
    expect(ledger.statusOf("student", STUDENT_ID)).toBe("assumed");
  });
});

describe("PresenceLedger — hypothesized", () => {
  it("a single Observer sighting is a hypothesis and nothing more", () => {
    const ledger = makeLedger();
    ledger.addEvidence(SISTER, { channel: "observer_visual", polarity: "for", strength: "weak", at: 1000 });
    expect(ledger.statusOf("contact", "sis")).toBe("hypothesized");
    expect(ledger.isAtLeast("contact", "sis", "corroborated")).toBe(false);
  });

  it("an unknown entity is absent", () => {
    const ledger = makeLedger();
    expect(ledger.statusOf("contact", "nobody")).toBe("absent");
    expect(ledger.get("contact", "nobody")).toBeUndefined();
  });
});

describe("PresenceLedger — corroborated", () => {
  it("two different channels inside the window corroborate", () => {
    const ledger = makeLedger();
    ledger.addEvidence(MOTHER, { channel: "face_match", polarity: "for", strength: "weak", at: 1000 });
    ledger.addEvidence(MOTHER, { channel: "voice_match", polarity: "for", strength: "weak", at: 20_000 });
    expect(ledger.statusOf("contact", "mom")).toBe("corroborated");
  });

  it("does not corroborate across a gap wider than the window", () => {
    const ledger = makeLedger();
    ledger.addEvidence(MOTHER, { channel: "face_match", polarity: "for", strength: "weak", at: 0 });
    ledger.addEvidence(MOTHER, {
      channel: "voice_match",
      polarity: "for",
      strength: "weak",
      at: PRESENCE_LEDGER_DEFAULTS.corroborationWindowMs + 1,
    });
    expect(ledger.statusOf("contact", "mom")).toBe("hypothesized");
  });

  it("the Observer does NOT corroborate a weak face line — it was primed by it", () => {
    const ledger = makeLedger();
    ledger.addEvidence(MOTHER, { channel: "face_match", polarity: "for", strength: "weak", at: 1000 });
    ledger.addEvidence(MOTHER, { channel: "observer_visual", polarity: "for", strength: "weak", at: 2000 });
    expect(ledger.statusOf("contact", "mom")).toBe("hypothesized");
  });

  it("the Observer DOES corroborate a strong face line", () => {
    const ledger = makeLedger();
    ledger.addEvidence(MOTHER, { channel: "face_match", polarity: "for", strength: "strong", at: 1000 });
    ledger.addEvidence(MOTHER, { channel: "observer_visual", polarity: "for", strength: "weak", at: 2000 });
    expect(ledger.statusOf("contact", "mom")).toBe("corroborated");
  });

  it("a strong voice plus any face corroborates", () => {
    const ledger = makeLedger();
    ledger.addEvidence(MOTHER, { channel: "voice_match", polarity: "for", strength: "strong", at: 0 });
    ledger.addEvidence(MOTHER, {
      channel: "face_match",
      polarity: "for",
      strength: "weak",
      at: PRESENCE_LEDGER_DEFAULTS.corroborationWindowMs * 5,
    });
    expect(ledger.statusOf("contact", "mom")).toBe("corroborated");
  });

  it("three sustained strong face batches on one track corroborate on their own", () => {
    const ledger = makeLedger();
    for (const at of [0, 2000, 4000]) {
      ledger.addEvidence(MOTHER, {
        channel: "face_match",
        polarity: "for",
        strength: "strong",
        trackId: "cam:user",
        at,
      });
    }
    expect(ledger.statusOf("contact", "mom")).toBe("corroborated");
  });

  it("gives no sustained credit without a track id", () => {
    const ledger = makeLedger();
    for (const at of [0, 2000, 4000]) {
      ledger.addEvidence(MOTHER, { channel: "face_match", polarity: "for", strength: "strong", at });
    }
    expect(ledger.statusOf("contact", "mom")).toBe("hypothesized");
  });

  it("gives no sustained credit when the run is broken by a weak batch or a track change", () => {
    const weak = makeLedger();
    weak.addEvidence(MOTHER, { channel: "face_match", polarity: "for", strength: "strong", trackId: "t", at: 0 });
    weak.addEvidence(MOTHER, { channel: "face_match", polarity: "for", strength: "weak", trackId: "t", at: 1000 });
    weak.addEvidence(MOTHER, { channel: "face_match", polarity: "for", strength: "strong", trackId: "t", at: 2000 });
    weak.addEvidence(MOTHER, { channel: "face_match", polarity: "for", strength: "strong", trackId: "t", at: 3000 });
    expect(weak.statusOf("contact", "mom")).toBe("hypothesized");

    const hop = makeLedger();
    hop.addEvidence(MOTHER, { channel: "face_match", polarity: "for", strength: "strong", trackId: "a", at: 0 });
    hop.addEvidence(MOTHER, { channel: "face_match", polarity: "for", strength: "strong", trackId: "b", at: 1000 });
    hop.addEvidence(MOTHER, { channel: "face_match", polarity: "for", strength: "strong", trackId: "a", at: 2000 });
    expect(hop.statusOf("contact", "mom")).toBe("hypothesized");
  });
});

describe("PresenceLedger — confirmed", () => {
  it("a human confirmation confirms outright", () => {
    const ledger = makeLedger();
    ledger.addEvidence(MOTHER, { channel: "human_confirm", polarity: "for", strength: "strong", at: 1000 });
    expect(ledger.statusOf("contact", "mom")).toBe("confirmed");
  });

  it("a sustained strong track plus a LATER Observer sighting confirms", () => {
    const ledger = makeLedger();
    for (const at of [0, 2000, 4000]) {
      ledger.addEvidence(MOTHER, {
        channel: "face_match",
        polarity: "for",
        strength: "strong",
        trackId: "cam:user",
        at,
      });
    }
    ledger.addEvidence(MOTHER, { channel: "observer_visual", polarity: "for", strength: "weak", at: 5000 });
    expect(ledger.statusOf("contact", "mom")).toBe("confirmed");
  });

  it("an Observer sighting from BEFORE the run does not confirm it", () => {
    const ledger = makeLedger();
    ledger.addEvidence(MOTHER, { channel: "observer_visual", polarity: "for", strength: "weak", at: 0 });
    for (const at of [10_000, 12_000, 14_000]) {
      ledger.addEvidence(MOTHER, {
        channel: "face_match",
        polarity: "for",
        strength: "strong",
        trackId: "cam:user",
        at,
      });
    }
    expect(ledger.statusOf("contact", "mom")).toBe("corroborated");
  });
});

// ============================================================================
// Lookalike lock
// ============================================================================

describe("PresenceLedger — the lookalike lock", () => {
  it("marks the pair from the galleries", () => {
    const ledger = makeLedger(true);
    ledger.addEvidence(SISTER, { channel: "observer_visual", polarity: "for", strength: "weak", at: 0 });
    expect(ledger.get("contact", "sis")?.lookalikeOf).toEqual([entityKey("student", STUDENT_ID)]);
    ledger.addEvidence(MOTHER, { channel: "observer_visual", polarity: "for", strength: "weak", at: 0 });
    expect(ledger.get("contact", "mom")?.lookalikeOf).toEqual([]);
  });

  it("caps a locked entity at hypothesized however many face batches it wins", () => {
    const ledger = makeLedger(true);
    for (const at of [0, 2000, 4000, 6000, 8000]) {
      ledger.addEvidence(SISTER, {
        channel: "face_match",
        polarity: "for",
        strength: "strong",
        trackId: "cam:user",
        at,
      });
    }
    ledger.addEvidence(SISTER, { channel: "observer_visual", polarity: "for", strength: "weak", at: 9000 });
    expect(ledger.statusOf("contact", "sis")).toBe("hypothesized");
  });

  it("lets a strong voice match promote a locked entity", () => {
    const ledger = makeLedger(true);
    ledger.addEvidence(SISTER, { channel: "face_match", polarity: "for", strength: "weak", at: 0 });
    ledger.addEvidence(SISTER, { channel: "voice_match", polarity: "for", strength: "strong", at: 1000 });
    expect(ledger.statusOf("contact", "sis")).toBe("corroborated");
  });

  it("does not let a WEAK voice match unlock the pair", () => {
    const ledger = makeLedger(true);
    ledger.addEvidence(SISTER, { channel: "face_match", polarity: "for", strength: "weak", at: 0 });
    ledger.addEvidence(SISTER, { channel: "voice_match", polarity: "for", strength: "weak", at: 1000 });
    expect(ledger.statusOf("contact", "sis")).toBe("hypothesized");
  });

  it("lets a human confirmation promote a locked entity", () => {
    const ledger = makeLedger(true);
    ledger.addEvidence(SISTER, { channel: "human_confirm", polarity: "for", strength: "strong", at: 0 });
    expect(ledger.statusOf("contact", "sis")).toBe("confirmed");
  });

  it("applies a roster loaded after the entry exists", () => {
    const ledger = makeLedger();
    ledger.addEvidence(SISTER, { channel: "observer_visual", polarity: "for", strength: "weak", at: 0 });
    ledger.setRoster(lookalikeRoster());
    expect(ledger.get("contact", "sis")?.lookalikeOf).toEqual([entityKey("student", STUDENT_ID)]);
  });

  it("does not pair people whose galleries are far apart", () => {
    const ledger = new PresenceLedger();
    ledger.setRoster([
      { entityType: "student", entityId: STUDENT_ID, name: "שחף", faceSamples: [descriptor(0, 0)] },
      { ...MOTHER, faceSamples: [descriptor(0, 0.9)] },
    ]);
    ledger.setStudent(STUDENT_ID);
    ledger.addEvidence(MOTHER, { channel: "observer_visual", polarity: "for", strength: "weak", at: 0 });
    expect(ledger.get("contact", "mom")?.lookalikeOf).toEqual([]);
  });
});

// ============================================================================
// Audit-only channels
// ============================================================================

describe("PresenceLedger — audit-only channels carry weight 0", () => {
  it("a speech label alone never creates presence", () => {
    const ledger = makeLedger();
    ledger.addEvidence(SISTER, { channel: "speech_attribution", polarity: "for", strength: "weak", at: 0 });
    expect(ledger.statusOf("contact", "sis")).toBe("absent");
    expect(ledger.isAtLeast("contact", "sis", "hypothesized")).toBe(false);
  });

  it("keeps the entry so the Monitor still learns the name was mentioned", () => {
    const ledger = makeLedger();
    ledger.addEvidence(SISTER, { channel: "speech_attribution", polarity: "for", strength: "weak", at: 0 });
    const lists = ledger.lists(1000);
    expect(ledger.entries().map((e) => e.entityId)).toContain("sis");
    expect(lists.verified.map((i) => i.name)).not.toContain("אופק");
    expect(lists.unverified.map((i) => i.name)).toContain("אופק");
    expect(lists.unverified.find((i) => i.name === "אופק")?.reason).toBe("speech label only");
  });

  it("a self-declaration is not evidence that the speaker is that person", () => {
    const ledger = makeLedger();
    ledger.addEvidence(SISTER, { channel: "self_declaration", polarity: "for", strength: "strong", at: 0 });
    expect(ledger.statusOf("contact", "sis")).toBe("absent");
    expect(ledger.lists(0).unverified[0].reason).toBe("self-declared only");
  });

  it("never counts as the second channel of a corroboration", () => {
    const ledger = makeLedger();
    ledger.addEvidence(MOTHER, { channel: "observer_visual", polarity: "for", strength: "weak", at: 0 });
    ledger.addEvidence(MOTHER, { channel: "speech_attribution", polarity: "for", strength: "strong", at: 1000 });
    ledger.addEvidence(MOTHER, { channel: "self_declaration", polarity: "for", strength: "strong", at: 2000 });
    expect(ledger.statusOf("contact", "mom")).toBe("hypothesized");
  });

  it("stops being audit-only once a real channel supports it", () => {
    const ledger = makeLedger();
    ledger.addEvidence(MOTHER, { channel: "speech_attribution", polarity: "for", strength: "weak", at: 0 });
    expect(ledger.statusOf("contact", "mom")).toBe("absent");
    ledger.addEvidence(MOTHER, { channel: "observer_visual", polarity: "for", strength: "weak", at: 1000 });
    expect(ledger.statusOf("contact", "mom")).toBe("hypothesized");
    expect(ledger.get("contact", "mom")?.auditOnly).toBe(false);
  });
});

// ============================================================================
// Retraction and decay
// ============================================================================

describe("PresenceLedger — retraction", () => {
  const HOLD = PRESENCE_LEDGER_DEFAULTS.retractionHoldMs;

  function retracted(): PresenceLedger {
    const ledger = makeLedger();
    ledger.addEvidence(MOTHER, { channel: "face_match", polarity: "for", strength: "strong", at: 0 });
    ledger.addEvidence(MOTHER, { channel: "observer_visual", polarity: "for", strength: "weak", at: 1000 });
    expect(ledger.statusOf("contact", "mom")).toBe("corroborated");
    ledger.addEvidence(MOTHER, { channel: "observer_retraction", polarity: "against", strength: "strong", at: 2000 });
    return ledger;
  }

  it("an Observer retraction strikes even a corroborated entry", () => {
    expect(retracted().statusOf("contact", "mom")).toBe("retracted");
  });

  it("a human correction retracts too", () => {
    const ledger = makeLedger();
    ledger.addEvidence(MOTHER, { channel: "observer_visual", polarity: "for", strength: "weak", at: 0 });
    ledger.addEvidence(MOTHER, { channel: "human_confirm", polarity: "against", strength: "strong", at: 1000 });
    expect(ledger.statusOf("contact", "mom")).toBe("retracted");
  });

  it("holds through weak evidence inside the hold window", () => {
    const ledger = retracted();
    ledger.addEvidence(MOTHER, { channel: "face_match", polarity: "for", strength: "weak", at: 3000 });
    ledger.addEvidence(MOTHER, { channel: "observer_visual", polarity: "for", strength: "weak", at: 4000 });
    expect(ledger.statusOf("contact", "mom")).toBe("retracted");
  });

  it("holds through STRONG evidence inside the hold window", () => {
    const ledger = retracted();
    ledger.addEvidence(MOTHER, { channel: "face_match", polarity: "for", strength: "strong", at: 2000 + HOLD - 1 });
    expect(ledger.statusOf("contact", "mom")).toBe("retracted");
  });

  it("stays retracted for a weak signal after the hold expires", () => {
    const ledger = retracted();
    ledger.addEvidence(MOTHER, { channel: "face_match", polarity: "for", strength: "weak", at: 2000 + HOLD + 1 });
    expect(ledger.statusOf("contact", "mom")).toBe("retracted");
  });

  it("re-enters on a strong signal after the hold, at the grade the NEW evidence earns", () => {
    const ledger = retracted();
    const at = 2000 + HOLD + 1;
    ledger.addEvidence(MOTHER, { channel: "face_match", polarity: "for", strength: "strong", at });
    // The pre-retraction Observer sighting must not count again.
    expect(ledger.statusOf("contact", "mom")).toBe("hypothesized");
    ledger.addEvidence(MOTHER, { channel: "voice_match", polarity: "for", strength: "strong", at: at + 1000 });
    expect(ledger.statusOf("contact", "mom")).toBe("corroborated");
  });

  it("records the retraction in the lists with a reason", () => {
    const lists = retracted().lists(3000);
    expect(lists.retracted.map((i) => i.name)).toEqual(["ליאת"]);
    expect(lists.retracted[0].reason).toBe("retracted by the Observer as a misidentification");
    expect(lists.verified.map((i) => i.name)).not.toContain("ליאת");
  });

  it("survives the decay pass (a retraction is not forgotten)", () => {
    const ledger = retracted();
    ledger.tick(2000 + PRESENCE_LEDGER_DEFAULTS.hypothesisTtlMs * 5);
    expect(ledger.statusOf("contact", "mom")).toBe("retracted");
  });
});

describe("PresenceLedger — decay", () => {
  const TTL = PRESENCE_LEDGER_DEFAULTS.hypothesisTtlMs;
  const PRESENCE_TTL = PRESENCE_LEDGER_DEFAULTS.presenceTtlMs;

  it("ages an unsupported hypothesis out of `current` but NEVER out of the ledger", () => {
    const ledger = makeLedger();
    ledger.addEvidence(SISTER, { channel: "observer_visual", polarity: "for", strength: "weak", at: 0 });
    ledger.tick(TTL);
    expect(ledger.isCurrent("contact", "sis", TTL)).toBe(true);
    expect(ledger.get("contact", "sis")?.stale).toBe(false);

    ledger.tick(TTL + 1);
    const entry = ledger.get("contact", "sis");
    expect(entry).toBeDefined();
    expect(entry!.stale).toBe(true);
    // The record survives: status, evidence and the unverified listing stay.
    expect(ledger.statusOf("contact", "sis")).toBe("hypothesized");
    expect(ledger.isCurrent("contact", "sis", TTL + 1)).toBe(false);
    expect(ledger.current(TTL + 1).map((e) => e.entityId)).toEqual([STUDENT_ID]);
    expect(ledger.lists(TTL + 1).unverified.map((i) => i.name)).toContain("אופק");
  });

  it("keeps a hypothesis that is still being supported current", () => {
    const ledger = makeLedger();
    ledger.addEvidence(SISTER, { channel: "observer_visual", polarity: "for", strength: "weak", at: 0 });
    ledger.addEvidence(SISTER, { channel: "observer_visual", polarity: "for", strength: "weak", at: TTL });
    ledger.tick(TTL + 1);
    expect(ledger.statusOf("contact", "sis")).toBe("hypothesized");
    expect(ledger.isCurrent("contact", "sis", TTL + 1)).toBe(true);
  });

  it("clears the stale flag when new evidence arrives", () => {
    const ledger = makeLedger();
    ledger.addEvidence(SISTER, { channel: "observer_visual", polarity: "for", strength: "weak", at: 0 });
    ledger.tick(TTL + 1);
    expect(ledger.get("contact", "sis")!.stale).toBe(true);
    ledger.addEvidence(SISTER, { channel: "observer_visual", polarity: "for", strength: "weak", at: TTL + 2 });
    expect(ledger.get("contact", "sis")!.stale).toBe(false);
    expect(ledger.isCurrent("contact", "sis", TTL + 2)).toBe(true);
  });

  it("keeps an audit-only mention for the session-end lists", () => {
    const ledger = makeLedger();
    ledger.addEvidence(SISTER, { channel: "speech_attribution", polarity: "for", strength: "weak", at: 0 });
    ledger.tick(TTL + 1);
    const entry = ledger.get("contact", "sis");
    expect(entry).toBeDefined();
    expect(entry!.stale).toBe(true);
    expect(ledger.isCurrent("contact", "sis", TTL + 1)).toBe(false);
    expect(ledger.lists(TTL + 1).unverified.map((i) => i.reason)).toContain("speech label only");
  });

  it("gives a verified person the longer presence ttl", () => {
    const ledger = makeLedger();
    ledger.addEvidence(MOTHER, { channel: "face_match", polarity: "for", strength: "strong", at: 0 });
    ledger.addEvidence(MOTHER, { channel: "observer_visual", polarity: "for", strength: "weak", at: 1000 });
    ledger.tick(TTL + 1);
    expect(ledger.isCurrent("contact", "mom", TTL + 1)).toBe(true);
    ledger.tick(1000 + PRESENCE_TTL + 1);
    expect(ledger.isCurrent("contact", "mom", 1000 + PRESENCE_TTL + 1)).toBe(false);
    expect(ledger.get("contact", "mom")!.stale).toBe(true);
  });

  it("never drops a corroborated entry's status within the session", () => {
    const ledger = makeLedger();
    ledger.addEvidence(MOTHER, { channel: "face_match", polarity: "for", strength: "strong", at: 0 });
    ledger.addEvidence(MOTHER, { channel: "observer_visual", polarity: "for", strength: "weak", at: 1000 });
    ledger.tick(TTL * 20);
    expect(ledger.statusOf("contact", "mom")).toBe("corroborated");
    expect(ledger.entries().map((e) => e.entityId)).toContain("mom");
    expect(ledger.lists(TTL * 20).verified.map((i) => i.name)).toContain("ליאת");
  });

  it("never ages the student out of `current`", () => {
    const ledger = makeLedger();
    ledger.tick(TTL * 100);
    expect(ledger.isCurrent("student", STUDENT_ID, TTL * 100)).toBe(true);
    expect(ledger.get("student", STUDENT_ID)!.stale).toBeFalsy();
  });

  it("keeps a retracted person out of `current` however fresh the retraction", () => {
    const ledger = makeLedger();
    ledger.addEvidence(MOTHER, { channel: "observer_visual", polarity: "for", strength: "weak", at: 0 });
    ledger.addEvidence(MOTHER, { channel: "observer_retraction", polarity: "against", strength: "strong", at: 100 });
    expect(ledger.isCurrent("contact", "mom", 200)).toBe(false);
    expect(ledger.current(200).map((e) => e.entityId)).toEqual([STUDENT_ID]);
    expect(ledger.lists(200).retracted.map((i) => i.name)).toEqual(["ליאת"]);
  });

  it("computes `current` without needing a tick first", () => {
    const ledger = makeLedger();
    ledger.addEvidence(SISTER, { channel: "observer_visual", polarity: "for", strength: "weak", at: 0 });
    expect(ledger.isCurrent("contact", "sis", TTL - 1)).toBe(true);
    expect(ledger.isCurrent("contact", "sis", TTL + 1)).toBe(false);
    expect(ledger.isCurrent("contact", "nobody", 0)).toBe(false);
  });
});

describe("PresenceLedger — the evidence ring", () => {
  it("is bounded", () => {
    const ledger = new PresenceLedger({ evidenceRing: 4 });
    ledger.setStudent(STUDENT_ID);
    for (let i = 0; i < 10; i++) {
      ledger.addEvidence(MOTHER, { channel: "observer_visual", polarity: "for", strength: "weak", at: i });
    }
    const entry = ledger.get("contact", "mom")!;
    expect(entry.evidence).toHaveLength(4);
    expect(entry.evidence[0].at).toBe(6);
    expect(entry.evidence[3].at).toBe(9);
  });
});

// ============================================================================
// Snapshot
// ============================================================================

describe("PresenceLedger — snapshot", () => {
  function populated(): PresenceLedger {
    const ledger = makeLedger(true);
    ledger.addEvidence(SISTER, { channel: "speech_attribution", polarity: "for", strength: "weak", at: 100 });
    ledger.addEvidence(SISTER, { channel: "observer_visual", polarity: "for", strength: "weak", at: 200 });
    ledger.addEvidence(MOTHER, { channel: "face_match", polarity: "for", strength: "strong", at: 300 });
    ledger.addEvidence(MOTHER, { channel: "observer_visual", polarity: "for", strength: "weak", at: 400 });
    return ledger;
  }

  it("is JSON-serialisable and records the status timeline", () => {
    const snap = populated().snapshot();
    expect(snap.version).toBe(1);
    expect(JSON.parse(JSON.stringify(snap))).toEqual(snap);
    const mom = snap.entries.find((e) => e.entityId === "mom")!;
    expect(mom.timeline.map((t) => t.status)).toEqual(["corroborated"]);
    expect(snap.entries.find((e) => e.entityType === "student")!.timeline[0].status).toBe("assumed");
  });

  it("round-trips", () => {
    const before = populated();
    const restored = PresenceLedger.fromSnapshot(JSON.parse(JSON.stringify(before.snapshot())));
    expect(restored.entries()).toEqual(before.entries());
    expect(restored.lists(1000)).toEqual(before.lists(1000));
    expect(restored.statusOf("student", STUDENT_ID)).toBe("assumed");
    expect(restored.statusOf("contact", "mom")).toBe("corroborated");
    expect(restored.statusOf("contact", "sis")).toBe("hypothesized");
    expect(restored.snapshot().entries).toEqual(before.snapshot().entries);
  });

  it("keeps deriving correctly after a restore", () => {
    const restored = PresenceLedger.fromSnapshot(populated().snapshot());
    restored.addEvidence(SISTER, { channel: "voice_match", polarity: "for", strength: "strong", at: 500 });
    // Still locked: only voice + a second channel can promote her.
    expect(restored.statusOf("contact", "sis")).toBe("corroborated");
    restored.addEvidence(SISTER, { channel: "observer_retraction", polarity: "against", strength: "strong", at: 600 });
    expect(restored.statusOf("contact", "sis")).toBe("retracted");
  });
});

// ============================================================================
// The boundary formatter
// ============================================================================

describe("renderPerson", () => {
  function entryWith(overrides: Partial<PresenceEntry>): PresenceEntry {
    return {
      entityType: "contact",
      entityId: "sis",
      name: "אופק",
      relationship: "Sister",
      status: "hypothesized",
      since: 0,
      lastSupport: 0,
      lookalikeOf: [],
      evidence: [],
      ...overrides,
    };
  }

  const verified = entryWith({ status: "corroborated" });
  const guess = entryWith({ status: "hypothesized" });
  const locked = entryWith({ status: "hypothesized", lookalikeOf: ["student:s1"] });
  const struck = entryWith({ status: "retracted" });

  it("gives the Observer the name, the grade and a verification recipe", () => {
    expect(renderPerson(verified, "observer", { now: 0 })).toBe("אופק (Sister) [verified: corroborated]");
    expect(renderPerson(guess, "observer", { now: 0, description: "adult, glasses" })).toBe(
      "someone — possibly אופק (Sister) (unverified; on file: adult, glasses; verify by: a sustained clear face match plus your own visual check, or a facilitator confirmation)",
    );
    expect(renderPerson(locked, "observer", { now: 0 })).toBe(
      "someone — possibly אופק (Sister) (unverified; verify by: a clear voice match or a facilitator confirmation)",
    );
    expect(renderPerson(struck, "observer")).toBe("(retracted: אופק — treat as not present)");
  });

  it("includes a confidence when one is supplied", () => {
    expect(renderPerson(verified, "observer", { now: 0, confidence: 0.26 })).toBe(
      "אופק (Sister) 26% [verified: corroborated]",
    );
    expect(renderPerson(guess, "observer", { now: 0, confidence: 26 })).toContain("אופק (Sister) 26%");
  });

  it("never gives the Speaker or the Board a guessed name", () => {
    for (const audience of ["speaker", "board"] as const) {
      expect(renderPerson(verified, audience, { now: 0 })).toBe("אופק (Sister)");
      expect(renderPerson(guess, audience, { now: 0 })).toBe("someone nearby");
      expect(renderPerson(struck, audience, { now: 0 })).toBe("(retracted: אופק — treat as not present)");
    }
  });

  it("marks the guess in the conversation log without asserting it", () => {
    expect(renderPerson(verified, "log", { now: 0 })).toBe("אופק (verified)");
    expect(renderPerson(guess, "log", { now: 0 })).toBe("someone (unverified guess: אופק)");
    expect(renderPerson(struck, "log", { now: 0 })).toBe("אופק (retracted)");
  });

  it("tells the Monitor the grade in words", () => {
    expect(renderPerson(verified, "monitor", { now: 0 })).toBe("אופק (Sister) — verified");
    expect(renderPerson(guess, "monitor", { now: 0 })).toBe("אופק (Sister) — NOT verified present");
    expect(renderPerson(struck, "monitor", { now: 0 })).toBe("אופק — retracted");
  });

  it("ages a verified person into 'was here earlier' once support goes stale", () => {
    const now = PRESENCE_LEDGER_DEFAULTS.presenceTtlMs + 1;
    expect(renderPerson(verified, "observer", { now })).toBe(
      "אופק (Sister) [verified: corroborated] — was here earlier",
    );
    expect(renderPerson(verified, "speaker", { now })).toBe("אופק (Sister) — was here earlier");
    expect(renderPerson(verified, "monitor", { now })).toBe("אופק (Sister) — verified, was here earlier");
  });

  it("honours a caller-supplied presence ttl", () => {
    const now = 60_000;
    expect(renderPerson(verified, "speaker", { now, presenceTtlMs: 600_000 })).toBe("אופק (Sister)");
    expect(renderPerson(verified, "speaker", { now, presenceTtlMs: 30_000 })).toBe("אופק (Sister) — was here earlier");
  });

  it("prefers the ledger's own stale verdict", () => {
    const aged = entryWith({ status: "corroborated", stale: true });
    expect(renderPerson(aged, "speaker", { now: 0 })).toBe("אופק (Sister) — was here earlier");
    // A `stale: false` never suppresses the clock — an unticked ledger must not
    // report a person from twenty minutes ago as still in the room.
    const fresh = entryWith({ status: "corroborated", stale: false });
    expect(renderPerson(fresh, "speaker", { now: PRESENCE_LEDGER_DEFAULTS.presenceTtlMs + 1 })).toBe(
      "אופק (Sister) — was here earlier",
    );
  });

  it("never ages the student out of the room", () => {
    const student = entryWith({ entityType: "student", entityId: "s1", name: "שחף", status: "assumed", relationship: undefined });
    expect(renderPerson(student, "speaker", { now: PRESENCE_LEDGER_DEFAULTS.presenceTtlMs * 10 })).toBe("שחף");
  });

  it("renders an audit-only entry as a guess, never as a name to use", () => {
    const auditOnly = entryWith({ auditOnly: true });
    expect(renderPerson(auditOnly, "speaker", { now: 0 })).toBe("someone nearby");
    expect(renderPerson(auditOnly, "log", { now: 0 })).toBe("someone (unverified guess: אופק)");
  });

  it("takes a relationship override and keeps names byte-exact", () => {
    expect(renderPerson(entryWith({ relationship: undefined, status: "confirmed" }), "speaker", { now: 0 })).toBe("אופק");
    expect(
      renderPerson(entryWith({ status: "confirmed" }), "speaker", { now: 0, relationship: "אחות" }),
    ).toBe("אופק (אחות)");
  });
});

describe("renderPresenceLists", () => {
  it("produces the §6.1 block", () => {
    const lists: PresenceLists = {
      verified: [
        { entityType: "user", entityId: "u1", name: "עופר סוחמי", relationship: "Father", status: "confirmed", reason: "confirmed by a human" },
        { entityType: "contact", entityId: "mom", name: "ליאת", relationship: "Mother", status: "corroborated", reason: "corroborated by face + voice" },
      ],
      unverified: [
        { entityType: "contact", entityId: "sis", name: "אופק", relationship: "Sister", status: "hypothesized", reason: "face lookalike of שחף, 1 speech label" },
        { entityType: "contact", entityId: "g", name: "Giti", status: "hypothesized", reason: "Observer guess, no biometric data" },
      ],
      retracted: [],
    };
    expect(renderPresenceLists(lists)).toBe(
      [
        "[PRESENCE — system verified]",
        "Present (verified): עופר סוחמי (Father), ליאת (Mother)",
        "Mentioned or guessed, NOT verified present: אופק (Sister) — face lookalike of שחף, 1 speech label; Giti — Observer guess, no biometric data",
        "Retracted this session: —",
        'Record presence ONLY for the verified list. Names in the second list may appear as "asked for", "talked about", never as "was here".',
      ].join("\n"),
    );
  });

  it("uses an em dash for every empty list", () => {
    const empty = renderPresenceLists({ verified: [], unverified: [], retracted: [] });
    expect(empty).toContain("Present (verified): —");
    expect(empty).toContain("Mentioned or guessed, NOT verified present: —");
    expect(empty).toContain("Retracted this session: —");
  });

  it("renders the retracted list with its reason", () => {
    const block = renderPresenceLists({
      verified: [],
      unverified: [],
      retracted: [
        { entityType: "contact", entityId: "sis", name: "אופק", relationship: "Sister", status: "retracted", reason: "retracted by a human correction" },
      ],
    });
    expect(block).toContain("Retracted this session: אופק (Sister) — retracted by a human correction");
  });

  it("is fed straight from the ledger", () => {
    const ledger = makeLedger(true);
    ledger.addEvidence(MOTHER, { channel: "human_confirm", polarity: "for", strength: "strong", at: 0 });
    ledger.addEvidence(THERAPIST, { channel: "observer_visual", polarity: "for", strength: "weak", at: 0 });
    ledger.addEvidence(SISTER, { channel: "speech_attribution", polarity: "for", strength: "weak", at: 0 });
    const block = renderPresenceLists(ledger.lists(1000));
    expect(block).toContain("Present (verified): שחף, ליאת (Mother)");
    expect(block).toContain("Giti (Therapist) — Observer guess, no biometric data");
    expect(block).toContain("אופק (Sister) — speech label only");
  });
});

// ============================================================================
// The durable-write validator
// ============================================================================

describe("checkDurablePresenceWrite", () => {
  const lists: PresenceLists = {
    verified: [
      { entityType: "student", entityId: "s1", name: "שחף", status: "assumed", reason: "the student — occupant of the device" },
      { entityType: "contact", entityId: "mom", name: "ליאת", relationship: "Mother", status: "corroborated", reason: "corroborated by face + voice" },
    ],
    unverified: [
      { entityType: "contact", entityId: "sis", name: "אופק", relationship: "Sister", status: "hypothesized", reason: "face lookalike of שחף" },
      { entityType: "contact", entityId: "g", name: "Giti", status: "hypothesized", reason: "Observer guess" },
    ],
    retracted: [
      { entityType: "contact", entityId: "b", name: "יובל", relationship: "Brother", status: "retracted", reason: "retracted by a human correction" },
    ],
  };

  it("rejects Hebrew presence claims about an unverified name, naming the token", () => {
    for (const text of [
      "אופק הצטרפה לחדר",
      "אופק נכנסה לחדר עם מים",
      "היום אופק הגיעה לבקר",
      "אופק נוכחת בסלון",
      "אופק הייתה כאן אחר הצהריים",
      "בסלון נמצאת אופק",
    ]) {
      const res = checkDurablePresenceWrite(text, lists);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.token).toBe("אופק");
        expect(res.reason).toContain("אופק");
        expect(res.reason).toContain("not verified present this session");
      }
    }
  });

  it("rejects English presence claims", () => {
    for (const text of [
      "Giti joined the session at 10:40.",
      "Giti was here for most of the call.",
      "Giti arrived with the student.",
      "Giti entered the room.",
      "Giti came in halfway through.",
      "Giti showed up after lunch.",
      "Giti is here now.",
      "Present: Giti and the student.",
    ]) {
      const res = checkDurablePresenceWrite(text, lists);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.token).toBe("Giti");
    }
  });

  it("rejects a claim about a RETRACTED name too", () => {
    const res = checkDurablePresenceWrite("יובל הגיע לחדר", lists);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.token).toBe("יובל");
  });

  it("passes talk ABOUT an unverified person", () => {
    for (const text of [
      "שחף ביקשה את אופק",
      "שחף דיברה על אופק כל הבוקר",
      "The student asked for Giti several times.",
      "She talked about Giti and wanted Giti to call.",
      "שחף רוצה את אופק",
      "אופק — נזכרה בשיחה, לא אומתה",
    ]) {
      expect(checkDurablePresenceWrite(text, lists)).toEqual({ ok: true });
    }
  });

  it("passes presence claims about VERIFIED people", () => {
    expect(checkDurablePresenceWrite("ליאת הגיעה לחדר בשעה 10", lists)).toEqual({ ok: true });
    expect(checkDurablePresenceWrite("שחף נמצאת מול המכשיר", lists)).toEqual({ ok: true });
  });

  it("passes when the verb is far away from the name", () => {
    const far = `Giti${" ".repeat(90)}was mentioned. The mother arrived at ten.`;
    expect(checkDurablePresenceWrite(far, lists)).toEqual({ ok: true });
  });

  it("passes empty text and text with no verbs at all", () => {
    expect(checkDurablePresenceWrite("", lists)).toEqual({ ok: true });
    expect(checkDurablePresenceWrite("אופק", lists)).toEqual({ ok: true });
  });

  it("PRESENCE_VERBS matches Hebrew despite \\b being useless there", () => {
    expect(PRESENCE_VERBS.test("הצטרפה")).toBe(true);
    expect(PRESENCE_VERBS.test("היא נכנסה לחדר")).toBe(true);
    expect(PRESENCE_VERBS.test("joined")).toBe(true);
    expect(PRESENCE_VERBS.test("ביקשה")).toBe(false);
    expect(PRESENCE_VERBS.test("presentation")).toBe(false);
  });
});

// ============================================================================
// Replay of the incident sequence
// ============================================================================

interface ReplayFixture {
  roster: Array<{ who: string; entityType: "student" | "user" | "contact" }>;
  events: Array<{
    t: number;
    kind: "face_match" | "observer" | "transcript" | "speaker_named";
    matched?: boolean;
    who?: string;
    distance?: number;
    borderline?: boolean;
    ambiguousWith?: string;
    runnerUpDistance?: number;
    confidence?: number;
    speaker?: string;
    key?: string;
    updateType?: string;
  }>;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(path.join(here, "fixtures", "presence-ledger-replay.json"), "utf8"),
) as ReplayFixture;

/** Role label → the Hebrew name and relationship the real roster carries. */
const ROLES: Record<string, { name: string; relationship?: string }> = {
  student: { name: "שחף" },
  sister: { name: "אופק", relationship: "Sister" },
  brother: { name: "יובל", relationship: "Brother" },
  mother: { name: "ליאת", relationship: "Mother" },
  father: { name: "עופר", relationship: "Father" },
  grandmother: { name: "רות", relationship: "Grandmother" },
  grandfather: { name: "משה", relationship: "Grandfather" },
  caregiver: { name: "דנה", relationship: "Caregiver" },
  therapist: { name: "Giti", relationship: "Therapist" },
};

describe("presence ledger — replay of the 2026-08-25 session", () => {
  const TRACK = "cam:user";
  /** In the fixture the roster is keyed by role label, so the sister's entity
   *  id is "sister" (the anonymised replay carries no real ids). */
  const SIS = "sister";

  function buildRoster(): { roster: RosterPerson[]; byRole: Map<string, RosterPerson> } {
    const byRole = new Map<string, RosterPerson>();
    const roster: RosterPerson[] = fixture.roster.map((r, i) => {
      const role = ROLES[r.who] ?? { name: r.who };
      // Student and sister sit 0.46 apart — the measured family number, inside
      // LOOKALIKE_D. Everyone else is nowhere near anyone.
      const samples =
        r.who === "student"
          ? [descriptor(0, 0)]
          : r.who === "sister"
            ? [descriptor(0, 0.46)]
            : [descriptor(i + 1, 5)];
      const person: RosterPerson = {
        entityType: r.entityType,
        entityId: r.who,
        name: role.name,
        ...(role.relationship ? { relationship: role.relationship } : {}),
        faceSamples: samples,
      };
      byRole.set(r.who, person);
      return person;
    });
    return { roster, byRole };
  }

  function run() {
    const { roster, byRole } = buildRoster();
    const ledger = new PresenceLedger();
    ledger.setRoster(roster);
    ledger.setStudent("student");
    const resolver = new TrackIdentityResolver();
    const keyToRole = new Map(roster.map((p) => [entityKey(p.entityType, p.entityId), p.entityId]));
    const sisterStatuses: Array<PresenceStatus | "absent"> = [];
    const sisterRenders: Array<string> = [];
    let last = 0;

    for (const ev of fixture.events) {
      last = ev.t;
      if (ev.kind === "face_match") {
        const best = ev.matched && ev.who ? byRole.get(ev.who)! : undefined;
        const runnerRole = ev.ambiguousWith ? byRole.get(ev.ambiguousWith) : undefined;
        const track = resolver.observe({
          trackId: TRACK,
          at: ev.t,
          cameraRole: "user",
          ...(best ? { best: { entityKey: entityKey(best.entityType, best.entityId), distance: ev.distance! } } : {}),
          ...(runnerRole && ev.runnerUpDistance !== undefined
            ? {
                runnerUp: {
                  entityKey: entityKey(runnerRole.entityType, runnerRole.entityId),
                  distance: ev.runnerUpDistance,
                },
              }
            : {}),
        });
        if (best && track.entityKey) {
          // The evidence belongs to whoever HOLDS the track, never to whoever
          // won this one batch.
          const incumbent = byRole.get(keyToRole.get(track.entityKey)!)!;
          ledger.addEvidence(incumbent, {
            channel: "face_match",
            polarity: "for",
            strength: faceEvidenceStrength({
              distance: ev.distance!,
              borderline: ev.borderline ?? true,
              ...(ev.runnerUpDistance !== undefined ? { runnerUpDistance: ev.runnerUpDistance } : {}),
              ...(ev.ambiguousWith ? { ambiguousWith: ev.ambiguousWith } : {}),
            }),
            trackId: TRACK,
            at: ev.t,
            detail: { distance: ev.distance!, confidence: ev.confidence ?? 0 },
          });
        }
      } else if (ev.kind === "observer" && ev.key) {
        ledger.addEvidence(byRole.get(ev.key)!, {
          channel: "observer_visual",
          polarity: "for",
          strength: "weak",
          at: ev.t,
        });
      } else if (ev.kind === "transcript" && ev.speaker && ev.speaker !== "UNKNOWN" && ev.speaker !== "student") {
        ledger.addEvidence(byRole.get(ev.speaker)!, {
          channel: "speech_attribution",
          polarity: "for",
          strength: "weak",
          at: ev.t,
        });
      }

      // The coordinator's decay pass runs on a timer through the whole session.
      ledger.tick(ev.t);

      sisterStatuses.push(ledger.statusOf("contact", SIS));
      const sister = ledger.get("contact", SIS);
      if (sister) sisterRenders.push(renderPerson(sister, "speaker", { now: ev.t }));
    }
    return { ledger, sisterStatuses, sisterRenders, last };
  }

  it("never lets the sister past a hypothesis, at any point in the session", () => {
    const { sisterStatuses } = run();
    expect(sisterStatuses.length).toBeGreaterThan(0);
    for (const s of sisterStatuses) {
      expect(["absent", "hypothesized"]).toContain(s);
      expect(isStatusAtLeast(s, "corroborated")).toBe(false);
    }
  });

  it("keeps the face track on the student, so her face is never split into two people", () => {
    const { ledger } = run();
    const sister = ledger.get("contact", SIS)!;
    expect(sister.evidence.some((e) => e.channel === "face_match")).toBe(false);
    expect(ledger.statusOf("student", "student")).toBe("assumed");
  });

  it("lists her as mentioned-but-unverified, with the lookalike as the reason", () => {
    const { ledger, last } = run();
    const lists = ledger.lists(last);
    expect(lists.verified.map((i) => i.name)).not.toContain("אופק");
    const item = lists.unverified.find((i) => i.name === "אופק");
    expect(item).toBeDefined();
    expect(item!.reason).toContain("lookalike");
    expect(item!.reason).toContain("שחף");
    expect(item!.reason).toMatch(/speech label/);
  });

  it("survives the whole session's decay passes, while dropping out of `current`", () => {
    // Her last mention is ~4.8 min before the session ends — four hypothesis
    // TTLs. The ledger must still be able to tell the Monitor she was talked
    // about, and must not be listing her as in the room.
    const { ledger, last } = run();
    const sister = ledger.get("contact", SIS);
    expect(sister).toBeDefined();
    expect(sister!.stale).toBe(true);
    expect(ledger.isCurrent("contact", SIS, last)).toBe(false);
    expect(ledger.current(last).map((e) => e.entityId)).toEqual(["student"]);
    expect(ledger.lists(last).unverified.map((i) => i.name)).toContain("אופק");
    expect(renderPresenceLists(ledger.lists(last))).toContain("אופק (Sister) — face lookalike of שחף");
  });

  it("gives the Speaker no name for her, ever", () => {
    const { sisterRenders } = run();
    expect(sisterRenders.length).toBeGreaterThan(0);
    for (const r of sisterRenders) expect(r).toBe("someone nearby");
  });

  it("blocks the durable write that actually happened, and allows the true one", () => {
    const { ledger, last } = run();
    const lists = ledger.lists(last);
    const bad = checkDurablePresenceWrite("אופק הצטרפה לחדר", lists);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.token).toBe("אופק");
    expect(checkDurablePresenceWrite("שחף ביקשה את אופק", lists)).toEqual({ ok: true });
  });

  it("snapshots the whole session, bounded", () => {
    const { ledger } = run();
    const snap = ledger.snapshot();
    expect(JSON.parse(JSON.stringify(snap))).toEqual(snap);
    for (const e of snap.entries) expect(e.evidence.length).toBeLessThanOrEqual(PRESENCE_LEDGER_DEFAULTS.evidenceRing);
  });
});
