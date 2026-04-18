/**
 * session-memory-schema.ts
 *
 * Exposes past chat sessions to the LLM as two memory maps:
 * - Context_StudentSessions: sessions in AAC mode (chatMode === "aac")
 * - Context_UserSessions:    sessions in any other mode (non-AAC)
 *
 * Both support:
 *   searchable   on title + summary (trigram GIN index, migration 0058)
 *   dateFilterable on createdAt
 *
 * list() returns lightweight summaries (id, date, chatMode, title, summary, importance).
 * get()  returns the full record including the message log.
 *
 * Partial writability: the deep-analysis agent can update `title`, `summary`, and
 * `importance` on individual session records — its broader awareness across
 * multiple sessions + student history makes it better-placed than the per-session
 * cheap-model summarizer. All other fields (messages, state, chatMode, dates)
 * stay read-only. Enforced in the `update` op below with a field allowlist.
 */

import { and, eq, desc, sql, ilike, gte, lte, or } from "drizzle-orm";
import { db } from "../../db";
import { chatSessions } from "@shared/schema";
import {
  type AgentMemoryFieldMapWithDB,
  type AgentMemoryFieldWithDB,
  type DBOperationContext,
  type ListResult,
  type PaginationParams,
  type ListFilters,
} from "../chat/memory-types";

// ---------------------------------------------------------------------------
// Shared row types
// ---------------------------------------------------------------------------

interface SessionSummaryRow {
  id: string;
  createdAt: string;       // ISO
  chatMode: string;
  title: string | null;
  summary: string | null;
  importance: number;
}

interface SessionFullRow extends SessionSummaryRow {
  messages: unknown[];     // session.log
  state: unknown;
}

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

function buildWhere(studentId: string, isAAC: boolean, filters?: ListFilters) {
  const conds: any[] = [
    eq(chatSessions.studentId, studentId),
    isAAC ? eq(chatSessions.chatMode, "aac") : sql`${chatSessions.chatMode} <> 'aac'`,
  ];

  if (filters?.dateFrom) {
    const d = new Date(filters.dateFrom);
    if (!Number.isNaN(d.getTime())) conds.push(gte(chatSessions.createdAt, d));
  }
  if (filters?.dateTo) {
    const d = new Date(filters.dateTo);
    if (!Number.isNaN(d.getTime())) conds.push(lte(chatSessions.createdAt, d));
  }
  if (filters?.search) {
    const pat = `%${filters.search}%`;
    conds.push(or(ilike(chatSessions.title, pat), ilike(chatSessions.summary, pat))!);
  }
  return and(...conds);
}

async function listSessions(
  ctx: DBOperationContext,
  page: PaginationParams,
  filters: ListFilters | undefined,
  isAAC: boolean,
): Promise<ListResult<SessionSummaryRow>> {
  const studentId = ctx.all.studentId;
  if (!studentId) return { items: [], total: 0, keys: [] };

  const where = buildWhere(studentId, isAAC, filters);

  const rows = await db
    .select({
      id: chatSessions.id,
      createdAt: chatSessions.createdAt,
      chatMode: chatSessions.chatMode,
      title: chatSessions.title,
      summary: chatSessions.summary,
      importance: chatSessions.importance,
    })
    .from(chatSessions)
    .where(where)
    // Sort milestones first, then recency as tiebreaker. Deep-analysis agents can
    // still filter by date to ask "what happened recently?" and paginate from there.
    .orderBy(desc(chatSessions.importance), desc(chatSessions.createdAt))
    .offset(page.offset)
    .limit(page.limit);

  const [{ total }] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(chatSessions)
    .where(where);

  const items: SessionSummaryRow[] = rows.map(r => ({
    id: r.id,
    createdAt: r.createdAt.toISOString(),
    chatMode: r.chatMode,
    title: r.title,
    summary: r.summary,
    importance: r.importance,
  }));
  const keys = items.map(i => i.id);

  return { items, total, keys };
}

async function getSession(
  ctx: DBOperationContext,
  key: string | number,
  isAAC: boolean,
): Promise<SessionFullRow | undefined> {
  const studentId = ctx.all.studentId;
  if (!studentId) return undefined;

  const [row] = await db
    .select()
    .from(chatSessions)
    .where(
      and(
        eq(chatSessions.id, String(key)),
        eq(chatSessions.studentId, studentId),
        isAAC ? eq(chatSessions.chatMode, "aac") : sql`${chatSessions.chatMode} <> 'aac'`,
      ),
    )
    .limit(1);
  if (!row) return undefined;

  return {
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    chatMode: row.chatMode,
    title: row.title,
    summary: row.summary,
    importance: row.importance,
    messages: Array.isArray(row.log) ? row.log : [],
    state: row.state,
  };
}

// Sub-field writability allowlist. Values passed by memory-db-bridge will be
// { [propertyName]: value } when the LLM sets a single sub-path, or a partial
// object when it sets the whole record. Either way, we pick out only these keys.
const WRITABLE_SESSION_FIELDS = ["title", "summary", "importance"] as const;

async function updateSession(
  ctx: DBOperationContext,
  key: string | number,
  partial: Record<string, unknown>,
  isAAC: boolean,
): Promise<SessionFullRow> {
  const studentId = ctx.all.studentId;
  if (!studentId) throw new Error("updateSession: studentId required in context");

  const allowed: Record<string, unknown> = {};
  if (partial && typeof partial === "object") {
    if (typeof partial.title === "string") allowed.title = partial.title.slice(0, 200);
    if (typeof partial.summary === "string") allowed.summary = partial.summary;
    if (partial.importance !== undefined) {
      const v = Number(partial.importance);
      if (Number.isInteger(v) && v >= 0 && v <= 3) allowed.importance = v;
    }
  }

  if (Object.keys(allowed).length === 0) {
    throw new Error(
      `Only ${WRITABLE_SESSION_FIELDS.join(", ")} can be modified on session records. ` +
      `Other fields (messages, state, chatMode, dates) are read-only.`
    );
  }

  await db
    .update(chatSessions)
    .set(allowed)
    .where(
      and(
        eq(chatSessions.id, String(key)),
        eq(chatSessions.studentId, studentId),
        isAAC ? eq(chatSessions.chatMode, "aac") : sql`${chatSessions.chatMode} <> 'aac'`,
      ),
    );

  const updated = await getSession(ctx, key, isAAC);
  if (!updated) throw new Error(`Session ${key} not found after update (wrong student or chatMode?)`);
  return updated;
}

// ---------------------------------------------------------------------------
// Field factories
// ---------------------------------------------------------------------------

const sessionDbOps = (isAAC: boolean) => ({
  list: (ctx: DBOperationContext, page: PaginationParams, filters?: ListFilters) =>
    listSessions(ctx, page, filters, isAAC),
  get: (ctx: DBOperationContext, key: string | number) => getSession(ctx, key, isAAC),
  update: (ctx: DBOperationContext, key: string | number, value: any) =>
    updateSession(ctx, key, value as Record<string, unknown>, isAAC),
  // Whole-object writes and structural mutations are blocked — sessions are created by
  // the chat runtime, not by the LLM. Only the three fields above can be changed.
  write: async () => { throw new Error("Sessions cannot be created or replaced through memory."); },
  add: async () => { throw new Error("Sessions cannot be created through memory."); },
  delete: async () => { throw new Error("Sessions cannot be deleted through memory."); },
  clear: async () => { throw new Error("Sessions cannot be cleared through memory."); },
});

const sessionValueSchema = (suffix: string) => ({
  id: `Context_${suffix}Sessions_item`,
  type: "object" as const,
  additionalProperties: true,
  // Properties are declared primarily so the LLM knows the writable shape;
  // enforcement lives in updateSession's allowlist.
  properties: {
    title: {
      id: "title",
      type: "string" as const,
      description: "Short human-readable title for this session. Writable — update as understanding improves.",
    },
    summary: {
      id: "summary",
      type: "string" as const,
      description: "2-4 sentence summary. Writable — you may rewrite this when you have a better view across sessions.",
    },
    importance: {
      id: "importance",
      type: "integer" as const,
      enum: [0, 1, 2, 3],
      description:
        "0 = nothing happened, can be deleted. 1 = routine. 2 = potentially interesting. 3 = major milestone. Writable.",
    },
  },
});

export const SESSION_MEMORY_FIELDS: AgentMemoryFieldWithDB[] = [
  {
    id: "Context_StudentSessions",
    type: "map",
    title: "Student AAC Sessions",
    description:
      "Past AAC sessions the student has had with the device. Keys are session IDs (UUIDs). view on a specific key loads the full transcript. Supports search over title/summary and dateFrom/dateTo filters. You may update title, summary, and importance on any entry — other fields are read-only.",
    displayKey: "id",
    searchTable: "chat_sessions",
    searchable: { fields: ["title", "summary"] },
    dateFilterable: { field: "createdAt" },
    values: sessionValueSchema("Student"),
    db: sessionDbOps(true),
  } as AgentMemoryFieldMapWithDB,
  {
    id: "Context_UserSessions",
    type: "map",
    title: "Clinician / User Sessions",
    description:
      "Past non-AAC chat sessions (clinician chat, docuslp, etc.) related to this student. Keys are session IDs. Supports search over title/summary and dateFrom/dateTo filters. You may update title, summary, and importance on any entry — other fields are read-only.",
    displayKey: "id",
    searchTable: "chat_sessions",
    searchable: { fields: ["title", "summary"] },
    dateFilterable: { field: "createdAt" },
    values: sessionValueSchema("User"),
    db: sessionDbOps(false),
  } as AgentMemoryFieldMapWithDB,
];
