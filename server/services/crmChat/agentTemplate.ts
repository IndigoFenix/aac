/**
 * agentTemplate.ts
 *
 * Builds the AgentLike object the CRM chat passes to ChatMessageManager.
 * The template is intentionally minimal:
 *  - No outbound tools (tools: {}) — no email, no spawn, no web search.
 *    The visitor is anonymous and the AI must not be a vector for sending
 *    arbitrary outbound traffic from prompt injection.
 *  - Only the Customer_* memory fields are exposed; the manageMemory tool is
 *    automatically attached by the framework when memoryFields is non-empty.
 *  - Intelligence/memory levels are kept low (cheap model, modest history).
 */

import type { AgentLike } from "../chat/prompt-kit";
import { CRM_MEMORY_FIELDS } from "../memory-schema/crm-memory-schema";
import { LIBRARY_TOPICS_FIELD } from "../memory-schema/topic-memory-schema";

const CRM_AGENT_NAME = "Aivota Sales Assistant";

export interface BuildCrmAgentArgs {
  /** The active system prompt (admin override or default). */
  systemPrompt: string;
  /** Greeting shown to brand-new visitors before they say anything. */
  greeting?: string;
}

export function buildCrmAgent({ systemPrompt, greeting }: BuildCrmAgentArgs): AgentLike {
  const agent: AgentLike = {
    name: CRM_AGENT_NAME,
    corePrompt: systemPrompt,
    greeting,
    intelligence: 1,
    memory: 2,
    // Customer_* visitor fields plus the shared knowledge library. The
    // library entries are filtered to those flagged crm_accessible at the
    // service layer — see crmChatService.baseContext.crmAccessibleOnly.
    memoryFields: [...CRM_MEMORY_FIELDS, LIBRARY_TOPICS_FIELD],
    // Defence-in-depth: explicitly empty. Adding a tool here means a new
    // outbound surface for an anonymous visitor — be extremely cautious.
    tools: {},
    library: [],
  };

  // Runtime assertion — if a future edit accidentally turns on an outbound
  // tool, fail loudly instead of silently exposing the internet to the visitor.
  assertNoOutboundTools(agent);

  return agent;
}

function assertNoOutboundTools(agent: AgentLike): void {
  const tools = (agent.tools ?? {}) as Record<string, { enabled?: boolean }>;
  const forbidden = ["webSearch", "email", "spawn", "rooms", "mapTools", "fdaLookup"];
  for (const key of forbidden) {
    if (tools[key]?.enabled) {
      throw new Error(`CRM agent must not enable outbound tool '${key}'`);
    }
  }
}
