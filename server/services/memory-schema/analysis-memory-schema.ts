/**
 * analysis-memory-schema.ts
 *
 * Exposes past deep analyses to the LLM as a read-only memory map:
 *   Context_DeepAnalyses — previous deep-analysis reports for the student.
 *
 * list() returns summaries (id, createdAt, status, title, summary).
 * get()  returns the full report including reportMarkdown.
 *
 * Supports search on title + summary (trigram GIN index, migration 0058)
 * and dateFrom/dateTo on createdAt.
 */

import { and, eq, desc, sql, ilike, gte, lte, or } from "drizzle-orm";
import { db } from "../../db";
import { deepAnalyses } from "@shared/schema";
import {
  type AgentMemoryFieldMapWithDB,
  type AgentMemoryFieldWithDB,
  type DBOperationContext,
  type ListResult,
  type PaginationParams,
  type ListFilters,
} from "../chat/memory-types";
import { withInstituteVisibility, type AccessCtx } from "../sharing/visibility";
import {
  recordShareDerivedView,
  recordShareDerivedViewSingle,
} from "../sharing/audit";

interface AnalysisSummaryRow {
  id: string;
  createdAt: string;
  status: string;
  title: string | null;
  summary: string | null;
}

interface AnalysisFullRow extends AnalysisSummaryRow {
  completedAt: string | null;
  model: string;
  specialInstructions: string | null;
  reportMarkdown: string | null;
  error: string | null;
  thinkingTokens: number;
  inputTokens: number;
  outputTokens: number;
}

function buildWhere(studentId: string, filters?: ListFilters, accessCtx?: AccessCtx) {
  const conds: any[] = [eq(deepAnalyses.studentId, studentId)];
  if (accessCtx) {
    conds.push(withInstituteVisibility(deepAnalyses, accessCtx, "deep_analysis"));
  }
  if (filters?.dateFrom) {
    const d = new Date(filters.dateFrom);
    if (!Number.isNaN(d.getTime())) conds.push(gte(deepAnalyses.createdAt, d));
  }
  if (filters?.dateTo) {
    const d = new Date(filters.dateTo);
    if (!Number.isNaN(d.getTime())) conds.push(lte(deepAnalyses.createdAt, d));
  }
  if (filters?.search) {
    const pat = `%${filters.search}%`;
    conds.push(or(ilike(deepAnalyses.title, pat), ilike(deepAnalyses.summary, pat))!);
  }
  return and(...conds);
}

async function listAnalyses(
  ctx: DBOperationContext,
  page: PaginationParams,
  filters: ListFilters | undefined,
): Promise<ListResult<AnalysisSummaryRow>> {
  const studentId = ctx.all.studentId;
  if (!studentId) return { items: [], total: 0, keys: [] };
  const accessCtx = ctx.all.accessCtx as AccessCtx | undefined;

  const where = buildWhere(studentId, filters, accessCtx);

  const rows = await db
    .select({
      id: deepAnalyses.id,
      studentId: deepAnalyses.studentId,
      instituteId: deepAnalyses.instituteId,
      createdAt: deepAnalyses.createdAt,
      status: deepAnalyses.status,
      title: deepAnalyses.title,
      summary: deepAnalyses.summary,
    })
    .from(deepAnalyses)
    .where(where)
    .orderBy(desc(deepAnalyses.createdAt))
    .offset(page.offset)
    .limit(page.limit);

  const [{ total }] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(deepAnalyses)
    .where(where);

  if (accessCtx) recordShareDerivedView(accessCtx, "deep_analysis", rows);

  const items: AnalysisSummaryRow[] = rows.map(r => ({
    id: r.id,
    createdAt: r.createdAt.toISOString(),
    status: r.status,
    title: r.title,
    summary: r.summary,
  }));
  const keys = items.map(i => i.id);

  return { items, total, keys };
}

async function getAnalysis(
  ctx: DBOperationContext,
  key: string | number,
): Promise<AnalysisFullRow | undefined> {
  const studentId = ctx.all.studentId;
  if (!studentId) return undefined;
  const accessCtx = ctx.all.accessCtx as AccessCtx | undefined;

  const conds: any[] = [eq(deepAnalyses.id, String(key)), eq(deepAnalyses.studentId, studentId)];
  if (accessCtx) {
    conds.push(withInstituteVisibility(deepAnalyses, accessCtx, "deep_analysis"));
  }

  const [row] = await db
    .select()
    .from(deepAnalyses)
    .where(and(...conds))
    .limit(1);
  if (!row) return undefined;
  if (accessCtx) recordShareDerivedViewSingle(accessCtx, "deep_analysis", row);

  return {
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
    status: row.status,
    title: row.title,
    summary: row.summary,
    model: row.model,
    specialInstructions: row.specialInstructions,
    reportMarkdown: row.reportMarkdown,
    error: row.error,
    thinkingTokens: row.thinkingTokens,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
  };
}

export const ANALYSIS_MEMORY_FIELDS: AgentMemoryFieldWithDB[] = [
  {
    id: "Context_DeepAnalyses",
    type: "map",
    title: "Deep Analyses",
    description:
      "Past deep-analysis reports for this student. Keys are analysis IDs. view on a specific key loads the full report. Supports search over title/summary and dateFrom/dateTo.",
    readOnly: true,
    displayKey: "id",
    searchTable: "deep_analyses",
    searchable: { fields: ["title", "summary"] },
    dateFilterable: { field: "createdAt" },
    values: {
      id: "Context_DeepAnalyses_item",
      type: "object",
      properties: {},
      additionalProperties: true,
    },
    db: {
      list: listAnalyses,
      get: getAnalysis,
      write: async () => { throw new Error("Deep analyses are read-only from memory."); },
      add: async () => { throw new Error("Deep analyses are read-only from memory."); },
      delete: async () => { throw new Error("Deep analyses are read-only from memory."); },
      clear: async () => { throw new Error("Deep analyses are read-only from memory."); },
    },
  } as AgentMemoryFieldMapWithDB,
];
