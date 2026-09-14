// server/services/aac/report-digest.ts
//
// THE ONE WAY a student's clinical reports reach an AAC session.
//
// Until 2026-09-14 the Monitor could `view /Context_MedicalInfo` (the full
// final medical record: diagnosis, comorbidities, medications, alerts) and
// relay whatever it read to the Speaker through an unfiltered [CONTEXT]
// broadcast, and the live prompts carried the raw primary diagnosis. The AAC
// runs in a room that may contain bystanders and the Speaker talks out loud,
// so none of that was defensible. Now:
//
//   • No AAC-session agent has a report field at all (getAACMemoryFields never
//     returns Context_*Info; the diagnosis loader is gone).
//   • This module distils the newest FINAL medical / functional / educational
//     report into a short list of OPERATIONAL entries — what the AAC must do,
//     avoid, or expect — and stores it on `aac_settings.report_digest`. It is
//     machine-owned: regenerated wholesale, never edited by an agent.
//   • Regeneration is DETERMINISTIC, not "remember to write it": the digest
//     carries a sourceKey derived from the report rows it was built from, and
//     `ensureReportDigest` regenerates whenever that key no longer matches.
//     It runs at every AAC session start (Monitor.initializeSession) and is
//     pre-warmed fire-and-forget when a report is finalized.
//   • `allowReadReports === false` means NO report is read and the stored
//     digest is cleared — the switch now gates the distillation, not a field.
//   • Every generation writes a `view` audit row per report it read
//     (route "aac.report-digest", isAiInitiated), like the old diagnosis path.
//
// DB reads, the LLM call, the store and the log sink are injectable so the
// contract is tested without a database (server/tests/report-digest.test.ts).

import { createHash } from "node:crypto";
import { desc, eq, and } from "drizzle-orm";
import { db } from "../../db";
import { medicalRecords, functionalReports, educationalReports, aacSettings } from "@shared/schema";
import { settingsRepository } from "../../repositories/settingsRepository";
import { getStructuredProvider } from "../providers/provider-factory";
import type { JSONSchema } from "../chat/gpt";
import { chargeModelUsage } from "../credit-ledger";
import { activityLogService, type ActivityLogEntry } from "../activityLogService";
import { ReadCoalescer } from "../../middleware/phi-read-audit";
import type { DisclosureContext } from "../processorDisclosure";

/** Route label on every audit row this module writes. */
export const REPORT_DIGEST_ROUTE = "aac.report-digest";

/** Bump when the extraction prompt changes, so stored digests regenerate. */
export const REPORT_DIGEST_REVISION = 2;

/** Hard cap on entries the AAC receives — a digest, not a report. */
export const REPORT_DIGEST_MAX_ENTRIES = 12;

export type ReportKind = "medical" | "functional" | "educational";

/** Stored shape of `aac_settings.report_digest`. */
export interface ReportDigest {
  entries: string[];
  sourceKey: string;
  generatedAt: string;
}

/** One report as the digest reader hands it over: id + freshness + content. */
export interface ReportSource {
  kind: ReportKind;
  recordId: string;
  instituteId?: string | null;
  updatedAt?: Date | string | null;
  /** The report's clinical fields, as stored (jsonb lists / strings). */
  content: Record<string, unknown>;
}

export interface ReportDigestDeps {
  /** Newest FINAL report of each kind for the student (absent kinds omitted). */
  readReports: (studentId: string) => Promise<ReportSource[]>;
  /** `{ allowReadReports, digest }` as stored; null when the student has no settings row. */
  readSettings: (studentId: string) => Promise<{ allowReadReports: boolean; digest: ReportDigest | null } | null>;
  /** Persist (or clear, with null) the digest. */
  writeDigest: (studentId: string, digest: ReportDigest | null) => Promise<void>;
  /** The distillation itself — returns the entries. Throws on provider failure. */
  extract: (sources: ReportSource[], ctx: DigestRequest) => Promise<string[]>;
  log: (entry: ActivityLogEntry) => void;
  coalescer: ReadCoalescer;
}

export interface DigestRequest {
  studentId: string;
  /**
   * The student's `allowReadReports` when the caller already has it.
   * Undefined → looked up. `!== false` convention: a partial row must not deny.
   */
  allowReadReports?: boolean | null;
  /** The AAC session this refresh serves, when any — scopes audit coalescing and billing. */
  sessionId?: string | null;
  userId?: string | null;
  instituteId?: string | null;
  /**
   * Regenerate even when the stored digest's sourceKey still matches — the
   * clinician's "rerun digest" button (reportController.refreshReportDigest).
   * The gate is NOT bypassed: `allowReadReports === false` still clears.
   */
  force?: boolean;
}

// ──────────────────────────────────────────────────────────────────
// Pure helpers
// ──────────────────────────────────────────────────────────────────

function timeOf(v: Date | string | null | undefined): number {
  if (!v) return 0;
  const t = v instanceof Date ? v.getTime() : Date.parse(String(v));
  return Number.isNaN(t) ? 0 : t;
}

/**
 * Identity of the inputs a digest was built from. Two digests with the same
 * key were built from the same report rows at the same revision, so the
 * stored one is still valid. Content is hashed (not just ids + updatedAt) so
 * a backfill that rewrites a row without touching updatedAt still refreshes.
 */
export function computeSourceKey(sources: ReportSource[]): string {
  const h = createHash("sha256");
  h.update(`rev:${REPORT_DIGEST_REVISION}\n`);
  const sorted = [...sources].sort((a, b) => a.kind.localeCompare(b.kind));
  for (const s of sorted) {
    h.update(`${s.kind}|${s.recordId}|${timeOf(s.updatedAt)}|${JSON.stringify(s.content)}\n`);
  }
  return h.digest("hex").slice(0, 32);
}

/** Sentinel key for "no final reports" — a stored empty digest stays valid. */
export const EMPTY_SOURCE_KEY = computeSourceKey([]);

// ──────────────────────────────────────────────────────────────────
// Extraction prompt (docs/PROMPT_WRITING.md — short, instruct, examples)
// ──────────────────────────────────────────────────────────────────

const DIGEST_SCHEMA: JSONSchema = {
  type: "object",
  properties: {
    entries: {
      type: "array",
      description: "Standing rules for the AAC agents, one rule per entry.",
      items: {
        type: "object",
        properties: {
          surface: {
            type: "string",
            enum: ["speak", "board", "both"],
            description: "Which agent the rule binds: speak (the SPEAKER), board (the BOARD), or both.",
          },
          rule: { type: "string", description: "The rule, ≤ 25 words, phrased as what to say/suggest or what to offer/never offer." },
        },
        required: ["surface", "rule"],
        additionalProperties: false,
      },
    },
  },
  required: ["entries"],
  additionalProperties: false,
};

export const REPORT_DIGEST_INSTRUCTIONS = `You distil a student's clinical reports into standing rules for two AI agents on an AAC (communication) device:
- SPEAKER: talks out loud in a room that may contain other people, and suggests things to do.
- BOARD: decides WHICH words and options appear on the child's screen. It cannot change layout, size, colour, timing or position — only which options are offered.
Neither agent has a body. Rules are for THEM, never for a person.

Each entry is one rule, ≤ 25 words, tagged with the surface it binds: "speak", "board" or "both".
Write the CONSEQUENCE of an ability, not the ability: what the SPEAKER must say or never suggest, what the BOARD must offer or never offer.
Record permissions as well as limits, so nothing is over-restricted.

DROP anything a person with hands would carry out (device position, seating, feeding technique, transfers, schedules). The agents cannot act on it.

Examples (report fact → entries):
- "Non-ambulatory, wheelchair, no independent transfers"
  speak: Never suggest the child go, walk, or fetch something themselves; frame outings as requests to an adult.
  board: No walk, run, jump or climb activity options; keep "take me to" and "I want to go".
- "Tube-fed, nothing by mouth"
  board: No food or drink choice options; keep "I'm hungry" and "I'm thirsty" as messages to an adult.
- "Self-feeds finger foods"
  board: Food choice options stay available.
- "Startles at sudden loud sounds"
  speak: Even voice, no exclamations or sound effects.
  board: No loud-activity options such as drums or loud music unless the child asks.
- "Seizures possible"
  both: If a seizure seems to start, stop the activity, stay calm, alert an adult; never describe it to the child.
- "Position the device at eye level, 40 cm away" → nothing (a person does this).

NEVER include:
- A diagnosis, condition name, ICD code, syndrome, or medication name.
- Allergies as a list — turn them into a rule (e.g. board: never offer peanuts or foods containing them).
- Anything a bystander should not overhear, or anything with no bearing on what the agents say or offer.

Return { "entries": [] } when the reports hold nothing operational. Never invent; every entry must be supported by the reports.`;

/** Which agent an entry binds — the schema forces the tag, code renders the prefix. */
export const DIGEST_SURFACES = ["speak", "board", "both"] as const;
export type DigestSurface = (typeof DIGEST_SURFACES)[number];
const SURFACE_PREFIX: Record<DigestSurface, string> = { speak: "Speak:", board: "Board:", both: "Both:" };

/**
 * Render the extractor's structured entries into the stored string form
 * ("Speak: …" / "Board: …" / "Both: …"). Deterministic: the surface comes
 * from the enum the schema enforced, never from parsing the rule text. An
 * item that is not `{ surface, rule }` is dropped.
 */
export function renderDigestEntries(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const surface = (item as { surface?: unknown }).surface;
    const rule = (item as { rule?: unknown }).rule;
    if (typeof rule !== "string" || !(DIGEST_SURFACES as readonly unknown[]).includes(surface)) continue;
    const text = rule.replace(/\s+/g, " ").trim().replace(/^(speak|speaker|board|both)\s*:\s*/i, "");
    if (!text) continue;
    out.push(`${SURFACE_PREFIX[surface as DigestSurface]} ${text}`);
  }
  return out;
}

function describeSources(sources: ReportSource[]): string {
  const blocks = sources.map((s) => {
    const fields = Object.entries(s.content)
      .filter(([, v]) => v != null && !(Array.isArray(v) && v.length === 0) && v !== "")
      .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`);
    return `[${s.kind} report]\n${fields.join("\n") || "(empty)"}`;
  });
  return blocks.join("\n\n");
}

/** Which report columns the extractor may see — the clinical content, nothing else. */
const CONTENT_FIELDS: Record<ReportKind, string[]> = {
  medical: [
    "primaryDiagnosis", "primaryDiagnosisCode", "coMorbidities",
    "alertsAllergies", "alertsSeizures", "alertsCardiac", "medications", "medicalEquipment",
  ],
  functional: ["mobilityStatus", "adlStatus", "sensoryProfile", "safetyRisks"],
  educational: [
    "communicationMode", "receptiveLanguage", "assistiveTechnologyUsed",
    "reinforcers", "preferredActivities", "behavioralStrategies",
  ],
};

function pickContent(kind: ReportKind, row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of CONTENT_FIELDS[kind]) if (row[f] !== undefined) out[f] = row[f];
  return out;
}

/** Normalise model output into a bounded, de-duplicated list of trimmed lines. */
export function normalizeEntries(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== "string") continue;
    const line = v.replace(/\s+/g, " ").trim();
    if (!line) continue;
    const key = line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(line);
    if (out.length >= REPORT_DIGEST_MAX_ENTRIES) break;
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────
// Default (live) dependencies
// ──────────────────────────────────────────────────────────────────

async function dbReadReports(studentId: string): Promise<ReportSource[]> {
  const [medical, functional, educational] = await Promise.all([
    db.query.medicalRecords.findFirst({
      where: and(eq(medicalRecords.studentId, studentId), eq(medicalRecords.status, "final")),
      orderBy: desc(medicalRecords.updatedAt),
    }),
    db.query.functionalReports.findFirst({
      where: and(eq(functionalReports.studentId, studentId), eq(functionalReports.status, "final")),
      orderBy: desc(functionalReports.updatedAt),
    }),
    db.query.educationalReports.findFirst({
      where: and(eq(educationalReports.studentId, studentId), eq(educationalReports.status, "final")),
      orderBy: desc(educationalReports.updatedAt),
    }),
  ]);
  const out: ReportSource[] = [];
  const push = (kind: ReportKind, row: Record<string, any> | undefined) => {
    if (!row) return;
    out.push({
      kind,
      recordId: row.id,
      instituteId: row.instituteId ?? null,
      updatedAt: row.updatedAt ?? row.createdAt ?? null,
      content: pickContent(kind, row),
    });
  };
  push("medical", medical as any);
  push("functional", functional as any);
  push("educational", educational as any);
  return out;
}

async function dbReadSettings(studentId: string) {
  const row = await db.query.aacSettings.findFirst({
    columns: { allowReadReports: true, reportDigest: true },
    where: eq(aacSettings.studentId, studentId),
  });
  if (!row) return null;
  return { allowReadReports: row.allowReadReports !== false, digest: (row.reportDigest as ReportDigest | null) ?? null };
}

async function dbWriteDigest(studentId: string, digest: ReportDigest | null): Promise<void> {
  // Direct column update: the digest is machine-owned, so it deliberately does
  // NOT go through aacSettingsRepository.upsert (sanitising, sensitive-field
  // extraction) or writeAACSettings (the AI door — this is not an AI write).
  await db.update(aacSettings)
    .set({ reportDigest: digest, updatedAt: new Date() })
    .where(eq(aacSettings.studentId, studentId));
}

async function llmExtract(sources: ReportSource[], ctx: DigestRequest): Promise<string[]> {
  const cfg = await settingsRepository.getLLMConfig("clinician");
  const provider = getStructuredProvider(cfg.provider);
  const disclosure: DisclosureContext = {
    studentId: ctx.studentId,
    sessionId: ctx.sessionId ?? null,
    userId: ctx.userId ?? null,
    instituteId: ctx.instituteId ?? null,
    useCase: "clinician",
  };
  const response = await provider.structuredComplete({
    disclosure,
    // Background: a session waits on this at most once per report change; it
    // is never on the live path a child is pressing buttons against.
    background: true,
    model: cfg.model,
    input: [{ type: "message", role: "user", content: `Reports:\n\n${describeSources(sources)}` }],
    instructions: REPORT_DIGEST_INSTRUCTIONS,
    schemaName: "ReportDigest",
    schema: DIGEST_SCHEMA,
    temperature: 0.2,
    maxTokens: 800,
  });
  try {
    await chargeModelUsage({
      provider: cfg.provider,
      model: cfg.model,
      promptTokens: response.promptTokens || 0,
      completionTokens: response.completionTokens || 0,
      cachedTokens: response.cachedTokens || 0,
      cacheCreationTokens: response.cacheCreationTokens || 0,
      sessionId: ctx.sessionId ?? null,
      studentId: ctx.studentId,
      userId: ctx.userId ?? null,
      category: "report-digest",
      label: "report-digest",
    });
  } catch (err) {
    console.warn("[report-digest] charge failed:", err instanceof Error ? err.message : err);
  }
  let parsed: any = response.content;
  if (typeof parsed === "string") parsed = JSON.parse(parsed);
  return normalizeEntries(renderDigestEntries(parsed?.entries));
}

const defaultCoalescer = new ReadCoalescer();

export function defaultReportDigestDeps(): ReportDigestDeps {
  return {
    readReports: dbReadReports,
    readSettings: dbReadSettings,
    writeDigest: dbWriteDigest,
    extract: llmExtract,
    log: (entry) => activityLogService.log(entry),
    coalescer: defaultCoalescer,
  };
}

// ──────────────────────────────────────────────────────────────────
// The contract
// ──────────────────────────────────────────────────────────────────

const SUBJECT_TYPE: Record<ReportKind, ActivityLogEntry["subjectType1"]> = {
  medical: "medical_record",
  functional: "functional_report",
  educational: "educational_report",
};

function auditReportRead(req: DigestRequest, s: ReportSource, deps: ReportDigestDeps): void {
  const key = `report-digest|${s.kind}|${s.recordId}|${req.sessionId ?? "-"}`;
  if (!deps.coalescer.shouldLog(key)) return;
  deps.log({
    userId: req.userId ?? null,
    instituteId: req.instituteId ?? s.instituteId ?? null,
    eventType: "view",
    subjectType1: SUBJECT_TYPE[s.kind],
    subjectId1: s.recordId,
    subjectType2: "student",
    subjectId2: req.studentId,
    details: { route: REPORT_DIGEST_ROUTE, sessionId: req.sessionId ?? null },
    isAiInitiated: true,
  });
}

export interface EnsureResult {
  entries: string[];
  /** What happened: reused the stored digest, regenerated it, cleared it (gate off), or kept a stale one because extraction failed. */
  outcome: "cached" | "regenerated" | "cleared" | "stale" | "unavailable";
}

/**
 * Return the student's current report digest, regenerating it first if the
 * reports it was built from have changed. Never throws: an AAC session must
 * come up even when the extractor is down — it then gets the last good digest
 * (`stale`), or nothing (`unavailable`).
 */
export async function ensureReportDigest(
  req: DigestRequest,
  deps: ReportDigestDeps = defaultReportDigestDeps(),
): Promise<EnsureResult> {
  try {
    let allowed = req.allowReadReports;
    let stored: ReportDigest | null | undefined;
    if (allowed === undefined || allowed === null) {
      const settings = await deps.readSettings(req.studentId);
      allowed = settings ? settings.allowReadReports : true; // absent row → column default
      stored = settings?.digest ?? null;
    }

    // Gate closed: NO report is read, and nothing stale may linger.
    if (allowed === false) {
      if (stored === undefined) stored = (await deps.readSettings(req.studentId))?.digest ?? null;
      if (stored) await deps.writeDigest(req.studentId, null);
      return { entries: [], outcome: "cleared" };
    }

    const sources = await deps.readReports(req.studentId);
    const sourceKey = computeSourceKey(sources);
    if (stored === undefined) stored = (await deps.readSettings(req.studentId))?.digest ?? null;

    if (!req.force && stored && stored.sourceKey === sourceKey) {
      return { entries: normalizeEntries(stored.entries), outcome: "cached" };
    }

    if (sources.length === 0) {
      const digest: ReportDigest = { entries: [], sourceKey, generatedAt: new Date().toISOString() };
      await deps.writeDigest(req.studentId, digest);
      return { entries: [], outcome: "regenerated" };
    }

    for (const s of sources) auditReportRead(req, s, deps);

    let entries: string[];
    try {
      entries = await deps.extract(sources, req);
    } catch (err) {
      console.warn("[report-digest] extraction failed — keeping previous digest:", err instanceof Error ? err.message : err);
      return stored
        ? { entries: normalizeEntries(stored.entries), outcome: "stale" }
        : { entries: [], outcome: "unavailable" };
    }

    const digest: ReportDigest = { entries, sourceKey, generatedAt: new Date().toISOString() };
    await deps.writeDigest(req.studentId, digest);
    return { entries, outcome: "regenerated" };
  } catch (err) {
    console.warn("[report-digest] ensure failed:", err instanceof Error ? err.message : err);
    return { entries: [], outcome: "unavailable" };
  }
}

/**
 * Fire-and-forget pre-warm for report finalize: the next session start then
 * hits the cache instead of paying the extraction latency. Errors are logged
 * inside ensureReportDigest; this never rejects.
 */
export function refreshReportDigestInBackground(req: DigestRequest, deps?: ReportDigestDeps): void {
  void ensureReportDigest(req, deps).then((r) => {
    console.log(`[report-digest] background refresh for ${req.studentId}: ${r.outcome} (${r.entries.length} entries)`);
  });
}

/** Read-side helper for prompt composers that already hold the settings row. */
export function digestEntries(settings: { reportDigest?: unknown } | null | undefined): string[] {
  const d = settings?.reportDigest as ReportDigest | null | undefined;
  return d ? normalizeEntries(d.entries) : [];
}
