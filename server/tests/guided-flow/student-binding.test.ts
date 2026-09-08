/**
 * Which student an unbound GUIDED SETUP flow may adopt.
 *
 * Observed live (clinic account, three patients, Sam selected, 2026-09-08):
 * pressing "New Patient" opened the flow ON SAM, at step 2. Nothing was wrong
 * with the engine — the chat request body simply always carries the currently
 * selected student, and the session's null→value fill-in took it. The wizard
 * for a NEW patient therefore resumed an existing one, showing his consent
 * gate and his half-finished checklist.
 *
 * The rule below is the whole fix, so it is pinned here rather than left to an
 * integration test that has to stand up an institute to reach it: a flow may
 * only adopt a student it plausibly CREATED.
 */

import { describe, it, expect } from "@jest/globals";

import { GUIDED_SETUP_BIND_GRACE_MS, type GuidedSetupRecord } from "@shared/guided-setup";
import {
  canBindStudentToFlow,
  isResumableRecord,
  pickDiscoveredStudent,
} from "../../services/guided-setup/student-setup-binding.js";

const STARTED_AT = "2026-09-08T06:48:35.000Z";
const started = Date.parse(STARTED_AT);
const at = (offsetMs: number) => new Date(started + offsetMs);

describe("canBindStudentToFlow", () => {
  it("never binds the student that was already selected when the flow started", () => {
    expect(
      canBindStudentToFlow({
        inputStudentId: "sam",
        ignoreStudentId: "sam",
        // Even a row created a second ago cannot bind if it is the one the
        // user had on screen — that is the live bug, exactly.
        studentCreatedAt: at(1_000),
        startedAt: STARTED_AT,
      }),
    ).toBe(false);
  });

  it("binds a student created after the flow started", () => {
    expect(
      canBindStudentToFlow({
        inputStudentId: "new-1",
        ignoreStudentId: "sam",
        studentCreatedAt: at(30_000),
        startedAt: STARTED_AT,
      }),
    ).toBe(true);
  });

  it("does not bind a student who pre-dates the flow", () => {
    expect(
      canBindStudentToFlow({
        inputStudentId: "older",
        ignoreStudentId: null,
        studentCreatedAt: at(-86_400_000),
        startedAt: STARTED_AT,
      }),
    ).toBe(false);
  });

  /**
   * The grace absorbs clock skew between the database (`createdAt`) and the
   * app (`startedAt`), plus the turn the client spent opening the flow. It is
   * a window, not a door: one millisecond past it is still a no.
   */
  it("allows the grace window and nothing beyond it", () => {
    const bind = (offsetMs: number) =>
      canBindStudentToFlow({
        inputStudentId: "new-1",
        studentCreatedAt: at(offsetMs),
        startedAt: STARTED_AT,
      });
    expect(bind(0)).toBe(true);
    expect(bind(-GUIDED_SETUP_BIND_GRACE_MS)).toBe(true);
    expect(bind(-GUIDED_SETUP_BIND_GRACE_MS + 1)).toBe(true);
    expect(bind(-GUIDED_SETUP_BIND_GRACE_MS - 1)).toBe(false);
    expect(bind(-GUIDED_SETUP_BIND_GRACE_MS - 5_000)).toBe(false);
  });

  it("honours an explicit grace override", () => {
    expect(
      canBindStudentToFlow({
        inputStudentId: "new-1",
        studentCreatedAt: at(-5_000),
        startedAt: STARTED_AT,
        graceMs: 1_000,
      }),
    ).toBe(false);
  });

  it("takes an ISO string or a Date for either timestamp", () => {
    expect(
      canBindStudentToFlow({
        inputStudentId: "new-1",
        studentCreatedAt: at(5_000).toISOString(),
        startedAt: new Date(started),
      }),
    ).toBe(true);
  });

  /**
   * Everything unverifiable is a NO. Refusing costs nothing — the flow stays
   * unbound and binds on the turn after step 1 creates the student — whereas
   * a wrong yes puts somebody else's PHI behind the wizard.
   */
  it("refuses when it cannot verify", () => {
    const base = { inputStudentId: "new-1", studentCreatedAt: at(5_000) };
    // No student on the request at all.
    expect(canBindStudentToFlow({ ...base, inputStudentId: null, startedAt: STARTED_AT })).toBe(false);
    expect(canBindStudentToFlow({ ...base, inputStudentId: "", startedAt: STARTED_AT })).toBe(false);
    // A session state written before `startedAt` existed.
    expect(canBindStudentToFlow({ ...base })).toBe(false);
    expect(canBindStudentToFlow({ ...base, startedAt: null })).toBe(false);
    // No such student row (deleted, or never there).
    expect(canBindStudentToFlow({ ...base, studentCreatedAt: null, startedAt: STARTED_AT })).toBe(false);
    // Garbage timestamps.
    expect(canBindStudentToFlow({ ...base, startedAt: "not a date" })).toBe(false);
    expect(
      canBindStudentToFlow({ ...base, studentCreatedAt: "not a date", startedAt: STARTED_AT }),
    ).toBe(false);
  });
});

/**
 * Binding may not depend on the MODEL making a UI call.
 *
 * Observed live (clinic, 2026-09-08): the user typed "Her name is Mira Vance,
 * born 12 March 2017", the assistant created the patient (4 → 5) and never
 * called `selectStudent(<new id>)` — which is the only way the next request
 * would have carried her id. The flow stayed unbound: the rail still said
 * "No Patient Selected", `basics.inInstitute` stayed false, the STILL MISSING
 * block never rendered, and the turn went asking about AAC (step 4, behind the
 * consent gate) with gender and HOME LANGUAGE still outstanding.
 *
 * So the server discovers the row itself — through the SAME guard, because a
 * NEW-patient flow must stay unable to reach an existing patient however the
 * candidate arrived.
 */
describe("pickDiscoveredStudent", () => {
  it("binds the student the flow created, with no selectStudent call anywhere", () => {
    expect(
      pickDiscoveredStudent({
        candidate: { id: "mira", createdAt: at(12_000) },
        ignoreStudentId: null,
        startedAt: STARTED_AT,
      }),
    ).toBe("mira");
  });

  it("does not adopt a patient who pre-dates the flow", () => {
    expect(
      pickDiscoveredStudent({
        candidate: { id: "sam", createdAt: at(-86_400_000) },
        startedAt: STARTED_AT,
      }),
    ).toBeNull();
  });

  it("never adopts the patient the user had selected when the flow started", () => {
    // The exact shape of the earlier bug, reached the other way: the newest
    // row in the institute IS the one already on screen.
    expect(
      pickDiscoveredStudent({
        candidate: { id: "sam", createdAt: at(1_000) },
        ignoreStudentId: "sam",
        startedAt: STARTED_AT,
      }),
    ).toBeNull();
  });

  it("returns null when there is no candidate at all", () => {
    expect(pickDiscoveredStudent({ candidate: null, startedAt: STARTED_AT })).toBeNull();
    expect(pickDiscoveredStudent({ startedAt: STARTED_AT })).toBeNull();
    expect(
      pickDiscoveredStudent({ candidate: { id: "", createdAt: at(1_000) }, startedAt: STARTED_AT }),
    ).toBeNull();
  });

  /**
   * Not a second, laxer rule: everything `canBindStudentToFlow` refuses,
   * discovery refuses too — including the grace boundary and an unverifiable
   * timestamp.
   */
  it("is the same decision as canBindStudentToFlow, boundary for boundary", () => {
    const pick = (offsetMs: number, graceMs?: number) =>
      pickDiscoveredStudent({
        candidate: { id: "mira", createdAt: at(offsetMs) },
        startedAt: STARTED_AT,
        ...(graceMs !== undefined ? { graceMs } : {}),
      });
    expect(pick(0)).toBe("mira");
    expect(pick(-GUIDED_SETUP_BIND_GRACE_MS)).toBe("mira");
    expect(pick(-GUIDED_SETUP_BIND_GRACE_MS - 1)).toBeNull();
    expect(pick(-5_000, 1_000)).toBeNull();
    // No flow timestamp, no row timestamp, garbage timestamp: all no.
    expect(pickDiscoveredStudent({ candidate: { id: "mira", createdAt: at(1_000) } })).toBeNull();
    expect(
      pickDiscoveredStudent({ candidate: { id: "mira", createdAt: null }, startedAt: STARTED_AT }),
    ).toBeNull();
    expect(
      pickDiscoveredStudent({
        candidate: { id: "mira", createdAt: "not a date" },
        startedAt: STARTED_AT,
      }),
    ).toBeNull();
  });

  it("takes an ISO string as readily as a Date", () => {
    expect(
      pickDiscoveredStudent({
        candidate: { id: "mira", createdAt: at(5_000).toISOString() },
        startedAt: new Date(started),
      }),
    ).toBe("mira");
  });
});

/**
 * The other half of the same live bug (clinic, 2026-09-08). Because `start` now
 * always begins unbound, the rail's "Continue setup" — which sent `start` —
 * landed unbound too: pressing it on a patient parked at "Medical info —
 * Waiting for consent" opened a fresh step-1 roster flow and the assistant
 * asked for a patient list. The resume is its own request shape now
 * (`GuidedSetupRequest.resumeStudentId`), and this is the decision behind it.
 */
describe("isResumableRecord", () => {
  const record = (over: Partial<GuidedSetupRecord> = {}): GuidedSetupRecord => ({
    v: 1,
    source: "chat",
    startedAt: STARTED_AT,
    startedByUserId: "u1",
    skipped: [],
    ...over,
  });

  it("resumes a record that is merely unfinished", () => {
    expect(isResumableRecord(record())).toBe(true);
    // Mid-flow bookkeeping is not an ending: a skipped step, a reviewed AAC
    // panel and a roster batch all leave the flow open.
    expect(isResumableRecord(record({ skipped: ["medical"] }))).toBe(true);
    expect(isResumableRecord(record({ aacReviewedAt: STARTED_AT }))).toBe(true);
    expect(isResumableRecord(record({ rosterBatchId: "b1" }))).toBe(true);
  });

  it("does not resume a finished record", () => {
    expect(isResumableRecord(record({ completedAt: STARTED_AT }))).toBe(false);
  });

  it("does not resume a dismissed record", () => {
    expect(isResumableRecord(record({ dismissedAt: STARTED_AT }))).toBe(false);
  });

  it("does not resume a student who was never in the flow", () => {
    expect(isResumableRecord(null)).toBe(false);
    expect(isResumableRecord(undefined)).toBe(false);
  });

  /**
   * The rail decides whether to OFFER the button with exactly this test
   * (GuidedSetupRail: `!!record && !record.completedAt && !record.dismissedAt`).
   * If the two ever drift, the button either appears and does nothing, or the
   * turn resumes something the user was never shown.
   */
  it("agrees with the rail's own resumable test on every combination", () => {
    for (const completedAt of [undefined, STARTED_AT]) {
      for (const dismissedAt of [undefined, STARTED_AT]) {
        const r = record({ completedAt, dismissedAt });
        expect(isResumableRecord(r)).toBe(!r.completedAt && !r.dismissedAt);
      }
    }
  });
});
