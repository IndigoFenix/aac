/**
 * deepAnalysisService.ts
 *
 * Long-running chain-of-thought analysis agent. Produces a student progress
 * report by reading the student's context, past sessions, and past analyses,
 * then writing an investigation → update → report markdown document.
 *
 * Key design points:
 * - Uses Claude (Anthropic SDK) directly with extended thinking enabled.
 * - Run state (messages, scratch, step count) is persisted after every turn
 *   so an interrupted run can be resumed from the last checkpoint.
 * - Writes are locked down to a small allowlist: Student_* fields and the
 *   Context_AACAutoPrompt (the AI-generated AAC digest). Everything else —
 *   including the caretaker-owned Context_AACPrompt — is forced read-only.
 * - The final report is emitted by calling the submit_report tool, which
 *   marks the analysis row complete.
 */

import fs from "fs";
import path from "path";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { deepAnalyses, students } from "@shared/schema";
import {
  withInstituteVisibility,
  type AccessCtx,
} from "./sharing/visibility";
import { buildSessionAccessCtx } from "./sharing/sessionCtx";
import {
  recordShareDerivedView,
  recordShareDerivedViewSingle,
} from "./sharing/audit";
import type { AgentMemoryFieldWithDB } from "./chat/memory-types";
import { settingsRepository } from "../repositories/settingsRepository";
import { resolveModelId, getModelOption } from "@shared/llm-options";
import { creditsForModelUsage } from "./chat/cost-helpers";
import { chargeCreditsToLedger } from "./credit-ledger";
import { getAnthropicClient } from "./providers/anthropic-client";
import { buildMemoryTool } from "./chat/memory-system";
import { processMemoryToolWithDB, createDBContext, createMemoryLoadState } from "./chat/memory-db-bridge";
import type { MemoryState, MemoryLoadState } from "./chat/memory-types";
import { MASTER_MEMORY_FIELDS } from "./sessionService";
import { getAACMemoryFields } from "./memory-schema/aac-memory-schema";
import { SESSION_MEMORY_FIELDS } from "./memory-schema/session-memory-schema";
import { ANALYSIS_MEMORY_FIELDS } from "./memory-schema/analysis-memory-schema";
import { AAC_PROMPT_FIELD, AAC_AUTO_PROMPT_FIELD } from "./memory-schema/aac-settings-memory-schema";

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

const LOG_FILE = path.resolve(process.cwd(), "server", "deep-analysis-debug.log");
function log(analysisId: string, msg: string, obj?: unknown) {
  try {
    const line = obj !== undefined ? `${msg} ${JSON.stringify(obj).slice(0, 2000)}` : msg;
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] [${analysisId}] ${line}\n`);
  } catch {}
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_STEPS = 40;
const MAX_OUTPUT_TOKENS = 16000;
const THINKING_BUDGET_TOKENS = 10000;
const RESUME_STALE_MINUTES = 5;

const WRITABLE_FIELD_IDS = new Set<string>([
  "Context_AACAutoPrompt", // the AUTO prompt — auto-generated digest the analysis maintains
  // Student_* ids are detected by prefix below, not listed individually
  // NOTE: the CUSTOM prompt (Context_AACPrompt) is intentionally NOT writable
  // here — it holds caretaker-requested behaviors and is human-owned.
]);

const SYSTEM_PROMPT = `You are a clinical deep-analysis agent reviewing a student's progress.

Your task, in order:
1. INVESTIGATE. Read the student's context, past AAC sessions (Context_StudentSessions), past clinician/user sessions (Context_UserSessions), and prior deep analyses (Context_DeepAnalyses). Sessions are sorted by importance (3 = milestone, 0 = nothing happened) and then by recency, so skim the top of each list first. Use the date and search filters to drill in — you do NOT need to read every session.
2. REFINE SESSION METADATA. As you review individual sessions, you may (and should) update their title, summary, and importance fields when your broader view reveals a better read than the per-session summarizer had. For example: a session initially rated 1 might deserve a 3 in hindsight (it was the first time a behavior appeared), or a session summary may need clarifying context from surrounding sessions. Only title, summary, and importance are writable on session records — everything else is read-only.
3. UPDATE STUDENT-LEVEL FINDINGS. Based on what you learn, revise the writable memory fields (Student_People, Student_Interests, Student_CommunicationStyle, Student_Preferences, Student_Notes, Context_AACAutoPrompt) to reflect the current truth. Do not invent information — only update fields where the session record clearly supports a change. Context_AACAutoPrompt is the AUTO AAC prompt: a concise digest of what the AAC needs to know about this student (communication level, interests, relevant medical/behavioral facts, triggers, current goals). The live AAC can't read the student's full reports mid-session, so keep this digest current and useful. The CUSTOM prompt (Context_AACPrompt) is read-only here — it holds behaviors caretakers explicitly requested; respect it but never overwrite it, and don't duplicate its instructions into the auto prompt. If a caretaker-requested behavior in the custom prompt contradicts a fact you'd add to the auto prompt, defer to the custom prompt.
4. GENERATE THE REPORT. Call the submit_report tool exactly once with:
   - title: a short descriptive title (≤ 80 characters).
   - summary: a 2–4 sentence summary of progress and key findings.
   - reportMarkdown: a structured markdown report covering (a) recent progress, (b) notable observations, (c) any concerns or regressions, (d) concrete suggested next steps for the clinician. Cite session IDs or dates when referencing specific events.

Guidelines:
- Take your time and think carefully. Use extended thinking as needed.
- Do not make up data. If the evidence is thin, say so in the report.
- Writable memory: Student_* fields, Context_AACAutoPrompt (the AUTO AAC prompt), and the title/summary/importance of any session record. All other memory — including Context_AACPrompt (the CUSTOM, caretaker-owned prompt) — is read-only.
- Call submit_report when — and only when — you are ready to finalize. Do not call it more than once.`;

// ---------------------------------------------------------------------------
// Memory field composition (writable-allowlist filter)
// ---------------------------------------------------------------------------

function isWritableForDeepAnalysis(fieldId: string): boolean {
  if (WRITABLE_FIELD_IDS.has(fieldId)) return true;
  if (fieldId.startsWith("Student_")) return true;
  return false;
}

/**
 * Build the memory field list for the deep-analysis agent.
 * Writable fields: Student_* and Context_AACAutoPrompt. Everything else
 * (including the caretaker-owned Context_AACPrompt): readOnly.
 */
function buildMemoryFields(): AgentMemoryFieldWithDB[] {
  const master = MASTER_MEMORY_FIELDS.map(f =>
    isWritableForDeepAnalysis(f.id)
      ? f
      : ({ ...f, readOnly: true } as AgentMemoryFieldWithDB)
  );

  const aacContext = getAACMemoryFields({
    allowReadProgress: true,
    allowReadReports: true,
  }).map(f => ({ ...f, readOnly: true } as AgentMemoryFieldWithDB));

  return [
    ...master,
    AAC_AUTO_PROMPT_FIELD,                          // writable by design (the AUTO prompt)
    { ...AAC_PROMPT_FIELD, readOnly: true } as AgentMemoryFieldWithDB, // CUSTOM prompt: read-only context
    ...aacContext,                   // readOnly forced above
    ...SESSION_MEMORY_FIELDS,        // already readOnly
    ...ANALYSIS_MEMORY_FIELDS,       // already readOnly
  ];
}

// ---------------------------------------------------------------------------
// Tool definitions (submit_report + manageMemory)
// ---------------------------------------------------------------------------

function submitReportTool() {
  return {
    name: "submit_report",
    description: "Call exactly once when the investigation and memory updates are complete. Marks the analysis finished and stores the final report.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      required: ["title", "summary", "reportMarkdown"],
      properties: {
        title:          { type: "string", description: "Short descriptive title, ≤ 80 chars." },
        summary:        { type: "string", description: "2–4 sentence summary of the analysis." },
        reportMarkdown: { type: "string", description: "Full report in markdown." },
      },
    },
  };
}

function memoryToolForClaude() {
  const tool = buildMemoryTool(false);
  return {
    name: tool.function.name,
    description: tool.function.description || "",
    input_schema: tool.function.parameters,
  };
}

// ---------------------------------------------------------------------------
// Run state helpers
// ---------------------------------------------------------------------------

type Scratch = {
  memoryState?: MemoryState;
  memoryValues?: Record<string, unknown>;
};

/**
 * Compute USD cost for a single turn's token usage, based on the model's
 * published rates in MODEL_OPTIONS. Anthropic bills extended-thinking tokens
 * as output tokens, so they're already reflected in the output count — we
 * don't add a separate line for them. Cache reads/writes bill at 0.1x/1.25x
 * the input rate (handled by creditsForModelUsage). Returns 0 if the model
 * isn't found in the catalog (e.g., a newly added model that hasn't been
 * priced).
 */
function computeTurnCost(
  modelId: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number = 0,
  cacheWriteTokens: number = 0,
): number {
  const opt = getModelOption("claude", modelId);
  if (!opt) return 0;
  return creditsForModelUsage("claude", modelId, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens);
}

async function persistTurn(
  analysisId: string,
  patch: {
    messages?: unknown[];
    scratch?: Scratch;
    stepCountDelta?: number;
    status?: string;
    inputTokensDelta?: number;
    outputTokensDelta?: number;
    thinkingTokensDelta?: number;
    costUsdDelta?: number;
  }
) {
  const sets: Record<string, unknown> = { lastActivityAt: new Date() };
  if (patch.messages !== undefined) sets.messages = patch.messages;
  if (patch.scratch !== undefined) sets.scratch = patch.scratch;
  if (patch.status !== undefined) sets.status = patch.status;

  // Token + cost counters: increment atomically via SQL
  const incParts: string[] = [];
  if (patch.stepCountDelta)         incParts.push(`step_count = step_count + ${patch.stepCountDelta}`);
  if (patch.inputTokensDelta)       incParts.push(`input_tokens = input_tokens + ${patch.inputTokensDelta}`);
  if (patch.outputTokensDelta)      incParts.push(`output_tokens = output_tokens + ${patch.outputTokensDelta}`);
  if (patch.thinkingTokensDelta)    incParts.push(`thinking_tokens = thinking_tokens + ${patch.thinkingTokensDelta}`);
  if (patch.costUsdDelta)           incParts.push(`cost_usd = cost_usd + ${Number(patch.costUsdDelta).toFixed(6)}`);

  if (Object.keys(sets).length > 0) {
    await db.update(deepAnalyses).set(sets).where(eq(deepAnalyses.id, analysisId));
  }
  if (incParts.length > 0) {
    await db.execute(sql.raw(
      `UPDATE deep_analyses SET ${incParts.join(", ")} WHERE id = '${analysisId.replace(/'/g, "''")}'`
    ));
  }
}

// ---------------------------------------------------------------------------
// Create / list / delete
// ---------------------------------------------------------------------------

export interface CreateDeepAnalysisInput {
  studentId: string;
  createdByUserId: string;
  specialInstructions?: string;
  /**
   * Owning institute at create time. Persisted on the row so runDeepAnalysis
   * can rebuild the visibility context — without this the run reads PHI
   * across every institute that has data on the student, regardless of
   * the creator's actual permissions.
   */
  instituteId?: string;
}

export async function createDeepAnalysis(input: CreateDeepAnalysisInput): Promise<{ id: string }> {
  // Validate student exists (sanity check)
  const [student] = await db.select().from(students).where(eq(students.id, input.studentId)).limit(1);
  if (!student) throw new Error(`Unknown studentId: ${input.studentId}`);

  const cfg = await settingsRepository.getLLMConfig("deep_analysis");
  if (cfg.provider !== "claude") {
    throw new Error(`Deep analysis currently requires a Claude model, got provider=${cfg.provider}. Set it in admin settings.`);
  }

  const [row] = await db
    .insert(deepAnalyses)
    .values({
      studentId: input.studentId,
      createdByUserId: input.createdByUserId,
      instituteId: input.instituteId ?? null,
      model: cfg.model,
      specialInstructions: input.specialInstructions || null,
      status: "pending",
    })
    .returning({ id: deepAnalyses.id });

  // Kick off in the background. Errors are logged and reflected in DB row.
  void runDeepAnalysis(row.id).catch(err => {
    log(row.id, `top-level run error`, { error: err instanceof Error ? err.message : String(err) });
  });

  return { id: row.id };
}

export async function getDeepAnalysis(id: string, ctx?: AccessCtx) {
  const where = ctx
    ? and(eq(deepAnalyses.id, id), withInstituteVisibility(deepAnalyses, ctx, "deep_analysis"))
    : eq(deepAnalyses.id, id);
  const [row] = await db.select().from(deepAnalyses).where(where).limit(1);
  if (ctx) recordShareDerivedViewSingle(ctx, "deep_analysis", row);
  return row;
}

export async function listDeepAnalysesForStudent(studentId: string, ctx?: AccessCtx) {
  const where = ctx
    ? and(eq(deepAnalyses.studentId, studentId), withInstituteVisibility(deepAnalyses, ctx, "deep_analysis"))
    : eq(deepAnalyses.studentId, studentId);
  const rows = await db
    .select({
      id: deepAnalyses.id,
      studentId: deepAnalyses.studentId,
      instituteId: deepAnalyses.instituteId,
      createdAt: deepAnalyses.createdAt,
      completedAt: deepAnalyses.completedAt,
      status: deepAnalyses.status,
      title: deepAnalyses.title,
      summary: deepAnalyses.summary,
      model: deepAnalyses.model,
    })
    .from(deepAnalyses)
    .where(where)
    .orderBy(sql`${deepAnalyses.createdAt} desc`);
  if (ctx) recordShareDerivedView(ctx, "deep_analysis", rows);
  return rows;
}

export async function deleteDeepAnalysis(id: string): Promise<boolean> {
  const res = await db.delete(deepAnalyses).where(eq(deepAnalyses.id, id)).returning({ id: deepAnalyses.id });
  return res.length > 0;
}

// ---------------------------------------------------------------------------
// Main run loop
// ---------------------------------------------------------------------------

export async function runDeepAnalysis(analysisId: string): Promise<void> {
  const [row] = await db.select().from(deepAnalyses).where(eq(deepAnalyses.id, analysisId)).limit(1);
  if (!row) {
    log(analysisId, "runDeepAnalysis: row not found");
    return;
  }
  if (row.status === "complete" || row.status === "failed") {
    log(analysisId, `runDeepAnalysis: already ${row.status}, nothing to do`);
    return;
  }

  await persistTurn(analysisId, { status: "running" });
  if (row.status === "running" || row.status === "paused") {
    await db.update(deepAnalyses).set({ resumeCount: (row.resumeCount ?? 0) + 1 }).where(eq(deepAnalyses.id, analysisId));
    log(analysisId, `resuming from step ${row.stepCount}`);
  } else {
    log(analysisId, `starting new run, model=${row.model}`);
  }

  const client = getAnthropicClient();
  const modelId = resolveModelId("claude", row.model);

  // Build memory context
  const fields = buildMemoryFields();
  const scratch: Scratch = (row.scratch as Scratch) ?? {};
  const memoryValues = (scratch.memoryValues ?? {}) as Record<string, unknown>;
  const memoryState: MemoryState = scratch.memoryState ?? { visible: [], page: {} };
  const loadState: MemoryLoadState = createMemoryLoadState();
  // Rebuild the visibility context from the persisted (studentId, userId,
  // instituteId) tuple. Memory-schema reads consult ctx.all.accessCtx; without
  // this every gate downstream silently no-ops and the agent reads PHI across
  // every institute that holds data for the student.
  const accessCtx = await buildSessionAccessCtx({
    userId: row.createdByUserId,
    studentId: row.studentId,
    instituteId: row.instituteId ?? undefined,
  });
  const baseContext = {
    studentId: row.studentId,
    userId: row.createdByUserId,
    accessCtx,
  };

  // Claude-format messages. On first call, seed with the initial user request.
  const messages: any[] = Array.isArray(row.messages) ? [...(row.messages as any[])] : [];
  if (messages.length === 0) {
    const seed = row.specialInstructions
      ? `Please analyze this student. Special instructions: ${row.specialInstructions}`
      : `Please analyze this student.`;
    messages.push({ role: "user", content: seed });
  }

  const tools = [memoryToolForClaude(), submitReportTool()];

  let stepCount = row.stepCount ?? 0;
  let done = false;

  try {
    while (!done) {
      if (stepCount >= MAX_STEPS) {
        throw new Error(`Exceeded MAX_STEPS=${MAX_STEPS} without submit_report. Aborting.`);
      }
      stepCount++;
      log(analysisId, `step ${stepCount} → calling Claude`);

      // Use streaming — the Anthropic SDK rejects non-streaming requests that may
      // exceed 10 minutes, which is common for deep analysis with extended thinking
      // plus tool-call round trips. We don't forward stream chunks anywhere; we
      // just wait for the final aggregated Message, which has the same shape as
      // messages.create() would have returned.
      const stream = client.messages.stream({
        model: modelId,
        max_tokens: MAX_OUTPUT_TOKENS,
        system: buildSystemPrompt(row.specialInstructions || undefined),
        thinking: { type: "enabled", budget_tokens: THINKING_BUDGET_TOKENS },
        messages,
        tools: tools as any,
      });
      const response = await stream.finalMessage();

      // Persist assistant blocks (including thinking) exactly as returned —
      // Claude requires them preserved across subsequent turns.
      const assistantBlocks = response.content || [];
      messages.push({ role: "assistant", content: assistantBlocks });

      const usage = response.usage;
      const thinkingBudget = (usage as any)?.thinking_tokens ?? 0;
      const turnIn  = usage?.input_tokens  ?? 0;
      const turnOut = usage?.output_tokens ?? 0;
      const cacheRead  = (usage as any)?.cache_read_input_tokens ?? 0;
      const cacheWrite = (usage as any)?.cache_creation_input_tokens ?? 0;
      const turnCost = computeTurnCost(row.model, turnIn, turnOut, cacheRead, cacheWrite);
      await persistTurn(analysisId, {
        messages,
        scratch: { memoryState, memoryValues },
        stepCountDelta: 1,
        inputTokensDelta: turnIn,
        outputTokensDelta: turnOut,
        thinkingTokensDelta: thinkingBudget,
        costUsdDelta: turnCost,
      });
      // Mirror into the shared usage ledger so deep-analysis spend shows up
      // in per-user/per-student cost rollups (deep_analyses.cost_usd alone
      // is invisible there). No sessionId — analyses aren't chat sessions.
      chargeCreditsToLedger({
        studentId: row.studentId,
        userId: row.createdByUserId,
        credits: turnCost,
        category: "deep-analysis",
        label: `deep-analysis ${analysisId} step ${stepCount}`,
      }).catch(err => log(analysisId, "ledger charge failed", { error: (err as Error).message }));

      const toolUseBlocks = assistantBlocks.filter((b: any) => b.type === "tool_use");
      if (toolUseBlocks.length === 0) {
        // No tools called this turn — if the model also didn't submit a report, prompt it.
        if (response.stop_reason === "end_turn") {
          log(analysisId, "model ended turn without tool use — asking for report or next step");
          messages.push({
            role: "user",
            content: "You ended your turn without calling submit_report. Either take another investigation step or call submit_report to finalize.",
          });
        }
        continue;
      }

      const toolResultBlocks: any[] = [];
      for (const toolUse of toolUseBlocks) {
        const tu = toolUse as any;
        if (tu.name === "submit_report") {
          await finalizeReport(analysisId, tu.input, response.usage);
          done = true;
          toolResultBlocks.push({
            type: "tool_result",
            tool_use_id: tu.id,
            content: "Report stored. Analysis marked complete.",
          });
          break;
        }

        if (tu.name === "manageMemory") {
          try {
            const result = await processMemoryToolWithDB(
              fields,
              memoryValues,
              memoryState,
              loadState,
              tu.input,
              baseContext,
              (ff, vv, ss, input) => {
                // The original in-memory processor is applied internally by the DB bridge; we're
                // here only as the glue that the bridge hands control back to. The bridge calls
                // this function to run memory-system's processMemoryToolResponse.
                // We defer the import to avoid a cycle.
                // eslint-disable-next-line @typescript-eslint/no-var-requires
                const mem = require("./chat/memory-system");
                return mem.processMemoryToolResponse(ff, vv, ss, input);
              }
            );
            Object.assign(memoryValues, result.updatedMemoryValues);
            Object.assign(memoryState, result.updatedMemoryState);
            toolResultBlocks.push({
              type: "tool_result",
              tool_use_id: tu.id,
              content: JSON.stringify({ results: result.results }).slice(0, 40000),
            });
          } catch (err) {
            log(analysisId, `manageMemory error`, { error: err instanceof Error ? err.message : String(err) });
            toolResultBlocks.push({
              type: "tool_result",
              tool_use_id: tu.id,
              content: `manageMemory failed: ${err instanceof Error ? err.message : String(err)}`,
              is_error: true,
            });
          }
          continue;
        }

        // Unknown tool — tell the model
        toolResultBlocks.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: `Unknown tool: ${tu.name}`,
          is_error: true,
        });
      }

      messages.push({ role: "user", content: toolResultBlocks });

      await persistTurn(analysisId, {
        messages,
        scratch: { memoryState, memoryValues },
      });
    }
  } catch (err) {
    log(analysisId, "run failed", { error: err instanceof Error ? err.message : String(err) });
    await db
      .update(deepAnalyses)
      .set({ status: "failed", error: err instanceof Error ? err.message : String(err), lastActivityAt: new Date() })
      .where(eq(deepAnalyses.id, analysisId));
    return;
  }
}

function buildSystemPrompt(specialInstructions?: string): string {
  if (!specialInstructions) return SYSTEM_PROMPT;
  return `${SYSTEM_PROMPT}

=== SPECIAL INSTRUCTIONS FROM CLINICIAN ===
${specialInstructions}
=== END SPECIAL INSTRUCTIONS ===`;
}

async function finalizeReport(
  analysisId: string,
  input: { title?: string; summary?: string; reportMarkdown?: string },
  usage: unknown,
) {
  const title = typeof input.title === "string" ? input.title.slice(0, 200) : "Deep Analysis";
  const summary = typeof input.summary === "string" ? input.summary : "";
  const reportMarkdown = typeof input.reportMarkdown === "string" ? input.reportMarkdown : "";

  await db.update(deepAnalyses)
    .set({
      status: "complete",
      title,
      summary,
      reportMarkdown,
      completedAt: new Date(),
      lastActivityAt: new Date(),
    })
    .where(eq(deepAnalyses.id, analysisId));
  log(analysisId, "finalized report", { title, summary: summary.slice(0, 200), reportLen: reportMarkdown.length, usage });
}

/**
 * Resume any "running" analyses that have been stalled for more than RESUME_STALE_MINUTES.
 * Intended to be called at server startup.
 */
export async function resumeStalledAnalyses(): Promise<void> {
  const staleBefore = new Date(Date.now() - RESUME_STALE_MINUTES * 60_000);
  const stalled = await db
    .select({ id: deepAnalyses.id })
    .from(deepAnalyses)
    .where(sql`${deepAnalyses.status} IN ('running','paused') AND (${deepAnalyses.lastActivityAt} IS NULL OR ${deepAnalyses.lastActivityAt} < ${staleBefore})`);

  for (const { id } of stalled) {
    log(id, "resuming stalled analysis on startup");
    void runDeepAnalysis(id).catch(err => {
      log(id, `resume top-level error`, { error: err instanceof Error ? err.message : String(err) });
    });
  }
}
