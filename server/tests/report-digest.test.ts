// Pins the report-digest contract (server/services/aac/report-digest.ts) —
// the ONE way a student's clinical reports reach an AAC session, since
// 2026-09-14. No AAC-session agent may read a report directly any more; this
// module distils the newest FINAL medical/functional/educational report into
// a short list of operational entries and stores them on
// `aac_settings.report_digest`, auditing every report it actually reads.
//
// DB-free: every dependency (readReports, readSettings, writeDigest, extract,
// log, coalescer) is injected, so the contract is exercised without a
// database — see ReportDigestDeps.

import { describe, it, expect } from "@jest/globals";
import {
  ensureReportDigest,
  computeSourceKey,
  EMPTY_SOURCE_KEY,
  normalizeEntries,
  REPORT_DIGEST_MAX_ENTRIES,
  REPORT_DIGEST_ROUTE,
  REPORT_DIGEST_INSTRUCTIONS,
  REPORT_DIGEST_REVISION,
  renderDigestEntries,
  type ReportDigestDeps,
  type ReportDigest,
  type ReportSource,
  type DigestRequest,
} from "../services/aac/report-digest.js";
import { ReadCoalescer } from "../middleware/phi-read-audit.js";
import type { ActivityLogEntry } from "../services/activityLogService.js";

// ──────────────────────────────────────────────────────────────────
// Harness — in-memory settings/reports store + call counters.
// ──────────────────────────────────────────────────────────────────

interface StoredSettings {
  allowReadReports: boolean;
  digest: ReportDigest | null;
}

interface Harness {
  settings: Map<string, StoredSettings>;
  reports: Map<string, ReportSource[]>;
  logged: ActivityLogEntry[];
  reportReadCalls: number;
  extractCalls: number;
  writeDigestCalls: number;
  /** Swap this per-test to control what extract() returns/throws. */
  extractImpl: (sources: ReportSource[], ctx: DigestRequest) => Promise<string[]>;
  deps: ReportDigestDeps;
}

function makeHarness(): Harness {
  const settings = new Map<string, StoredSettings>();
  const reports = new Map<string, ReportSource[]>();
  const logged: ActivityLogEntry[] = [];

  const harness: Harness = {
    settings,
    reports,
    logged,
    reportReadCalls: 0,
    extractCalls: 0,
    writeDigestCalls: 0,
    extractImpl: async (sources) => sources.map((s) => `${s.kind} note`),
    deps: null as unknown as ReportDigestDeps,
  };

  harness.deps = {
    readReports: async (studentId) => {
      harness.reportReadCalls++;
      return reports.get(studentId) ?? [];
    },
    readSettings: async (studentId) => settings.get(studentId) ?? null,
    writeDigest: async (studentId, digest) => {
      harness.writeDigestCalls++;
      const cur = settings.get(studentId);
      settings.set(studentId, { allowReadReports: cur?.allowReadReports ?? true, digest });
    },
    extract: async (sources, ctx) => {
      harness.extractCalls++;
      return harness.extractImpl(sources, ctx);
    },
    log: (entry) => {
      logged.push(entry);
    },
    coalescer: new ReadCoalescer(),
  };

  return harness;
}

function medicalSource(overrides: Partial<ReportSource> = {}): ReportSource {
  return {
    kind: "medical",
    recordId: "med-1",
    instituteId: "inst-1",
    updatedAt: "2026-01-01T00:00:00Z",
    content: { primaryDiagnosis: "Rett syndrome" },
    ...overrides,
  };
}

function functionalSource(overrides: Partial<ReportSource> = {}): ReportSource {
  return {
    kind: "functional",
    recordId: "func-1",
    instituteId: "inst-1",
    updatedAt: "2026-01-01T00:00:00Z",
    content: { mobilityStatus: "wheelchair" },
    ...overrides,
  };
}

function educationalSource(overrides: Partial<ReportSource> = {}): ReportSource {
  return {
    kind: "educational",
    recordId: "edu-1",
    instituteId: "inst-1",
    updatedAt: "2026-01-01T00:00:00Z",
    content: { communicationMode: "AAC device" },
    ...overrides,
  };
}

// ──────────────────────────────────────────────────────────────────
// Gate off — allowReadReports === false
// ──────────────────────────────────────────────────────────────────

describe("ensureReportDigest — gate off (allowReadReports === false)", () => {
  it("explicit false on the request: never reads reports or extracts, clears a stored digest", async () => {
    const h = makeHarness();
    h.reports.set("s1", [medicalSource()]);
    h.settings.set("s1", {
      allowReadReports: true,
      digest: { entries: ["stale"], sourceKey: "k1", generatedAt: "2026-01-01T00:00:00Z" },
    });

    const result = await ensureReportDigest({ studentId: "s1", allowReadReports: false }, h.deps);

    expect(result).toEqual({ entries: [], outcome: "cleared" });
    expect(h.reportReadCalls).toBe(0);
    expect(h.extractCalls).toBe(0);
    expect(h.settings.get("s1")?.digest).toBeNull();
  });

  it("looked-up false (from settings, not the request): same clearing behavior", async () => {
    const h = makeHarness();
    h.reports.set("s1", [medicalSource()]);
    h.settings.set("s1", {
      allowReadReports: false,
      digest: { entries: ["stale"], sourceKey: "k1", generatedAt: "2026-01-01T00:00:00Z" },
    });

    const result = await ensureReportDigest({ studentId: "s1" }, h.deps);

    expect(result).toEqual({ entries: [], outcome: "cleared" });
    expect(h.reportReadCalls).toBe(0);
    expect(h.extractCalls).toBe(0);
    expect(h.settings.get("s1")?.digest).toBeNull();
  });

  it("does not call writeDigest when nothing was stored (looked-up false)", async () => {
    const h = makeHarness();
    h.settings.set("s1", { allowReadReports: false, digest: null });

    const result = await ensureReportDigest({ studentId: "s1" }, h.deps);

    expect(result).toEqual({ entries: [], outcome: "cleared" });
    expect(h.writeDigestCalls).toBe(0);
  });

  it("does not call writeDigest when nothing was stored (explicit false, no settings row)", async () => {
    const h = makeHarness();

    const result = await ensureReportDigest({ studentId: "s1", allowReadReports: false }, h.deps);

    expect(result).toEqual({ entries: [], outcome: "cleared" });
    expect(h.writeDigestCalls).toBe(0);
    expect(h.reportReadCalls).toBe(0);
    expect(h.extractCalls).toBe(0);
  });
});

// ──────────────────────────────────────────────────────────────────
// No final reports
// ──────────────────────────────────────────────────────────────────

describe("ensureReportDigest — no final reports", () => {
  it("writes an empty digest with EMPTY_SOURCE_KEY and never calls extract", async () => {
    const h = makeHarness();

    const result = await ensureReportDigest({ studentId: "s1" }, h.deps);

    expect(result.outcome).toBe("regenerated");
    expect(result.entries).toEqual([]);
    expect(h.extractCalls).toBe(0);
    const stored = h.settings.get("s1");
    expect(stored?.digest?.sourceKey).toBe(EMPTY_SOURCE_KEY);
    expect(stored?.digest?.entries).toEqual([]);
  });
});

// ──────────────────────────────────────────────────────────────────
// Cached
// ──────────────────────────────────────────────────────────────────

describe("ensureReportDigest — cached", () => {
  it("returns the stored digest without reading, extracting or auditing when the sourceKey matches", async () => {
    const h = makeHarness();
    const sources = [medicalSource()];
    h.reports.set("s1", sources);
    const key = computeSourceKey(sources);
    h.settings.set("s1", {
      allowReadReports: true,
      digest: { entries: ["Stay calm during loud noises"], sourceKey: key, generatedAt: "2026-01-01T00:00:00Z" },
    });

    const result = await ensureReportDigest({ studentId: "s1" }, h.deps);

    expect(result.outcome).toBe("cached");
    expect(result.entries).toEqual(["Stay calm during loud noises"]);
    expect(h.extractCalls).toBe(0);
    expect(h.logged).toHaveLength(0);
  });
});

// ──────────────────────────────────────────────────────────────────
// Content changed → regenerate + audit
// ──────────────────────────────────────────────────────────────────

describe("ensureReportDigest — report content changed", () => {
  it("extracts once, audits one view row per report read, and writes the new digest", async () => {
    const h = makeHarness();
    const oldSources = [medicalSource({ content: { primaryDiagnosis: "Old" } })];
    const oldKey = computeSourceKey(oldSources);
    h.settings.set("s1", {
      allowReadReports: true,
      digest: { entries: ["old note"], sourceKey: oldKey, generatedAt: "2026-01-01T00:00:00Z" },
    });

    const newSources = [
      medicalSource({ content: { primaryDiagnosis: "New" } }),
      functionalSource(),
      educationalSource(),
    ];
    h.reports.set("s1", newSources);
    h.extractImpl = async () => ["Never offer peanuts", "Stay calm during loud noises"];

    const req: DigestRequest = { studentId: "s1", sessionId: "sess-A", userId: "u1", instituteId: "inst-1" };
    const result = await ensureReportDigest(req, h.deps);

    expect(result.outcome).toBe("regenerated");
    expect(result.entries).toEqual(["Never offer peanuts", "Stay calm during loud noises"]);
    expect(h.extractCalls).toBe(1);

    expect(h.logged).toHaveLength(3);
    const byKind = new Map(h.logged.map((l) => [l.subjectType1, l]));
    expect(byKind.has("medical_record")).toBe(true);
    expect(byKind.has("functional_report")).toBe(true);
    expect(byKind.has("educational_report")).toBe(true);
    for (const entry of h.logged) {
      expect(entry.eventType).toBe("view");
      expect(entry.isAiInitiated).toBe(true);
      expect(entry.subjectType2).toBe("student");
      expect(entry.subjectId2).toBe("s1");
      expect((entry.details as any)?.route).toBe(REPORT_DIGEST_ROUTE);
    }

    const stored = h.settings.get("s1");
    expect(stored?.digest?.sourceKey).toBe(computeSourceKey(newSources));
    expect(stored?.digest?.entries).toEqual(["Never offer peanuts", "Stay calm during loud noises"]);
  });

  it("also regenerates when only updatedAt changes (same id, same content)", async () => {
    const h = makeHarness();
    const oldSources = [medicalSource({ updatedAt: "2026-01-01T00:00:00Z" })];
    const oldKey = computeSourceKey(oldSources);
    h.settings.set("s1", {
      allowReadReports: true,
      digest: { entries: ["old note"], sourceKey: oldKey, generatedAt: "2026-01-01T00:00:00Z" },
    });
    const newSources = [medicalSource({ updatedAt: "2026-02-01T00:00:00Z" })];
    h.reports.set("s1", newSources);
    h.extractImpl = async () => ["fresh entry"];

    const result = await ensureReportDigest({ studentId: "s1" }, h.deps);

    expect(result.outcome).toBe("regenerated");
    expect(h.extractCalls).toBe(1);
    expect(h.logged).toHaveLength(1);
  });
});

// ──────────────────────────────────────────────────────────────────
// Audit coalescing
// ──────────────────────────────────────────────────────────────────

describe("ensureReportDigest — audit coalescing", () => {
  it("logs once per report per session; a different session logs again", async () => {
    const h = makeHarness();
    const sources = [medicalSource(), functionalSource()];
    h.reports.set("s1", sources);
    h.extractImpl = async () => ["note"];
    h.settings.set("s1", {
      allowReadReports: true,
      digest: { entries: [], sourceKey: "stale-key-1", generatedAt: "2026-01-01T00:00:00Z" },
    });

    const req1: DigestRequest = { studentId: "s1", sessionId: "sess-A", userId: "u1" };
    const r1 = await ensureReportDigest(req1, h.deps);
    expect(r1.outcome).toBe("regenerated");
    expect(h.logged).toHaveLength(2);

    // Force another regeneration (simulating a further content change) within
    // the SAME session — the coalescer must suppress duplicate audit rows.
    const stored1 = h.settings.get("s1")!;
    h.settings.set("s1", { ...stored1, digest: { ...stored1.digest!, sourceKey: "stale-key-2" } });
    const r2 = await ensureReportDigest(req1, h.deps);
    expect(r2.outcome).toBe("regenerated");
    expect(h.extractCalls).toBe(2);
    expect(h.logged).toHaveLength(2); // no new rows — same session, same reports

    // A different session logs again.
    const stored2 = h.settings.get("s1")!;
    h.settings.set("s1", { ...stored2, digest: { ...stored2.digest!, sourceKey: "stale-key-3" } });
    const req2: DigestRequest = { studentId: "s1", sessionId: "sess-B", userId: "u1" };
    const r3 = await ensureReportDigest(req2, h.deps);
    expect(r3.outcome).toBe("regenerated");
    expect(h.logged).toHaveLength(4);
  });
});

// ──────────────────────────────────────────────────────────────────
// Extraction failure
// ──────────────────────────────────────────────────────────────────

describe("ensureReportDigest — force (the clinician's rerun button)", () => {
  it("regenerates even when the sourceKey matches, auditing the reads again", async () => {
    const h = makeHarness();
    const sources = [medicalSource(), functionalSource()];
    h.reports.set("stu-1", sources);
    h.settings.set("stu-1", {
      allowReadReports: true,
      digest: { entries: ["old note"], sourceKey: computeSourceKey(sources), generatedAt: "2026-01-01T00:00:00Z" },
    });
    h.extractImpl = async () => ["fresh note"];

    const r = await ensureReportDigest({ studentId: "stu-1", userId: "u-1", force: true }, h.deps);

    expect(r).toEqual({ entries: ["fresh note"], outcome: "regenerated" });
    expect(h.extractCalls).toBe(1);
    expect(h.writeDigestCalls).toBe(1);
    expect(h.settings.get("stu-1")!.digest!.entries).toEqual(["fresh note"]);
    expect(h.logged.filter((e) => (e.details as any)?.route === REPORT_DIGEST_ROUTE)).toHaveLength(2);
  });

  it("does not bypass the gate: allowReadReports false still clears and never extracts", async () => {
    const h = makeHarness();
    h.reports.set("stu-1", [medicalSource()]);
    h.settings.set("stu-1", {
      allowReadReports: false,
      digest: { entries: ["old note"], sourceKey: "k", generatedAt: "2026-01-01T00:00:00Z" },
    });

    const r = await ensureReportDigest({ studentId: "stu-1", force: true }, h.deps);

    expect(r).toEqual({ entries: [], outcome: "cleared" });
    expect(h.extractCalls).toBe(0);
    expect(h.reportReadCalls).toBe(0);
    expect(h.settings.get("stu-1")!.digest).toBeNull();
  });

  it("keeps the stored digest (stale) when the forced extraction fails", async () => {
    const h = makeHarness();
    const sources = [functionalSource()];
    h.reports.set("stu-1", sources);
    h.settings.set("stu-1", {
      allowReadReports: true,
      digest: { entries: ["old note"], sourceKey: computeSourceKey(sources), generatedAt: "2026-01-01T00:00:00Z" },
    });
    h.extractImpl = async () => { throw new Error("llm down"); };

    const r = await ensureReportDigest({ studentId: "stu-1", force: true }, h.deps);

    expect(r).toEqual({ entries: ["old note"], outcome: "stale" });
    expect(h.writeDigestCalls).toBe(0);
  });
});

describe("ensureReportDigest — extraction failure", () => {
  it("keeps the previous digest (stale) when extract throws and a digest was stored", async () => {
    const h = makeHarness();
    h.reports.set("s1", [medicalSource()]);
    h.settings.set("s1", {
      allowReadReports: true,
      digest: { entries: ["keep me"], sourceKey: "mismatched-key", generatedAt: "2026-01-01T00:00:00Z" },
    });
    h.extractImpl = async () => {
      throw new Error("provider down");
    };
    const writesBefore = h.writeDigestCalls;

    const result = await ensureReportDigest({ studentId: "s1", sessionId: "sess-A" }, h.deps);

    expect(result.outcome).toBe("stale");
    expect(result.entries).toEqual(["keep me"]);
    expect(h.writeDigestCalls).toBe(writesBefore);
  });

  it("returns unavailable when extract throws and no digest was ever stored", async () => {
    const h = makeHarness();
    h.reports.set("s1", [medicalSource()]);
    h.extractImpl = async () => {
      throw new Error("provider down");
    };

    const result = await ensureReportDigest({ studentId: "s1", sessionId: "sess-A" }, h.deps);

    expect(result).toEqual({ entries: [], outcome: "unavailable" });
  });
});

// ──────────────────────────────────────────────────────────────────
// readReports throws
// ──────────────────────────────────────────────────────────────────

describe("ensureReportDigest — readReports failure", () => {
  it("never rejects; returns unavailable", async () => {
    const h = makeHarness();
    const throwingDeps: ReportDigestDeps = {
      ...h.deps,
      readReports: async () => {
        throw new Error("db down");
      },
    };

    await expect(ensureReportDigest({ studentId: "s1" }, throwingDeps)).resolves.toEqual({
      entries: [],
      outcome: "unavailable",
    });
  });
});

// ──────────────────────────────────────────────────────────────────
// normalizeEntries
// ──────────────────────────────────────────────────────────────────

describe("normalizeEntries", () => {
  it("trims/collapses whitespace, drops non-strings and blanks, de-dups case-insensitively", () => {
    const out = normalizeEntries([
      "  a   b  ",
      "A b",
      123,
      "",
      "   ",
      null,
      undefined,
      { not: "a string" },
      "c",
    ]);
    expect(out).toEqual(["a b", "c"]);
  });

  it("returns [] for non-array input", () => {
    expect(normalizeEntries(null)).toEqual([]);
    expect(normalizeEntries(undefined)).toEqual([]);
    expect(normalizeEntries("not an array")).toEqual([]);
    expect(normalizeEntries({ entries: ["a"] })).toEqual([]);
  });

  it("caps at REPORT_DIGEST_MAX_ENTRIES, preserving input order", () => {
    const many = Array.from({ length: REPORT_DIGEST_MAX_ENTRIES + 5 }, (_, i) => `entry ${i}`);
    const out = normalizeEntries(many);
    expect(out).toHaveLength(REPORT_DIGEST_MAX_ENTRIES);
    expect(out).toEqual(many.slice(0, REPORT_DIGEST_MAX_ENTRIES));
  });
});

// ──────────────────────────────────────────────────────────────────
// computeSourceKey
// ──────────────────────────────────────────────────────────────────

describe("computeSourceKey", () => {
  it("is order-independent across kinds", () => {
    const a = [medicalSource(), functionalSource(), educationalSource()];
    const b = [educationalSource(), medicalSource(), functionalSource()];
    expect(computeSourceKey(a)).toBe(computeSourceKey(b));
  });

  it("changes when content changes", () => {
    const a = [medicalSource({ content: { primaryDiagnosis: "X" } })];
    const b = [medicalSource({ content: { primaryDiagnosis: "Y" } })];
    expect(computeSourceKey(a)).not.toBe(computeSourceKey(b));
  });

  it("changes when updatedAt changes", () => {
    const a = [medicalSource({ updatedAt: "2026-01-01T00:00:00Z" })];
    const b = [medicalSource({ updatedAt: "2026-02-01T00:00:00Z" })];
    expect(computeSourceKey(a)).not.toBe(computeSourceKey(b));
  });

  it("EMPTY_SOURCE_KEY is the key of an empty source list", () => {
    expect(computeSourceKey([])).toBe(EMPTY_SOURCE_KEY);
  });
});

// ──────────────────────────────────────────────────────────────────
// REPORT_DIGEST_INSTRUCTIONS
// ──────────────────────────────────────────────────────────────────

describe("REPORT_DIGEST_INSTRUCTIONS", () => {
  it("tells the extractor to never include a diagnosis or medication name", () => {
    expect(REPORT_DIGEST_INSTRUCTIONS).toContain("NEVER include");
    expect(REPORT_DIGEST_INSTRUCTIONS).toContain("diagnosis");
    expect(REPORT_DIGEST_INSTRUCTIONS.toLowerCase()).toContain("medication");
  });

  it("names the two readers and says the BOARD only chooses options — never layout, size or timing", () => {
    expect(REPORT_DIGEST_INSTRUCTIONS).toContain("SPEAKER");
    expect(REPORT_DIGEST_INSTRUCTIONS).toContain("BOARD");
    expect(REPORT_DIGEST_INSTRUCTIONS).toMatch(/cannot change layout, size/);
    expect(REPORT_DIGEST_INSTRUCTIONS).toMatch(/only which options are offered/);
  });

  it("filters out instructions a person would carry out, with a positioning example that yields nothing", () => {
    expect(REPORT_DIGEST_INSTRUCTIONS).toMatch(/DROP anything a person with hands would carry out/);
    expect(REPORT_DIGEST_INSTRUCTIONS).toMatch(/Position the device[^\n]*→ nothing/);
  });

  it("asks for consequences of abilities on both surfaces, permissions included", () => {
    expect(REPORT_DIGEST_INSTRUCTIONS).toMatch(/CONSEQUENCE of an ability/);
    expect(REPORT_DIGEST_INSTRUCTIONS).toMatch(/Record permissions as well as limits/);
    // The worked wheelchair example binds both surfaces.
    expect(REPORT_DIGEST_INSTRUCTIONS).toMatch(/Non-ambulatory[\s\S]*speak: Never suggest[\s\S]*board: No walk/);
  });

  it("bumped REPORT_DIGEST_REVISION for the prompt rewrite so stored digests regenerate", () => {
    expect(REPORT_DIGEST_REVISION).toBeGreaterThanOrEqual(2);
  });
});

// ──────────────────────────────────────────────────────────────────
// renderDigestEntries — schema-tagged rules → stored "Prefix: rule" lines
// ──────────────────────────────────────────────────────────────────

describe("renderDigestEntries", () => {
  it("renders a wheelchair + tube-fed extraction as prefixed rules for the right surface", () => {
    const raw = [
      { surface: "speak", rule: "Never suggest the child go, walk, or fetch something themselves; frame outings as requests to an adult." },
      { surface: "board", rule: "No walk, run, jump or climb activity options; keep \"take me to\"." },
      { surface: "board", rule: "No food or drink choice options; keep \"I'm hungry\" as a message to an adult." },
      { surface: "both", rule: "If a seizure seems to start, stop the activity, stay calm, alert an adult." },
    ];
    const lines = renderDigestEntries(raw);
    expect(lines).toEqual([
      "Speak: Never suggest the child go, walk, or fetch something themselves; frame outings as requests to an adult.",
      "Board: No walk, run, jump or climb activity options; keep \"take me to\".",
      "Board: No food or drink choice options; keep \"I'm hungry\" as a message to an adult.",
      "Both: If a seizure seems to start, stop the activity, stay calm, alert an adult.",
    ]);
    // Every stored line is bound to a surface — nothing reads as a caregiver note.
    for (const l of lines) expect(l).toMatch(/^(Speak|Board|Both): /);
  });

  it("takes the surface from the enum, not from the text: a duplicated textual prefix is stripped", () => {
    expect(renderDigestEntries([{ surface: "board", rule: "Board: no drums" }])).toEqual(["Board: no drums"]);
    expect(renderDigestEntries([{ surface: "speak", rule: "speaker:  even voice" }])).toEqual(["Speak: even voice"]);
  });

  it("drops malformed items: unknown surface, missing rule, blank rule, non-objects", () => {
    expect(renderDigestEntries([
      { surface: "caregiver", rule: "position the device at eye level" },
      { surface: "board" },
      { surface: "speak", rule: "   " },
      "Speak: a bare string",
      null,
    ])).toEqual([]);
    expect(renderDigestEntries("nope")).toEqual([]);
  });

  it("composes with normalizeEntries: dedup and the entry cap still apply", () => {
    const raw = Array.from({ length: REPORT_DIGEST_MAX_ENTRIES + 5 }, (_, i) => ({ surface: "board", rule: `rule ${i % (REPORT_DIGEST_MAX_ENTRIES + 2)}` }));
    const lines = normalizeEntries(renderDigestEntries(raw));
    expect(lines).toHaveLength(REPORT_DIGEST_MAX_ENTRIES);
    expect(new Set(lines).size).toBe(lines.length);
  });
});
