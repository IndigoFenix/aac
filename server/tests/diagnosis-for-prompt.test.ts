/**
 * Pins the gated diagnosis loader (server/services/dual-agent/diagnosis-for-prompt.ts)
 * — AKIM §14 / §5.8.
 *
 * What this replaces: three bare `select primary_diagnosis from medical_records`
 * calls in dual-agent-service.ts that fed the Gemini Live system prompt with no
 * privacy check, no status filter and no audit row — one of them for EVERY
 * child on a classroom roster. The properties below are the whole fix, so they
 * are tested at the level where they can actually regress.
 *
 * DB-free: reads and the log sink are injected.
 */

import { describe, it, expect } from "@jest/globals";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  DIAGNOSIS_PROMPT_ROUTE,
  loadDiagnosesForPrompt,
  loadDiagnosisForPrompt,
  type DiagnosisPromptDeps,
  type DiagnosisCandidate,
  pickDiagnosisRecord,
} from "../services/dual-agent/diagnosis-for-prompt.js";
import { ReadCoalescer } from "../middleware/phi-read-audit.js";
import type { ActivityLogEntry } from "../services/activityLogService.js";

const ALICE = "11111111-1111-1111-1111-111111111111";
const BOB = "22222222-2222-2222-2222-222222222222";
const CARA = "33333333-3333-3333-3333-333333333333";

interface Harness {
  deps: DiagnosisPromptDeps;
  logged: ActivityLogEntry[];
  diagnosisCalls: string[][];
  settingsCalls: string[][];
}

function harness(opts: {
  records?: DiagnosisCandidate[];
  settings?: Record<string, boolean>;
  coalescer?: ReadCoalescer;
} = {}): Harness {
  const logged: ActivityLogEntry[] = [];
  const diagnosisCalls: string[][] = [];
  const settingsCalls: string[][] = [];
  const records = opts.records ?? [];
  return {
    logged,
    diagnosisCalls,
    settingsCalls,
    deps: {
      readDiagnosisCandidates: async (ids) => {
        diagnosisCalls.push([...ids]);
        return records.filter((f) => ids.includes(f.studentId));
      },
      readAllowReadReports: async (ids) => {
        settingsCalls.push([...ids]);
        const out = new Map<string, boolean>();
        for (const id of ids) {
          const v = opts.settings?.[id];
          if (v !== undefined) out.set(id, v);
        }
        return out;
      },
      log: (entry) => { logged.push(entry); },
      coalescer: opts.coalescer ?? new ReadCoalescer(),
    },
  };
}

describe("loadDiagnosisForPrompt — the privacy gate", () => {
  it("returns null and issues NO read when allowReadReports is false", async () => {
    const h = harness({ records: [{ studentId: ALICE, primaryDiagnosis: "Rett syndrome" }] });
    const got = await loadDiagnosisForPrompt(
      { studentId: ALICE, allowReadReports: false, sessionId: "s1" },
      h.deps,
    );
    expect(got).toBeNull();
    // The point is that the record is never TOUCHED — a read whose result is
    // discarded is still a read, and would still be a disclosure.
    expect(h.diagnosisCalls).toEqual([]);
    expect(h.logged).toEqual([]);
  });

  it("reads when the switch is on", async () => {
    const h = harness({ records: [{ studentId: ALICE, primaryDiagnosis: "Rett syndrome" }] });
    const got = await loadDiagnosisForPrompt(
      { studentId: ALICE, allowReadReports: true, sessionId: "s1" },
      h.deps,
    );
    expect(got).toBe("Rett syndrome");
    expect(h.diagnosisCalls).toEqual([[ALICE]]);
  });

  it("treats an absent setting as permitted (column default is true)", async () => {
    // NOT NULL DEFAULT true; a student with no aac_settings row must behave
    // like the default, matching the `!== false` convention used elsewhere.
    const h = harness({ records: [{ studentId: ALICE, primaryDiagnosis: "Rett syndrome" }] });
    const got = await loadDiagnosisForPrompt({ studentId: ALICE, sessionId: "s1" }, h.deps);
    expect(got).toBe("Rett syndrome");
    expect(h.settingsCalls).toEqual([[ALICE]]);
  });

  it("looks the setting up when the caller did not supply it", async () => {
    const h = harness({
      records: [{ studentId: ALICE, primaryDiagnosis: "Rett syndrome" }],
      settings: { [ALICE]: false },
    });
    const got = await loadDiagnosisForPrompt({ studentId: ALICE, sessionId: "s1" }, h.deps);
    expect(got).toBeNull();
    expect(h.settingsCalls).toEqual([[ALICE]]);
    expect(h.diagnosisCalls).toEqual([]);
  });

  it("does not look the setting up when the caller supplied it", async () => {
    const h = harness({ records: [{ studentId: ALICE, primaryDiagnosis: "Rett syndrome" }] });
    await loadDiagnosisForPrompt(
      { studentId: ALICE, allowReadReports: true, sessionId: "s1" },
      h.deps,
    );
    expect(h.settingsCalls).toEqual([]);
  });

  it("returns null when there is no usable record", async () => {
    const h = harness({ records: [] });
    const got = await loadDiagnosisForPrompt(
      { studentId: ALICE, allowReadReports: true, sessionId: "s1" },
      h.deps,
    );
    expect(got).toBeNull();
    expect(h.logged).toEqual([]); // nothing was disclosed, nothing to record
  });

  it("never throws — a failed read degrades the prompt, not the session", async () => {
    const h = harness();
    h.deps.readDiagnosisCandidates = async () => { throw new Error("db down"); };
    await expect(
      loadDiagnosisForPrompt({ studentId: ALICE, allowReadReports: true }, h.deps),
    ).resolves.toBeNull();
  });
});

/**
 * Which record speaks. Clinical records sit in `draft` indefinitely — on
 * staging 7 of 9 medical records are drafts and exactly one is final — so a
 * `status = 'final'` filter would have silently emptied the diagnosis out of
 * almost every live prompt. `superseded` is the only status that means "do not
 * use this record", and it is the only one excluded.
 */
describe("record selection", () => {
  it("a draft-only student still yields the diagnosis", async () => {
    const h = harness({
      records: [{ studentId: ALICE, primaryDiagnosis: "Rett syndrome", status: "draft" }],
    });
    await expect(
      loadDiagnosisForPrompt({ studentId: ALICE, allowReadReports: true }, h.deps),
    ).resolves.toBe("Rett syndrome");
  });

  it("pending_review counts too", async () => {
    const h = harness({
      records: [{ studentId: ALICE, primaryDiagnosis: "Rett syndrome", status: "pending_review" }],
    });
    await expect(
      loadDiagnosisForPrompt({ studentId: ALICE, allowReadReports: true }, h.deps),
    ).resolves.toBe("Rett syndrome");
  });

  it("a superseded-only student yields null", async () => {
    const h = harness({
      records: [{ studentId: ALICE, primaryDiagnosis: "Old diagnosis", status: "superseded" }],
    });
    await expect(
      loadDiagnosisForPrompt({ studentId: ALICE, allowReadReports: true }, h.deps),
    ).resolves.toBeNull();
    expect(h.logged).toEqual([]); // nothing was disclosed
  });

  it("final beats draft even when the draft is newer", () => {
    const picked = pickDiagnosisRecord([
      { studentId: ALICE, primaryDiagnosis: "Draft guess", status: "draft", updatedAt: new Date("2026-08-01") },
      { studentId: ALICE, primaryDiagnosis: "Rett syndrome", status: "final", updatedAt: new Date("2026-01-01") },
    ]);
    expect(picked?.primaryDiagnosis).toBe("Rett syndrome");
  });

  it("among equals, the most recently touched wins", () => {
    const picked = pickDiagnosisRecord([
      { studentId: ALICE, primaryDiagnosis: "Older", status: "draft", updatedAt: new Date("2026-01-01") },
      { studentId: ALICE, primaryDiagnosis: "Newer", status: "draft", updatedAt: new Date("2026-08-01") },
    ]);
    expect(picked?.primaryDiagnosis).toBe("Newer");
  });

  it("falls back to createdAt when updatedAt is absent, and never picks superseded", () => {
    const picked = pickDiagnosisRecord([
      { studentId: ALICE, primaryDiagnosis: "Retired", status: "superseded", updatedAt: new Date("2027-01-01") },
      { studentId: ALICE, primaryDiagnosis: "Older", status: "draft", createdAt: new Date("2026-01-01") },
      { studentId: ALICE, primaryDiagnosis: "Newer", status: "draft", createdAt: new Date("2026-08-01") },
    ]);
    expect(picked?.primaryDiagnosis).toBe("Newer");
  });

  it("returns null on an empty candidate list", () => {
    expect(pickDiagnosisRecord([])).toBeNull();
  });
});

describe("the audit row", () => {
  it("records a view on medical_record / student, AI-initiated", async () => {
    const h = harness({
      records: [{ studentId: ALICE, primaryDiagnosis: "Rett syndrome", instituteId: "inst-9" }],
    });
    await loadDiagnosisForPrompt(
      { studentId: ALICE, allowReadReports: true, sessionId: "s1", userId: "user-7" },
      h.deps,
    );
    expect(h.logged).toHaveLength(1);
    expect(h.logged[0]).toMatchObject({
      userId: "user-7",
      instituteId: "inst-9",
      eventType: "view",
      subjectType1: "medical_record",
      subjectType2: "student",
      subjectId2: ALICE,
      isAiInitiated: true,
      details: { route: DIAGNOSIS_PROMPT_ROUTE, sessionId: "s1" },
    });
  });

  it("prefers a caller-supplied instituteId over the record's", async () => {
    const h = harness({
      records: [{ studentId: ALICE, primaryDiagnosis: "Rett", instituteId: "inst-record" }],
    });
    await loadDiagnosisForPrompt(
      { studentId: ALICE, allowReadReports: true, instituteId: "inst-session" },
      h.deps,
    );
    expect(h.logged[0].instituteId).toBe("inst-session");
  });

  it("never carries the diagnosis text itself", async () => {
    const h = harness({ records: [{ studentId: ALICE, primaryDiagnosis: "Rett syndrome" }] });
    await loadDiagnosisForPrompt({ studentId: ALICE, allowReadReports: true }, h.deps);
    expect(JSON.stringify(h.logged)).not.toContain("Rett syndrome");
  });
});

describe("coalescing", () => {
  it("logs once per (student, session) inside the window", async () => {
    const coalescer = new ReadCoalescer();
    const h = harness({
      records: [{ studentId: ALICE, primaryDiagnosis: "Rett syndrome" }],
      coalescer,
    });
    for (let i = 0; i < 4; i++) {
      await loadDiagnosisForPrompt(
        { studentId: ALICE, allowReadReports: true, sessionId: "s1" },
        h.deps,
      );
    }
    expect(h.logged).toHaveLength(1);
  });

  it("logs again for a NEW session — a new session is a new access", async () => {
    const coalescer = new ReadCoalescer();
    const h = harness({
      records: [{ studentId: ALICE, primaryDiagnosis: "Rett syndrome" }],
      coalescer,
    });
    await loadDiagnosisForPrompt({ studentId: ALICE, allowReadReports: true, sessionId: "s1" }, h.deps);
    await loadDiagnosisForPrompt({ studentId: ALICE, allowReadReports: true, sessionId: "s2" }, h.deps);
    expect(h.logged).toHaveLength(2);
  });

  it("does not collapse two students onto one row", async () => {
    const coalescer = new ReadCoalescer();
    const h = harness({
      records: [
        { studentId: ALICE, primaryDiagnosis: "Rett syndrome" },
        { studentId: BOB, primaryDiagnosis: "Cerebral palsy" },
      ],
      coalescer,
    });
    await loadDiagnosesForPrompt(
      [
        { studentId: ALICE, allowReadReports: true, sessionId: "s1" },
        { studentId: BOB, allowReadReports: true, sessionId: "s1" },
      ],
      h.deps,
    );
    expect(h.logged.map((e) => e.subjectId2).sort()).toEqual([ALICE, BOB].sort());
  });
});

describe("the classroom roster", () => {
  it("honours each child's OWN setting", async () => {
    // The bug being fixed: a shared classroom device read every enrolled
    // child's diagnosis into one prompt, whatever their families had chosen.
    const h = harness({
      records: [
        { studentId: ALICE, primaryDiagnosis: "Rett syndrome" },
        { studentId: BOB, primaryDiagnosis: "Cerebral palsy" },
        { studentId: CARA, primaryDiagnosis: "Angelman syndrome" },
      ],
      settings: { [BOB]: false },
    });
    const got = await loadDiagnosesForPrompt(
      [
        { studentId: ALICE, sessionId: "s1" },
        { studentId: BOB, sessionId: "s1" },
        { studentId: CARA, sessionId: "s1" },
      ],
      h.deps,
    );
    expect(got.get(ALICE)).toBe("Rett syndrome");
    expect(got.get(CARA)).toBe("Angelman syndrome");
    expect(got.has(BOB)).toBe(false);
    // Bob's record is not even included in the query.
    expect(h.diagnosisCalls).toEqual([[ALICE, CARA]]);
    expect(h.logged).toHaveLength(2);
  });

  it("issues no read at all when every child has opted out", async () => {
    const h = harness({
      records: [{ studentId: ALICE, primaryDiagnosis: "Rett syndrome" }],
      settings: { [ALICE]: false, [BOB]: false },
    });
    const got = await loadDiagnosesForPrompt(
      [{ studentId: ALICE }, { studentId: BOB }],
      h.deps,
    );
    expect(got.size).toBe(0);
    expect(h.diagnosisCalls).toEqual([]);
  });

  it("resolves the unknown settings in ONE batch call", async () => {
    const h = harness({ settings: {} });
    await loadDiagnosesForPrompt(
      [
        { studentId: ALICE },
        { studentId: BOB, allowReadReports: true },
        { studentId: CARA },
      ],
      h.deps,
    );
    // Only the two whose setting was not in hand, and only once.
    expect(h.settingsCalls).toEqual([[ALICE, CARA]]);
  });

  it("is a no-op on an empty roster", async () => {
    const h = harness();
    const got = await loadDiagnosesForPrompt([], h.deps);
    expect(got.size).toBe(0);
    expect(h.settingsCalls).toEqual([]);
    expect(h.diagnosisCalls).toEqual([]);
  });
});

/**
 * The behavioural tests above only bind if dual-agent-service actually goes
 * THROUGH the loader. It is a 2000-line file whose three diagnosis reads were
 * three separate copies of the same query, so the failure mode to guard is a
 * fourth copy — or a revert of one of the three — rather than a wrong result.
 * The reads sit deep inside session construction and are not otherwise
 * reachable without a live Gemini session, so this is pinned at the source.
 */
describe("dual-agent-service reads diagnosis only through the loader", () => {
  const src = readFileSync(
    path.join(process.cwd(), "server", "services", "dual-agent", "dual-agent-service.ts"),
    "utf8",
  );

  it("has no bare medicalRecords select left", () => {
    expect(src).not.toMatch(/medicalRecords\./);
    expect(src).not.toMatch(/primaryDiagnosis/);
  });

  it("imports the gated loader", () => {
    expect(src).toMatch(
      /import \{[^}]*loadDiagnosisForPrompt[^}]*\} from "\.\/diagnosis-for-prompt"/,
    );
  });

  it("uses it at all three sites — create, roster and reload", () => {
    const single = src.match(/loadDiagnosisForPrompt\(/g) ?? [];
    const batch = src.match(/loadDiagnosesForPrompt\(/g) ?? [];
    expect(single.length).toBeGreaterThanOrEqual(2); // session create + reload
    expect(batch.length).toBeGreaterThanOrEqual(1);  // classroom roster
  });

  it("passes each roster child's own request rather than a shared flag", () => {
    expect(src).toMatch(/rosterIds\.map\([\s\S]{0,120}?loadDiagnosesForPrompt|loadDiagnosesForPrompt\([\s\S]{0,200}?rosterIds\.map\(/);
  });
});
