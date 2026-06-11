/**
 * sessionSummary.ts
 *
 * Generates a short title + summary for a chat session so that deep-analysis
 * session search (memory field Context_StudentSessions / Context_UserSessions)
 * has something meaningful to match against.
 *
 * Idempotent: if the session already has both title and summary, no work is done.
 * Safe to call in the background (errors are logged, not thrown).
 */

import { db } from "../db";
import { chatSessions, type ChatMessage } from "@shared/schema";
import type { PendingMessage } from "./dual-agent/types";
import { eq } from "drizzle-orm";
import { getStructuredProvider } from "./providers/provider-factory";
import type { JSONSchema, GPTInputItem } from "./chat/gpt";
import { settingsRepository } from "../repositories/settingsRepository";
import { chargeModelUsage } from "./credit-ledger";
import fs from "fs";
import path from "path";

const LOG_FILE = path.resolve(process.cwd(), "server", "session-summary-debug.log");
function log(msg: string) {
  try {
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`);
  } catch {}
}

const MAX_MESSAGES_IN_CONTEXT = 40;
const MAX_CHARS_PER_MESSAGE = 500;

function messageText(m: ChatMessage): string {
  const c = m.content;
  if (typeof c === "string") return c;
  if (c && typeof c === "object") {
    return c.text || c.md || c.html || "";
  }
  return "";
}

function buildTranscript(messages: ChatMessage[]): string {
  const filtered = messages.filter(m => m.role !== "tool" && m.role !== "system");
  const slice = filtered.length <= MAX_MESSAGES_IN_CONTEXT
    ? filtered
    : [
        ...filtered.slice(0, MAX_MESSAGES_IN_CONTEXT / 2),
        ...filtered.slice(-MAX_MESSAGES_IN_CONTEXT / 2),
      ];
  return slice
    .map(m => {
      const text = messageText(m).slice(0, MAX_CHARS_PER_MESSAGE);
      return `${m.role.toUpperCase()}: ${text}`;
    })
    .join("\n");
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
        .set({ summary: "No messages.", importance: 0, ...(keepTitle ? {} : { title: "(empty session)" }) })
        .where(eq(chatSessions.id, sessionId));
      return;
    }

    const transcript = buildTranscript(messages);
    const cfg = await settingsRepository.getLLMConfig("clinician");
    const provider = getStructuredProvider(cfg.provider);

    const input: GPTInputItem[] = [
      {
        type: "message",
        role: "user",
        content: `Summarize the following session transcript.\n\nChat mode: ${session.chatMode}\n\nTranscript:\n${transcript}`,
      },
    ];

    const response = await provider.structuredComplete({
      model: cfg.model,
      input,
      instructions:
        "You are summarizing a chat session transcript for later retrieval. Produce a concise title, a 2-4 sentence summary, and an importance score (0-3). Focus on topics, outcomes, and notable events. Do not invent facts.",
      schemaName: "SessionSummary",
      schema: SUMMARY_SCHEMA,
      maxTokens: 400,
    });

    await chargeModelUsage({
      provider: cfg.provider,
      model: cfg.model,
      promptTokens: response.promptTokens || 0,
      completionTokens: response.completionTokens || 0,
      cachedTokens: response.cachedTokens || 0,
      cacheCreationTokens: response.cacheCreationTokens || 0,
      sessionId,
      studentId: session.studentId,
      userId: session.userId,
      category: "session-summary",
      label: "session-summary",
    });

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
      .set({ summary, importance, ...(keepTitle ? {} : { title }) })
      .where(eq(chatSessions.id, sessionId));
    log(`[${sessionId}] summary generated (importance=${importance}${keepTitle ? ", title kept (manual)" : ""})`);
  } catch (err) {
    log(`[${sessionId}] error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Fire-and-forget summary generation. Does not throw.
 */
export function generateSessionSummaryAsync(sessionId: string): void {
  generateSessionSummary(sessionId).catch(err => {
    log(`[${sessionId}] async error: ${err instanceof Error ? err.message : String(err)}`);
  });
}
