/**
 * crmChatService.ts
 *
 * Orchestrates a single CRM chat turn. Mirrors what sessionService does for
 * authenticated chats, but with no user / student / institute context — the
 * "actor" is an anonymous landing-page visitor identified by ip_hash.
 *
 * The heavy lifting (system-prompt building, tool routing, memory tool, LLM
 * call, conversation history culling) is handled entirely by ChatMessageManager
 * — we just construct it with the right callbacks and let it run.
 */

import type { Request } from "express";
import { ChatMessageManager, type MdStreamEvent } from "../chat/chat-handler";
import { processMemoryToolWithDB } from "../chat/memory-db-bridge";
import { createDBMemoryProcessor } from "../chat/tool-router";
import { createMemoryLoadState } from "../chat/memory-db-bridge";
import { settingsRepository } from "../../repositories/settingsRepository";
import { crmRepository } from "../../repositories/crmRepository";
import { CRM_MEMORY_FIELDS } from "../memory-schema/crm-memory-schema";
import { LIBRARY_TOPICS_FIELD } from "../memory-schema/topic-memory-schema";
import type { AgentMemoryFieldWithDB } from "../chat/memory-types";
import { buildCrmAgent } from "./agentTemplate";
import { CRM_DEFAULT_SYSTEM_PROMPT } from "./prompts";
import { identifyVisitor, type IdentifiedVisitor } from "./identify";
import type { ChatMessage, ChatSession, ChatState, MessageResponse } from "@shared/schema";

/**
 * Per-customer USD cap on chat spend within a single calendar day. Exceeding
 * the cap returns a polite refusal until the next day. Tuned for gpt-4o-mini.
 */
export const CRM_DAILY_USD_CAP = 0.10;

export class CrmChatDisabledError extends Error {
  constructor() {
    super("CRM chat is disabled");
    this.name = "CrmChatDisabledError";
  }
}

export class CrmChatBlockedError extends Error {
  constructor() {
    super("Visitor is blocked");
    this.name = "CrmChatBlockedError";
  }
}

export class CrmChatBudgetExceededError extends Error {
  constructor() {
    super("Daily chat budget exceeded");
    this.name = "CrmChatBudgetExceededError";
  }
}

export interface CrmChatConfig {
  enabled: boolean;
}

export async function getCrmChatConfig(): Promise<CrmChatConfig> {
  const enabled = await settingsRepository.getCrmChatEnabled();
  return { enabled };
}

export interface CrmIdentifyResult {
  potentialCustomerId: string;
  isReturning: boolean;
  sessionId: string | null;
  history: ChatMessage[];
}

/**
 * Identify the visitor and (if a session is resumable) return its history so
 * the widget can render the prior conversation. Does not start a new session
 * unless one is needed to reply — that's done lazily in onMessage.
 */
export async function identifyAndPrepare(req: Request): Promise<CrmIdentifyResult> {
  const enabled = await settingsRepository.getCrmChatEnabled();
  if (!enabled) throw new CrmChatDisabledError();

  const visitor = await identifyVisitor(req);
  if (visitor.customer.isBlocked) throw new CrmChatBlockedError();

  const resumable = await crmRepository.findResumableSession(visitor.customer.id);
  return {
    potentialCustomerId: visitor.customer.id,
    isReturning: visitor.isReturning,
    sessionId: resumable?.id ?? null,
    history: resumable ? extractHistory(resumable) : [],
  };
}

export interface CrmOnMessageInput {
  req: Request;
  /** Customer id from client (localStorage). Server still re-derives ip_hash and verifies. */
  potentialCustomerId?: string;
  /** Existing session to continue. Omit to (find or) create. */
  sessionId?: string;
  /** User-typed text. */
  text: string;
}

export interface CrmOnMessageResult {
  potentialCustomerId: string;
  sessionId: string;
  message: ChatMessage;
  creditsUsed: number;
}

interface PreparedTurn {
  manager: ChatMessageManager;
  customerId: string;
  sessionId: string;
}

/**
 * Shared setup for every CRM turn. Resolves the visitor + session, builds the
 * memory processor and agent, and constructs the ChatMessageManager. After
 * this returns, the caller has appended the user message and either calls
 * getResponse (non-streaming) or getStreamingMdResponse (streaming).
 */
async function prepareCrmTurn(input: CrmOnMessageInput): Promise<PreparedTurn> {
  const enabled = await settingsRepository.getCrmChatEnabled();
  if (!enabled) throw new CrmChatDisabledError();

  // Always re-derive ip_hash from the request — the client-provided
  // potentialCustomerId is just a hint. We accept it only when its ip_hash
  // matches what we computed; otherwise we fall back to identifyVisitor.
  const visitor = await resolveVisitor(input);
  if (visitor.customer.isBlocked) throw new CrmChatBlockedError();

  const usedToday = await crmRepository.getCreditsUsedToday(visitor.customer.id);
  if (usedToday >= CRM_DAILY_USD_CAP) throw new CrmChatBudgetExceededError();

  // Resolve session: explicit > resumable > new.
  let session: ChatSession | undefined;
  if (input.sessionId) {
    const candidate = await crmRepository.getSessionById(input.sessionId);
    if (candidate?.crmPotentialCustomerId === visitor.customer.id) {
      session = candidate;
    }
  }
  if (!session) {
    session = await crmRepository.findResumableSession(visitor.customer.id);
  }
  if (!session) {
    session = await crmRepository.createSession(visitor.customer.id);
  }

  const systemPromptOverride = await settingsRepository.getCrmChatSystemPromptOverride();
  const systemPrompt =
    systemPromptOverride && systemPromptOverride.length > 0
      ? systemPromptOverride
      : CRM_DEFAULT_SYSTEM_PROMPT;

  const llmConfig = await settingsRepository.getLLMConfig("crm_chat");

  const agent = buildCrmAgent({ systemPrompt });

  // Seed memoryValues from the customer row's chat_memory blob. The framework
  // will mutate this object as the AI calls manageMemory, and our field-level
  // db ops persist back to the customer row.
  const memoryValues: Record<string, any> = JSON.parse(
    JSON.stringify(visitor.customer.chatMemory ?? {}),
  );

  const chatState: ChatState = (session.state as ChatState) ?? {
    history: [],
    conversationSummary: "",
    openedTopics: [],
    memoryState: { visible: [], page: {} },
  };
  const log: ChatMessage[] = (session.log as ChatMessage[]) ?? [];

  // Memory processor — same factory the authenticated chat uses.
  const memoryValuesRef = { current: memoryValues };
  const memoryStateRef = { current: chatState.memoryState };
  const loadStateRef = { current: createMemoryLoadState() };
  // crmAccessibleOnly gates the library fields — topic-memory-schema reads
  // this flag from ctx.all and filters to topics flagged crm_accessible.
  const baseContext = {
    crmPotentialCustomerId: visitor.customer.id,
    crmAccessibleOnly: true,
  };

  const fieldsForProcessor: AgentMemoryFieldWithDB[] = [
    ...CRM_MEMORY_FIELDS,
    LIBRARY_TOPICS_FIELD as AgentMemoryFieldWithDB,
  ];

  const memoryProcessor = createDBMemoryProcessor(
    processMemoryToolWithDB,
    fieldsForProcessor,
    memoryValuesRef,
    memoryStateRef,
    loadStateRef,
    baseContext,
  );

  const sessionId = session.id;

  const manager = new ChatMessageManager({
    agent,
    session,
    memoryValues,
    chatState,
    log,
    maxCredits: Math.max(0, CRM_DAILY_USD_CAP - usedToday),
    onUpdateMemoryValues: async () => {
      // Per-field db.write already persists to crm_potential_customers.chat_memory.
      // Nothing additional to do here.
    },
    onUpdateChatState: async (nextState, nextLog) => {
      await crmRepository.updateSessionState(sessionId, {
        state: nextState,
        log: nextLog,
      });
    },
    onCreditsUsed: async (credits) => {
      await crmRepository.addCredits(sessionId, credits);
    },
    providerConfig: llmConfig,
    memoryProcessor,
  });

  await manager.persistMessages([
    {
      role: "user",
      content: input.text,
      timestamp: Date.now(),
    },
  ]);

  return { manager, customerId: visitor.customer.id, sessionId };
}

/**
 * Non-streaming chat turn (legacy / tests). Returns the full assistant
 * message once it's ready. The streaming generator below is what the
 * controller actually uses.
 */
export async function onCrmMessage(input: CrmOnMessageInput): Promise<CrmOnMessageResult> {
  const { manager, customerId, sessionId } = await prepareCrmTurn(input);
  const response: MessageResponse = await manager.getResponse("text");
  return {
    potentialCustomerId: customerId,
    sessionId,
    message: response.message,
    creditsUsed: response.creditsUsed ?? 0,
  };
}

// ──────────────────────────────────────────────────────────────────
// Streaming
// ──────────────────────────────────────────────────────────────────

export type CrmStreamEvent =
  | { type: "session"; potentialCustomerId: string; sessionId: string }
  | { type: "text_delta"; text: string }
  | { type: "thinking"; text: string }
  | { type: "complete"; message: ChatMessage; creditsUsed: number; potentialCustomerId: string; sessionId: string };

export interface CrmOnMessageStreamingInput extends CrmOnMessageInput {
  signal?: AbortSignal;
}

/**
 * Streaming chat turn. Yields the same events the internal chat uses
 * (text_delta tokens, the final complete message), plus a one-time `session`
 * event up-front so the client can persist potentialCustomerId / sessionId
 * before any tokens arrive.
 *
 * The assistant message in the `complete` event holds markdown in
 * `content.md`, matching what the rest of the platform does with md replies.
 */
export async function* onCrmMessageStreaming(
  input: CrmOnMessageStreamingInput,
): AsyncGenerator<CrmStreamEvent> {
  const { manager, customerId, sessionId } = await prepareCrmTurn(input);

  yield { type: "session", potentialCustomerId: customerId, sessionId };

  for await (const event of manager.getStreamingMdResponse(input.signal) as AsyncGenerator<MdStreamEvent>) {
    if (event.type === "text_delta") {
      yield { type: "text_delta", text: event.text };
    } else if (event.type === "thinking") {
      yield { type: "thinking", text: event.text };
    } else if (event.type === "complete") {
      yield {
        type: "complete",
        message: event.message,
        creditsUsed: event.creditsUsed,
        potentialCustomerId: customerId,
        sessionId,
      };
    }
    // navigate / select_student events are not relevant for CRM (no client
    // surface for them) — drop silently.
  }
}

// ──────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────

async function resolveVisitor(input: CrmOnMessageInput): Promise<IdentifiedVisitor> {
  // Always identify by IP — that's the authoritative key. If the client also
  // sent potentialCustomerId, accept it only when it matches the IP-derived
  // customer (defends against tampering with localStorage).
  const visitor = await identifyVisitor(input.req);
  if (
    input.potentialCustomerId &&
    input.potentialCustomerId !== visitor.customer.id
  ) {
    // Mismatch: silently fall back to the IP-derived customer rather than
    // honoring the client's id. This is safer than 4xx-ing on a stale cookie.
  }
  return visitor;
}

function extractHistory(session: ChatSession): ChatMessage[] {
  const state = session.state as ChatState | null;
  return state?.history ?? [];
}
