/**
 * sessionSummary.ts
 *
 * Generates a short title + summary for a chat session so that deep-analysis
 * session search (memory field Context_StudentSessions / Context_UserSessions)
 * has something meaningful to match against.
 *
 * Two paths:
 * - LIGHT: very short sessions get a single-shot summary of the transcript
 *   (grounded with the student's name + output language). Nothing happened;
 *   no investigation needed.
 * - CONTEXT-AWARE: substantial sessions run a small post-session analyst with
 *   the SAME memory access the Monitor has (all fields read-only) via the
 *   manageMemory tool — bounded view/search rounds over Student_Notes,
 *   Context_StudentSessions etc. — so importance reflects actual NOVELTY
 *   ("first time she…" vs routine) and recurring patterns get named in the
 *   summary for deep analysis to pick up later. Runs post-session, so unlike
 *   the Monitor it has time to think and nothing it reads can leak into the
 *   live session. Falls back to the light path on any failure.
 *
 * Idempotent: if the session already has both title and summary, no work is done.
 * Safe to call in the background (errors are logged, not thrown).
 */

import { db } from "../db";
import { chatSessions, type ChatMessage, type StudentWithAacSettings } from "@shared/schema";
import type { PendingMessage } from "./dual-agent/types";
import { eq } from "drizzle-orm";
import { getStructuredProvider } from "./providers/provider-factory";
import type { JSONSchema, GPTInputItem, GPTResponse } from "./chat/gpt";
import { settingsRepository } from "../repositories/settingsRepository";
import { studentRepository } from "../repositories/studentRepository";
import { getLanguageName } from "@shared/language-names";
import { chargeModelUsage } from "./credit-ledger";
import { buildMemoryTool, processMemoryToolResponse, renderMemorySchema } from "./chat/memory-system";
import { processMemoryToolWithDB, createMemoryLoadState } from "./chat/memory-db-bridge";
import type { MemoryState, AgentMemoryFieldWithDB } from "./chat/memory-types";
import { MASTER_MEMORY_FIELDS } from "./sessionService";
import { getAACMemoryFields } from "./memory-schema/aac-memory-schema";
import { SESSION_MEMORY_FIELDS } from "./memory-schema/session-memory-schema";
import { AAC_PROMPT_FIELD, AAC_AUTO_PROMPT_FIELD } from "./memory-schema/aac-settings-memory-schema";
import { buildSessionAccessCtx } from "./sharing/sessionCtx";
import { presenceContextFromSnapshot } from "./memory-schema/presence-context";
import path from "path";
import { fileDebugLoggingEnabled, safeAppend } from "./file-debug-log";
import type { DisclosureContext } from "./processorDisclosure";

// Development-only file log (raw LLM session-summary text) — see file-debug-log.ts.
const LOG_FILE = path.resolve(process.cwd(), "server", "session-summary-debug.log");
function log(msg: string) {
  if (!fileDebugLoggingEnabled) return;
  try {
    safeAppend(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`);
  } catch {}
}

const MAX_MESSAGES_IN_CONTEXT = 40;
const MAX_CHARS_PER_MESSAGE = 500;
/** Transcripts shorter than this skip the context-aware analyst entirely —
 *  a greeting exchange doesn't need memory investigation. */
const CONTEXT_TRANSCRIPT_MIN_CHARS = 600;
/** Max manageMemory rounds before the analyst is forced to answer. */
const MAX_CONTEXT_STEPS = 4;

function messageText(m: ChatMessage): string {
  const c = m.content;
  if (typeof c === "string") return c;
  if (c && typeof c === "object") {
    return c.text || c.md || c.html || "";
  }
  return "";
}

function buildTranscript(messages: ChatMessage[]): string {
  // Tool-call assistant turns carry no content; their empty "ASSISTANT:" lines
  // only add noise for the summarizer, so drop text-less messages entirely.
  const filtered = messages
    .filter(m => m.role !== "tool" && m.role !== "system")
    .map(m => ({ role: m.role, text: messageText(m).slice(0, MAX_CHARS_PER_MESSAGE) }))
    .filter(m => m.text.trim().length > 0);
  const slice = filtered.length <= MAX_MESSAGES_IN_CONTEXT
    ? filtered
    : [
        ...filtered.slice(0, MAX_MESSAGES_IN_CONTEXT / 2),
        ...filtered.slice(-MAX_MESSAGES_IN_CONTEXT / 2),
      ];
  return slice.map(m => `${m.role.toUpperCase()}: ${m.text}`).join("\n");
}

const SUMMARY_SCHEMA: JSONSchema = {
  type: "object",
  additionalProperties: false,
  required: ["title", "summary", "importance"],
  properties: {
    title: {
      type: "string",
      description: "Short human-readable title, ≤ 80 chars. No quotes.",
    },
    summary: {
      type: "string",
      description: "2-4 sentence summary: main topics, outcomes, anything notable. No PII beyond what's already in the transcript.",
    },
    importance: {
      type: "integer",
      enum: [0, 1, 2, 3],
      description: "Perceived importance of this session. 0 = nothing happened and the session could be deleted with no information loss. 1 = routine activity (normal usage, no new findings). 2 = potentially interesting: a new observation, behavior, or data point worth noting. 3 = major milestone (clear goal progress, regression, breakthrough, or incident). Be conservative — 3 is rare.",
    },
  },
};

export async function generateSessionSummary(sessionId: string): Promise<void> {
  try {
    const [session] = await db
      .select()
      .from(chatSessions)
      .where(eq(chatSessions.id, sessionId));
    if (!session) return;
    if (session.title && session.summary) return; // already done

    // When a clinician has manually renamed the session, generate the summary
    // for search but never overwrite their chosen title.
    const keepTitle = session.titleManual === true;
    // Summarization marks the end of a session's life — record it in status
    // so lists show "ended" and the abandoned-session sweeper stops matching.
    // CRM landing chats keep their own lifecycle (crmRepository filters open).
    const closeStatus = session.crmPotentialCustomerId ? {} : { status: "closed" as const };

    let messages: ChatMessage[] = Array.isArray(session.log) ? (session.log as ChatMessage[]) : [];

    // Defense in depth: if the log is empty but messages are still sitting in
    // pending_messages (the Monitor never drained them — e.g. a session that
    // ended before any monitor pass ran), recover them here instead of
    // mislabeling a session that actually had activity as "(empty session)".
    // We also persist the recovered turns into the log so the presses aren't
    // lost. The normal path now awaits the Monitor drain first, so this only
    // fires when that drain genuinely failed.
    if (messages.length === 0) {
      const pending = Array.isArray(session.pendingMessages)
        ? (session.pendingMessages as PendingMessage[])
        : [];
      if (pending.length > 0) {
        messages = pending.map(p => ({ role: p.role, content: p.content, timestamp: p.timestamp } as ChatMessage));
        log(`[${sessionId}] log was empty but ${pending.length} pending message(s) found — recovering into log`);
        await db
          .update(chatSessions)
          .set({ log: messages, pendingMessages: [] })
          .where(eq(chatSessions.id, sessionId));
      }
    }

    if (messages.length === 0) {
      await db
        .update(chatSessions)
        .set({ summary: "No messages.", importance: 0, ...closeStatus, ...(keepTitle ? {} : { title: "(empty session)" }) })
        .where(eq(chatSessions.id, sessionId));
      return;
    }

    const transcript = buildTranscript(messages);
    if (!transcript.trim()) {
      // Everything was tool calls / empty content — nothing to summarize.
      await db
        .update(chatSessions)
        .set({ summary: "No messages.", importance: 0, ...closeStatus, ...(keepTitle ? {} : { title: "(empty session)" }) })
        .where(eq(chatSessions.id, sessionId));
      return;
    }
    const cfg = await settingsRepository.getLLMConfig("clinician");
    const provider = getStructuredProvider(cfg.provider);

    // AKIM §18.5 — the transcript about to be summarized is PHI. A CRM
    // landing chat is anonymous, so it declares `crm_chat` and is skipped by
    // recordDisclosure rather than being skipped by having no context at all.
    const disclosure: DisclosureContext = {
      studentId: session.studentId ?? null,
      sessionId,
      userId: session.userId ?? null,
      instituteId: session.instituteId ?? null,
      useCase: session.crmPotentialCustomerId ? "crm_chat" : "clinician",
    };

    // Ground the summarizer in WHO the session is about. Without this, a
    // transcript in another language left the model free to confabulate the
    // subject's identity from medical priors — a hospitalized child was once
    // summarized as the family's DOG (cluster seizures + midazolam pattern-
    // matched to canine epilepsy). One line of grounding closes that door.
    let student: StudentWithAacSettings | undefined;
    if (session.studentId) {
      try {
        student = await studentRepository.getStudentWithAacSettings(session.studentId);
      } catch (err) {
        log(`[${sessionId}] student lookup failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const subjectName = student?.firstName || student?.name?.split(" ")[0];
    const subjectLine = subjectName
      ? `\nSubject: ${subjectName} — a student (a person) who communicates using an AAC device.\n`
      : "";
    // Explicit output language beats "match the transcript" for small models
    // (haiku wrote English titles over Hebrew transcripts). The student's
    // primaryLanguage is the language of the people who read these.
    const languageLine = student?.primaryLanguage
      ? `Write the title and summary in ${getLanguageName(student.primaryLanguage)}.`
      : "Write the title and summary in the transcript's dominant language.";

    // Presence ledger §6.1: the coordinator snapshotted its ledger onto the
    // session row at close, so the close summary is TOLD who was in the room
    // instead of inferring it from a transcript full of the matcher's guesses.
    // Empty when the feature was off for that session (or the column is null,
    // which is every session before this shipped) — then the prose warning
    // below stands and this path is byte-identical to before.
    const presenceBlock = presenceContextFromSnapshot(session.presenceLedger);
    const presenceInstruction = presenceBlock
      ? "Use the [PRESENCE — system verified] block: only people in its verified list were present."
      : "A [RETRACTION] line voids earlier reports of that person: never state they were present.";

    const baseInstructions = [
      "You are summarizing a chat session transcript for later retrieval.",
      "Produce a concise title, a 2-4 sentence summary, and an importance score (0-3).",
      "Focus on topics, outcomes, and notable events.",
      languageLine,
      "Do not invent facts. Refer to people exactly as the transcript presents them",
      "— never infer species, age, or relationships that are not stated.",
      presenceInstruction,
      "Do not claim a person was present from the user's own greeting presses alone —",
      "greetings are often practice directed at nobody in the room.",
    ];
    const presenceSection = presenceBlock ? `\n\n${presenceBlock}` : "";
    const userContent = `Summarize the following session transcript.\n\nChat mode: ${session.chatMode}${subjectLine}${presenceSection}\nTranscript:\n${transcript}`;

    const chargeResponse = async (r: GPTResponse) => {
      await chargeModelUsage({
        provider: cfg.provider,
        model: cfg.model,
        promptTokens: r.promptTokens || 0,
        completionTokens: r.completionTokens || 0,
        cachedTokens: r.cachedTokens || 0,
        cacheCreationTokens: r.cacheCreationTokens || 0,
        sessionId,
        studentId: session.studentId,
        userId: session.userId,
        category: "session-summary",
        label: "session-summary",
      });
    };

    // Substantial student sessions get the context-aware analyst (Monitor-grade
    // read-only memory access, bounded searches) so importance reflects real
    // novelty. Short sessions — nothing happened — skip it entirely. Honors
    // the same allowNotes privacy gate the Monitor's final pass respects.
    const contextAware =
      !!session.studentId &&
      transcript.length >= CONTEXT_TRANSCRIPT_MIN_CHARS &&
      student?.aacSettings?.allowNotes !== false;

    let response: GPTResponse | null = null;
    if (contextAware) {
      try {
        response = await runContextAwareSummary({
          studentId: session.studentId!,
          userId: session.userId,
          instituteId: session.instituteId,
          privacy: {
            allowReadProgress: student?.aacSettings?.allowReadProgress !== false,
            allowReadReports: student?.aacSettings?.allowReadReports !== false,
          },
          provider,
          model: cfg.model,
          userContent,
          baseInstructions,
          chargeResponse,
          disclosure,
        });
      } catch (err) {
        log(`[${sessionId}] context-aware summary failed — falling back to light path: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (!response) {
      response = await provider.structuredComplete({
        disclosure,
        // Background: a summary written after the session; nobody is on a screen.
        background: true,
        model: cfg.model,
        input: [{ type: "message", role: "user", content: userContent }],
        instructions: baseInstructions.join("\n"),
        schemaName: "SessionSummary",
        schema: SUMMARY_SCHEMA,
        maxTokens: 400,
      });
      await chargeResponse(response);
    }

    // Structured providers return `content` as a JSON *string* (Claude
    // JSON.stringifies the tool input; OpenAI returns output_text). Every other
    // caller JSON.parses it — see chat-handler.ts. Parse it here too.
    let parsed: any = response.content;
    if (typeof parsed === "string") {
      try {
        parsed = JSON.parse(parsed);
      } catch {
        log(`[${sessionId}] content was not valid JSON: ${parsed.slice(0, 200)}`);
        return;
      }
    }
    if (!parsed || typeof parsed !== "object") {
      log(`[${sessionId}] no parsed content from provider`);
      return;
    }
    const title = typeof parsed.title === "string" ? parsed.title.slice(0, 200) : null;
    const summary = typeof parsed.summary === "string" ? parsed.summary : null;
    const rawImportance = parsed.importance;
    const importance = (typeof rawImportance === "number" && Number.isInteger(rawImportance) && rawImportance >= 0 && rawImportance <= 3)
      ? rawImportance
      : 1;
    if (!title || !summary) {
      log(`[${sessionId}] missing title/summary in response`);
      return;
    }

    await db
      .update(chatSessions)
      .set({ summary, importance, ...closeStatus, ...(keepTitle ? {} : { title }) })
      .where(eq(chatSessions.id, sessionId));
    log(`[${sessionId}] summary generated (importance=${importance}${keepTitle ? ", title kept (manual)" : ""})`);
  } catch (err) {
    log(`[${sessionId}] error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * The memory surface for the post-session analyst: the SAME fields the
 * Monitor and deep analysis see, but ALL read-only — the analyst observes
 * and scores; the Monitor and deep analysis own the writes.
 */
function summarizerMemoryFields(privacy: {
  allowReadProgress: boolean;
  allowReadReports: boolean;
}): AgentMemoryFieldWithDB[] {
  const ro = (f: unknown) => ({ ...(f as AgentMemoryFieldWithDB), readOnly: true }) as AgentMemoryFieldWithDB;
  return [
    ...MASTER_MEMORY_FIELDS.map(ro),
    ro(AAC_AUTO_PROMPT_FIELD),
    ro(AAC_PROMPT_FIELD),
    ...getAACMemoryFields(privacy).map(ro),
    ...SESSION_MEMORY_FIELDS.map(ro),
  ];
}

/**
 * Bounded post-session analyst loop. Each round the model either calls
 * manageMemory (view/search — executed through the same DB bridge the Monitor
 * and deep analysis use, PHI-scoped by the session's access context) or emits
 * the final structured summary. After MAX_CONTEXT_STEPS rounds the tool is
 * withdrawn, forcing the answer. Throws on provider errors — the caller falls
 * back to the light single-shot path.
 */
async function runContextAwareSummary(opts: {
  studentId: string;
  userId?: string | null;
  instituteId?: string | null;
  privacy: { allowReadProgress: boolean; allowReadReports: boolean };
  provider: ReturnType<typeof getStructuredProvider>;
  model: string;
  userContent: string;
  baseInstructions: string[];
  chargeResponse: (r: GPTResponse) => Promise<void>;
  /** AKIM §18.5 — who this summary is about. */
  disclosure?: DisclosureContext;
}): Promise<GPTResponse> {
  const fields = summarizerMemoryFields(opts.privacy);
  const memoryValues: Record<string, unknown> = {};
  const memoryState: MemoryState = { visible: [], page: {} };
  const loadState = createMemoryLoadState();
  const accessCtx = await buildSessionAccessCtx({
    userId: opts.userId ?? undefined,
    studentId: opts.studentId,
    instituteId: opts.instituteId ?? undefined,
  });
  const baseContext = { studentId: opts.studentId, userId: opts.userId ?? undefined, accessCtx };
  const memoryTool = buildMemoryTool(false);

  const instructions = [
    ...opts.baseInstructions,
    "",
    "You have READ-ONLY access to the student's memory via manageMemory.",
    "Importance depends on NOVELTY. Before scoring above 1:",
    "- view Student_Notes for what is already known,",
    "- search Context_StudentSessions for similar past sessions.",
    `Keep it bounded — at most ${MAX_CONTEXT_STEPS} manageMemory calls, then answer.`,
    "If the session shows a recurring pattern worth deep-analysis attention, name it in the summary.",
    "",
    renderMemorySchema(fields),
  ].join("\n");

  const input: GPTInputItem[] = [{ type: "message", role: "user", content: opts.userContent }];

  for (let step = 0; step <= MAX_CONTEXT_STEPS; step++) {
    const finalStep = step === MAX_CONTEXT_STEPS;
    const response = await opts.provider.structuredComplete({
      disclosure: opts.disclosure,
      model: opts.model,
      input,
      instructions,
      schemaName: "SessionSummary",
      schema: SUMMARY_SCHEMA,
      tools: finalStep ? undefined : [memoryTool],
      maxTokens: 600,
    });
    await opts.chargeResponse(response);
    const toolCalls = response.toolCalls ?? [];
    if (toolCalls.length === 0) return response;
    for (const tc of toolCalls) {
      input.push({ type: "function_call", call_id: tc.call_id, name: tc.name, arguments: tc.arguments || "{}" });
      let output: string;
      if (tc.name === "manageMemory") {
        try {
          const args = JSON.parse(tc.arguments || "{}");
          const result = await processMemoryToolWithDB(
            fields,
            memoryValues,
            memoryState,
            loadState,
            args,
            baseContext,
            (ff, vv, ss, i) => processMemoryToolResponse(ff, vv, ss, i),
          );
          Object.assign(memoryValues, result.updatedMemoryValues);
          Object.assign(memoryState, result.updatedMemoryState);
          output = JSON.stringify({ results: result.results }).slice(0, 20000);
        } catch (err) {
          output = `manageMemory failed: ${err instanceof Error ? err.message : String(err)}`;
        }
      } else {
        output = `Unknown tool: ${tc.name}`;
      }
      input.push({ type: "function_call_output", call_id: tc.call_id, output });
    }
  }
  // Unreachable: the final step runs without tools, so it always returns above.
  throw new Error("context-aware summary did not produce a final response");
}

/**
 * Fire-and-forget summary generation. Does not throw.
 */
export function generateSessionSummaryAsync(sessionId: string): void {
  generateSessionSummary(sessionId).catch(err => {
    log(`[${sessionId}] async error: ${err instanceof Error ? err.message : String(err)}`);
  });
}
