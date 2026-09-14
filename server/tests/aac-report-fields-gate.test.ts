// Pins the 2026-09-14 report gate: no AAC-session agent may read a clinical
// report directly any more. getAACMemoryFields (the live 4-agent field set)
// never returns a report field regardless of options; getAACReportMemoryFields
// (the clinician-side deep-analysis field set) still exists and is gated by
// `allowReadReports`. The only report-derived text an AAC session ever sees
// is the machine-owned digest (report-digest.ts) folded into the persona.

import { describe, it, expect } from "@jest/globals";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import {
  getAACMemoryFields,
  getAACReportMemoryFields,
  buildMonitorSystemPrompt,
  composeAacPersona,
  AAC_DEFAULT_PERSONA_PROMPT,
} from "../services/memory-schema/aac-memory-schema.js";
import { digestEntries } from "../services/aac/report-digest.js";

const REPORT_FIELD_IDS = ["Context_MedicalInfo", "Context_FunctionalInfo", "Context_EducationalInfo"];

describe("getAACMemoryFields — never carries a report field", () => {
  it("no option combination (including a stray allowReadReports) returns a report field id", () => {
    const optionSets: Array<Record<string, unknown> | undefined> = [
      undefined,
      {},
      { allowReadProgress: true },
      { allowReadProgress: false },
      { allowReadReports: true } as any,
      { allowReadReports: false, allowReadProgress: true } as any,
    ];
    for (const opts of optionSets) {
      const fields = getAACMemoryFields(opts as any);
      const ids = fields.map((f) => f.id);
      for (const reportId of REPORT_FIELD_IDS) {
        expect(ids).not.toContain(reportId);
      }
    }
  });

  it("still returns Context_Progress when allowReadProgress is not false", () => {
    expect(getAACMemoryFields().map((f) => f.id)).toContain("Context_Progress");
    expect(getAACMemoryFields({ allowReadProgress: false }).map((f) => f.id)).not.toContain("Context_Progress");
  });
});

describe("getAACReportMemoryFields — clinician-side gate", () => {
  it("returns [] when allowReadReports is false", () => {
    expect(getAACReportMemoryFields({ allowReadReports: false })).toEqual([]);
  });

  it("returns exactly the three report field ids when allowed (explicitly true or by default)", () => {
    const expected = [...REPORT_FIELD_IDS].sort();
    expect(getAACReportMemoryFields({ allowReadReports: true }).map((f) => f.id).sort()).toEqual(expected);
    expect(getAACReportMemoryFields({}).map((f) => f.id).sort()).toEqual(expected);
  });
});

describe("buildMonitorSystemPrompt — no report field paths, still lists Progress", () => {
  it("does not mention any of the three report memory paths", () => {
    const p = buildMonitorSystemPrompt({ name: "Sam", aacSettings: null });
    expect(p).not.toContain("Context_MedicalInfo");
    expect(p).not.toContain("Context_FunctionalInfo");
    expect(p).not.toContain("Context_EducationalInfo");
    expect(p).toContain("Context_Progress");
  });

  it("folds a stored report digest into the persona block", () => {
    const p = buildMonitorSystemPrompt({
      name: "Sam",
      aacSettings: {
        chatAgentPrompt: null,
        autoAacPrompt: null,
        reportDigest: {
          entries: ["Never offer peanuts"],
          sourceKey: "x",
          generatedAt: "2026-09-14T00:00:00Z",
        },
      },
    });
    expect(p).toContain("Never offer peanuts");
  });
});

describe("composeAacPersona — reports section", () => {
  it("renders a care-team block containing the digest entries", () => {
    const p = composeAacPersona({ reports: ["Never offer peanuts"] });
    expect(p).toContain("Never offer peanuts");
    expect(p.toLowerCase()).toContain("care team");
  });

  it("falls back to the default persona when custom/auto/reports are all empty", () => {
    expect(composeAacPersona({})).toBe(AAC_DEFAULT_PERSONA_PROMPT);
    expect(AAC_DEFAULT_PERSONA_PROMPT.toLowerCase()).not.toContain("care team");
  });
});

describe("digestEntries — read-side helper", () => {
  it("null/undefined settings yield []", () => {
    expect(digestEntries(null)).toEqual([]);
    expect(digestEntries(undefined)).toEqual([]);
  });

  it("settings with no reportDigest yield []", () => {
    expect(digestEntries({})).toEqual([]);
  });

  it("normalizes the stored entries (trim, de-dup, drop blanks)", () => {
    expect(digestEntries({ reportDigest: { entries: [" a ", "a", ""] } })).toEqual(["a"]);
  });
});

// ──────────────────────────────────────────────────────────────────
// Source-level guard: which files may read a report at all.
// ──────────────────────────────────────────────────────────────────

function readSrc(...parts: string[]): string {
  return readFileSync(join(process.cwd(), ...parts), "utf8");
}

describe("source guard — the report gate isn't bypassed elsewhere", () => {
  it("deepAnalysisService.ts is the one remaining AI reader of report fields", () => {
    const src = readSrc("server", "services", "deepAnalysisService.ts");
    expect(src).toContain("getAACReportMemoryFields");
  });

  it("sessionSummary.ts never references a report field id or getAACReportMemoryFields", () => {
    const src = readSrc("server", "services", "sessionSummary.ts");
    for (const id of REPORT_FIELD_IDS) expect(src).not.toContain(id);
    expect(src).not.toContain("getAACReportMemoryFields");
  });

  it("sessionService.ts never CALLS getAACReportMemoryFields or constructs a report field", () => {
    // NOTE: sessionService.ts's PHI_MEMORY_PREFIXES array (a defense-in-depth
    // guard against combining PHI memory access with outbound-tool agents,
    // used by the LEGACY isAACFeature/AGENT_TEMPLATE_BASE path — not the live
    // 4-agent system) does contain the bare string "Context_MedicalInfo" as
    // one of several prefixes it checks for, plus a comment naming it. That
    // array is never populated by an actual field construction here — the
    // templates it guards build their memoryFields from MASTER_MEMORY_FIELDS
    // (Student_*/Relationship_* fields only), not from
    // getAACReportMemoryFields. So the meaningful assertion is: no call to
    // getAACReportMemoryFields, and no field OBJECT with a report id is
    // constructed (createReadOnlyObjectField('Context_MedicalInfo', ...) or
    // an equivalent `id: 'Context_MedicalInfo'` field literal).
    const src = readSrc("server", "services", "sessionService.ts");
    expect(src).not.toContain("getAACReportMemoryFields");
    for (const id of REPORT_FIELD_IDS) {
      expect(src).not.toMatch(new RegExp(`createReadOnlyObjectField\\(\\s*['"]${id}['"]`));
      expect(src).not.toMatch(new RegExp(`id:\\s*['"]${id}['"]`));
    }
  });

  it("no file under server/services/dual-agent/ imports the removed diagnosis-for-prompt module", () => {
    const dir = join(process.cwd(), "server", "services", "dual-agent");
    const files = readdirSync(dir).filter((f) => f.endsWith(".ts"));
    for (const f of files) {
      const src = readSrc("server", "services", "dual-agent", f);
      expect(src).not.toContain("diagnosis-for-prompt");
    }
  });
});
