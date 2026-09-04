// The session-end / durable-write side of the presence ledger
// (planning-docs/aac-presence-ledger.md §6.1, §6.2, §9.5).
//
// INCIDENT, 2026-09-03: a student was at home with her parents. The face
// matcher nominated her SISTER (min gallery distance 0.4527 — well inside the
// 0.6 match threshold), the Observer confirmed the nomination it had just been
// shown, the Speaker greeted the sister aloud, and the session summary recorded
// "a person named <sister> joined and reported her identity". Only the student
// was in the room. The sister's name then sat in permanent records that are
// re-injected into every future session.
//
// The prompt already said "presence is EVIDENCE-GATED". Prose could not hold
// it: a hedge addressed to one model never survives that model's output. So the
// durable writes are gated in CODE, against a list the ledger builds — and the
// refusal NAMES THE TOKEN, because the board validator proved that feedback
// without the token produces 139 rejected rebuilds in a row.
//
// Everything here is DB-free: the registry is pure, and the Student_* memory
// ops are write-back no-ops whose only real work is the two guards below.

import { describe, it, expect, afterEach } from "@jest/globals";
import {
  PresenceLedger,
  renderPresenceLists,
  type PresenceLists,
} from "@shared/aac/presence-ledger";
import {
  setPresenceListsProvider,
  clearPresenceListsProvider,
  getPresenceLists,
  presenceProviderCount,
  presenceContextForSession,
  presenceContextFromSnapshot,
  presenceListsFromSnapshot,
  checkPresenceSafe,
  assertPresenceSafe,
  contactProvenanceFor,
  isRetractedName,
  retractedContactRefusal,
  presenceAtLeast,
} from "../services/memory-schema/presence-context.js";
import {
  STUDENT_NOTES_FIELD,
  STUDENT_PEOPLE_FIELD,
  STUDENT_INTERESTS_FIELD,
} from "../services/memory-schema/student-memory-schema.js";
import { promptNoteToday } from "../services/memory-schema/aac-memory-schema.js";
import type { DBOperationContext } from "../services/chat/memory-types.js";

// ── fixtures ────────────────────────────────────────────────────────────────

const SESSION = "sess-0904028e";
const STUDENT = "student-shahaf";

/** A ledger shaped like the incident: the student assumed present, the sister
 *  hypothesized off a lookalike face match, a third name struck by the
 *  Observer's own retraction. */
function incidentLedger(now = Date.now()): PresenceLedger {
  const ledger = new PresenceLedger();
  ledger.setRoster([
    { entityType: "student", entityId: STUDENT, name: "Shahaf" },
    { entityType: "contact", entityId: "c-ofek", name: "Ofek", relationship: "Sister" },
    { entityType: "contact", entityId: "c-liat", name: "Liat", relationship: "Mother" },
    { entityType: "contact", entityId: "c-giti", name: "Giti", relationship: "Aide" },
  ]);
  ledger.setStudent(STUDENT);

  // Mother: a human said so. The only channel that confirms outright.
  ledger.addEvidence(
    { entityType: "contact", entityId: "c-liat", name: "Liat", relationship: "Mother" },
    { channel: "human_confirm", polarity: "for", strength: "strong", at: now - 1000 },
  );
  // Sister: one weak face match. This is the guess the whole design exists for.
  ledger.addEvidence(
    { entityType: "contact", entityId: "c-ofek", name: "Ofek", relationship: "Sister" },
    { channel: "face_match", polarity: "for", strength: "weak", at: now - 500, detail: { distance: 0.46 } },
  );
  // Aide: named once, then struck.
  ledger.addEvidence(
    { entityType: "contact", entityId: "c-giti", name: "Giti", relationship: "Aide" },
    { channel: "observer_visual", polarity: "for", strength: "weak", at: now - 400 },
  );
  ledger.addEvidence(
    { entityType: "contact", entityId: "c-giti", name: "Giti", relationship: "Aide" },
    { channel: "observer_retraction", polarity: "against", strength: "strong", at: now - 100 },
  );
  return ledger;
}

function register(lists: PresenceLists, sessionId = SESSION): void {
  setPresenceListsProvider(sessionId, () => lists);
}

function makeCtx(extra: Record<string, any> = {}): DBOperationContext {
  const base = { studentId: STUDENT, accessCtx: { kind: "student", studentId: STUDENT }, ...extra };
  return {
    base,
    inherited: {},
    get all() {
      return base;
    },
    path: "/Student_Notes",
    pathTokens: ["Student_Notes"],
  } as DBOperationContext;
}

afterEach(() => {
  clearPresenceListsProvider(SESSION);
  clearPresenceListsProvider("other-session");
});

// ── the registry ────────────────────────────────────────────────────────────

describe("presence-lists registry", () => {
  it("hands back the lists the coordinator registered, live", () => {
    const ledger = incidentLedger();
    setPresenceListsProvider(SESSION, () => ledger.lists());

    const lists = getPresenceLists(SESSION)!;
    expect(lists.verified.map((i) => i.name).sort()).toEqual(["Liat", "Shahaf"]);
    expect(lists.unverified.map((i) => i.name)).toEqual(["Ofek"]);
    expect(lists.retracted.map((i) => i.name)).toEqual(["Giti"]);
  });

  it("is a PROVIDER, not a snapshot — a retraction at minute 30 is seen", () => {
    const ledger = incidentLedger();
    setPresenceListsProvider(SESSION, () => ledger.lists());
    expect(getPresenceLists(SESSION)!.unverified.map((i) => i.name)).toEqual(["Ofek"]);

    ledger.addEvidence(
      { entityType: "contact", entityId: "c-ofek", name: "Ofek" },
      { channel: "human_confirm", polarity: "against", strength: "strong" },
    );
    expect(getPresenceLists(SESSION)!.retracted.map((i) => i.name).sort()).toEqual(["Giti", "Ofek"]);
  });

  it("is keyed by SESSION, not student — an overlapping session sees nothing", () => {
    register(incidentLedger().lists());
    expect(getPresenceLists("other-session")).toBeUndefined();
    expect(presenceContextForSession("other-session")).toBe("");
  });

  it("clear removes the provider and leaves no leak behind", () => {
    const before = presenceProviderCount();
    register(incidentLedger().lists());
    expect(presenceProviderCount()).toBe(before + 1);
    clearPresenceListsProvider(SESSION);
    expect(presenceProviderCount()).toBe(before);
    expect(getPresenceLists(SESSION)).toBeUndefined();
  });

  it("no provider ⇒ undefined and an empty block (the feature is off)", () => {
    expect(getPresenceLists(SESSION)).toBeUndefined();
    expect(getPresenceLists(undefined)).toBeUndefined();
    expect(presenceContextForSession(SESSION)).toBe("");
    expect(presenceContextForSession(undefined)).toBe("");
  });

  it("a provider that THROWS reads as off — a broken ledger cannot kill a write", () => {
    setPresenceListsProvider(SESSION, () => {
      throw new Error("ledger exploded");
    });
    expect(getPresenceLists(SESSION)).toBeUndefined();
    expect(presenceContextForSession(SESSION)).toBe("");
  });

  it("a provider returning a malformed object reads as off", () => {
    setPresenceListsProvider(SESSION, (() => ({ verified: [] })) as any);
    expect(getPresenceLists(SESSION)).toBeUndefined();
  });

  it("renders the §6.1 block, naming the unverified guess and its reason", () => {
    register(incidentLedger().lists());
    const block = presenceContextForSession(SESSION);
    expect(block).toContain("[PRESENCE — system verified]");
    expect(block).toContain("Present (verified): ");
    expect(block).toContain("Liat (Mother)");
    // The sister appears — the Monitor must know the name was raised — but
    // only in the "NOT verified present" line, with the reason attached.
    expect(block).toMatch(/Mentioned or guessed, NOT verified present:.*Ofek \(Sister\)/);
    expect(block).toMatch(/Retracted this session:.*Giti/);
    expect(block).toBe(renderPresenceLists(getPresenceLists(SESSION)!));
  });
});

// ── snapshot parsing (the close summary's source) ────────────────────────────

describe("presenceListsFromSnapshot", () => {
  it("rebuilds the lists from a real ledger snapshot", () => {
    const snap = incidentLedger().snapshot();
    const lists = presenceListsFromSnapshot(snap)!;
    expect(lists.verified.map((i) => i.name).sort()).toEqual(["Liat", "Shahaf"]);
    expect(lists.unverified.map((i) => i.name)).toEqual(["Ofek"]);
    expect(lists.retracted.map((i) => i.name)).toEqual(["Giti"]);
  });

  it("survives a JSON round trip (it arrives as jsonb, not as an object)", () => {
    const snap = JSON.parse(JSON.stringify(incidentLedger().snapshot()));
    const block = presenceContextFromSnapshot(snap);
    expect(block).toContain("[PRESENCE — system verified]");
    expect(block).toContain("Ofek (Sister)");
  });

  it("returns undefined for garbage rather than throwing into the summary path", () => {
    for (const junk of [null, undefined, "", "hello", 42, [], {}, { entries: "nope" }, { version: 1 }]) {
      expect(presenceListsFromSnapshot(junk as unknown)).toBeUndefined();
      expect(presenceContextFromSnapshot(junk as unknown)).toBe("");
    }
  });

  it("returns undefined for a ledger that recorded nobody — an empty list is not a fact", () => {
    // A column written by a ledger that never ran must not be presented as
    // "nobody was here": never-looked is not nothing-there.
    expect(presenceListsFromSnapshot({ version: 1, createdAt: Date.now(), entries: [] })).toBeUndefined();
  });
});

// ── the durable-write validator ─────────────────────────────────────────────

describe("checkPresenceSafe / assertPresenceSafe", () => {
  const PRESENT_CLAIM = "Ofek joined the session and played with her sister.";

  it("passes everything when the session has no ledger (feature off)", () => {
    expect(checkPresenceSafe(PRESENT_CLAIM, SESSION)).toEqual({ ok: true });
    expect(() => assertPresenceSafe(PRESENT_CLAIM, SESSION)).not.toThrow();
  });

  it("refuses a presence claim about an UNVERIFIED name", () => {
    register(incidentLedger().lists());
    const verdict = checkPresenceSafe(PRESENT_CLAIM, SESSION);
    expect(verdict.ok).toBe(false);
    expect((verdict as any).token).toBe("Ofek");
  });

  it("NAMES THE TOKEN in the thrown message, and says what to write instead", () => {
    register(incidentLedger().lists());
    let msg = "";
    try {
      assertPresenceSafe(PRESENT_CLAIM, SESSION, "this Student_Notes entry");
    } catch (err) {
      msg = (err as Error).message;
    }
    expect(msg).toContain("Ofek");
    expect(msg).toContain("Student_Notes");
    expect(msg).toContain("asked for");
    expect(msg).toContain("talked about");
    // sanitizeDbError only forwards the FIRST line to the AI, so the whole
    // refusal has to fit on one.
    expect(msg.split("\n")).toHaveLength(1);
  });

  it("refuses a RETRACTED name too", () => {
    register(incidentLedger().lists());
    const verdict = checkPresenceSafe("Giti was here this afternoon.", SESSION);
    expect(verdict.ok).toBe(false);
    expect((verdict as any).token).toBe("Giti");
  });

  it("lets the same name through without a presence claim", () => {
    register(incidentLedger().lists());
    expect(checkPresenceSafe("She asked for Ofek twice.", SESSION)).toEqual({ ok: true });
    expect(checkPresenceSafe("We talked about Ofek's birthday.", SESSION)).toEqual({ ok: true });
  });

  it("lets a VERIFIED person be recorded as present", () => {
    register(incidentLedger().lists());
    expect(checkPresenceSafe("Liat was here for the whole session.", SESSION)).toEqual({ ok: true });
    expect(checkPresenceSafe("Shahaf arrived at ten.", SESSION)).toEqual({ ok: true });
  });

  it("scans Hebrew, where \\b would silently match nothing", () => {
    const ledger = new PresenceLedger();
    ledger.addEvidence(
      { entityType: "contact", entityId: "c-ofek", name: "אופק", relationship: "אחות" },
      { channel: "face_match", polarity: "for", strength: "weak" },
    );
    register(ledger.lists());
    const verdict = checkPresenceSafe("אופק הגיעה לחדר והצטרפה לשיחה", SESSION);
    expect(verdict.ok).toBe(false);
    expect((verdict as any).token).toBe("אופק");
    expect(checkPresenceSafe("שחף ביקשה את אופק", SESSION)).toEqual({ ok: true });
  });

  it("scans every string inside an object or array entry, not just a top-level string", () => {
    register(incidentLedger().lists());
    const entry = { Name: "Ofek", Relationship: "sister, joined us in the living room" };
    expect(checkPresenceSafe(entry, SESSION).ok).toBe(false);
    expect(checkPresenceSafe([{ note: PRESENT_CLAIM }], SESSION).ok).toBe(false);
  });

  it("ignores empty and non-string values", () => {
    register(incidentLedger().lists());
    for (const v of ["", null, undefined, 7, {}, []]) {
      expect(checkPresenceSafe(v as unknown, SESSION)).toEqual({ ok: true });
    }
  });
});

// ── contact provenance (§6.2) ───────────────────────────────────────────────

describe("contact provenance", () => {
  it("is null when the session has no ledger — a pre-ledger row stays distinguishable", () => {
    expect(contactProvenanceFor("Ofek", SESSION)).toBeNull();
    expect(contactProvenanceFor("Ofek", undefined)).toBeNull();
  });

  it("records the session, the ledger status, the ledger's own reason, and the time", () => {
    register(incidentLedger().lists());
    const at = new Date("2026-09-03T10:11:12.000Z");
    expect(contactProvenanceFor("Liat", SESSION, at)).toEqual({
      sessionId: SESSION,
      presence: "confirmed",
      reason: "confirmed by a human",
      at: "2026-09-03T10:11:12.000Z",
    });
  });

  it("falls back to \"unverified\" / \"Monitor-created\" for a name the ledger never heard", () => {
    register(incidentLedger().lists());
    const p = contactProvenanceFor("A New Therapist", SESSION)!;
    expect(p.presence).toBe("unverified");
    expect(p.reason).toBe("Monitor-created");
    expect(p.sessionId).toBe(SESSION);
    expect(Number.isNaN(Date.parse(p.at))).toBe(false);
  });

  it("carries the reason for an unverified name so the clinician sees the evidence", () => {
    register(incidentLedger().lists());
    const p = contactProvenanceFor("Ofek", SESSION)!;
    expect(p.presence).toBe("hypothesized");
    expect(p.reason).toContain("face");
  });

  it("recognises a retracted name and refuses it by name", () => {
    const lists = incidentLedger().lists();
    expect(isRetractedName(lists, "Giti")).toBe(true);
    expect(isRetractedName(lists, "Ofek")).toBe(false);
    expect(retractedContactRefusal("Giti")).toContain("Giti");
    expect(retractedContactRefusal("Giti")).toContain("RETRACTED");
  });

  it("presenceAtLeast reads the rung ladder off the lists", () => {
    const lists = incidentLedger().lists();
    expect(presenceAtLeast(lists, "Liat", "corroborated")).toBe(true);
    expect(presenceAtLeast(lists, "Ofek", "corroborated")).toBe(false);
    expect(presenceAtLeast(lists, "Ofek", "hypothesized")).toBe(true);
    expect(presenceAtLeast(lists, "Nobody", "hypothesized")).toBe(false);
  });
});

// ── the memory ops that consume all of the above ────────────────────────────

describe("Student_Notes / Student_People write guards", () => {
  const add = (field: typeof STUDENT_NOTES_FIELD, value: unknown, sessionId?: string) =>
    field.db!.add!(makeCtx({ sessionId }), value, {} as any);

  it("stamps a new note with the date it was written", async () => {
    await expect(add(STUDENT_NOTES_FIELD, "Chose the blue board unprompted")).resolves.toBe(
      `[${promptNoteToday()}] Chose the blue board unprompted`,
    );
  });

  it("does not RE-stamp an entry that already carries a date", async () => {
    await expect(add(STUDENT_NOTES_FIELD, "[2026-01-02] an older note")).resolves.toBe(
      "[2026-01-02] an older note",
    );
  });

  it("does not stamp on `write` — rewriting a note must not redate it", async () => {
    const value = ["[2026-01-02] one", "two"];
    await expect(STUDENT_NOTES_FIELD.db!.write!(makeCtx({ sessionId: SESSION }), value)).resolves.toBe(value);
  });

  it("leaves fields that make no presence claim alone", async () => {
    await expect(add(STUDENT_INTERESTS_FIELD, "trampolines")).resolves.toBe("trampolines");
  });

  it("leaves an object People entry unstamped — a relationship has no date", async () => {
    const entry = { Name: "Ofek", Relationship: "sister" };
    await expect(add(STUDENT_PEOPLE_FIELD, entry)).resolves.toBe(entry);
  });

  it("refuses a note claiming an unverified person was present, naming the token", async () => {
    register(incidentLedger().lists());
    await expect(add(STUDENT_NOTES_FIELD, "Ofek came in and sat down.", SESSION)).rejects.toThrow(/Ofek/);
  });

  it("refuses the same claim on `write` (a rewrite launders it just as well)", async () => {
    register(incidentLedger().lists());
    await expect(
      STUDENT_NOTES_FIELD.db!.write!(makeCtx({ sessionId: SESSION }), ["Ofek was here today."]),
    ).rejects.toThrow(/Ofek/);
  });

  it("still writes the same note when the feature is off for the session", async () => {
    await expect(add(STUDENT_NOTES_FIELD, "Ofek came in and sat down.", SESSION)).resolves.toBe(
      `[${promptNoteToday()}] Ofek came in and sat down.`,
    );
  });

  it("still writes it when the note names a VERIFIED person", async () => {
    register(incidentLedger().lists());
    await expect(add(STUDENT_NOTES_FIELD, "Liat came in and sat down.", SESSION)).resolves.toContain(
      "Liat came in",
    );
  });
});
