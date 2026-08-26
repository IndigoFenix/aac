// Per-request read audit for student-scoped PHI.
//
// §164.312(b) / §164.308(a)(1)(ii)(D): a breach investigation must be able to
// answer "who looked at this student, and when". Until 2026-08-26 only
// single-record report GETs and cross-institute share reads fired `view`
// rows; a clinician's owned reads of incidents, programs, contacts, photos,
// boards, transcripts and every AAC memory read left no application record,
// and ALB/CloudWatch logs carry no principal.
//
// This middleware answers the question at the ROUTE level with one row per
// request: `{ user, institute?, view, student, details.route }`. It does not
// know which fields were read — that is what the per-controller `view` rows
// still add where they exist — but it is complete over the surface, and the
// route name says what kind of record it was.
//
// Coalescing: the AAC device polls some of these routes every few seconds, so
// identical (user, route, student) reads are logged at most once per
// COALESCE_WINDOW_MS per process. That bounds volume to a handful of rows per
// student per session while still recording every distinct access.

import type { Request, Response, NextFunction, RequestHandler } from "express";
import { activityLogService } from "../services/activityLogService";

export const COALESCE_WINDOW_MS = 5 * 60 * 1000;
const MAX_SEEN = 20_000;

/** How a matched path maps to an audit row. */
export interface PhiReadRule {
  /** Human-stable label recorded in `details.route`. */
  route: string;
  /** Matched against `req.path` (no query string). */
  pattern: RegExp;
  /** Capture-group index holding the student id, if the path carries one. */
  studentGroup?: number;
  /** Query-string key holding the student id, if it travels there instead. */
  studentQuery?: string;
}

/**
 * The student-scoped GET surface. Every entry is a route whose 2xx response
 * carries PHI about one student. Keep this list in sync when adding routes;
 * server/tests/phi-read-audit.test.ts pins the matcher.
 */
export const PHI_READ_RULES: PhiReadRule[] = [
  { route: "student", pattern: /^\/api\/students\/([^/]+)$/, studentGroup: 1 },
  { route: "student.reports", pattern: /^\/api\/students\/([^/]+)\/reports(?:\/.*)?$/, studentGroup: 1 },
  { route: "student.incidents", pattern: /^\/api\/students\/([^/]+)\/incidents$/, studentGroup: 1 },
  { route: "student.programs", pattern: /^\/api\/students\/([^/]+)\/programs(?:\/.*)?$/, studentGroup: 1 },
  { route: "student.contacts", pattern: /^\/api\/(?:students|biometric\/students)\/([^/]+)\/contacts$/, studentGroup: 1 },
  { route: "student.linked-users", pattern: /^\/api\/students\/([^/]+)\/(?:users|linked-users)$/, studentGroup: 1 },
  { route: "student.consent", pattern: /^\/api\/consent\/students\/([^/]+)(?:\/.*)?$/, studentGroup: 1 },
  { route: "student.photos", pattern: /^\/api\/photos\/student\/([^/]+)$/, studentGroup: 1 },
  { route: "student.boards", pattern: /^\/api\/boards\/student\/([^/]+)$/, studentGroup: 1 },
  { route: "aac.photos", pattern: /^\/api\/aac\/photos$/, studentQuery: "studentId" },
  { route: "aac.known-people", pattern: /^\/api\/aac\/students\/([^/]+)\/known-people$/, studentGroup: 1 },
  { route: "aac.people-directory", pattern: /^\/api\/aac\/students\/([^/]+)\/people-directory$/, studentGroup: 1 },
  { route: "aac.person-photo", pattern: /^\/api\/aac\/students\/([^/]+)\/people\/[^/]+\/photo$/, studentGroup: 1 },
  { route: "aac.dual-session", pattern: /^\/api\/aac\/dual\/session\/[^/]+$/, studentQuery: "studentId" },
  { route: "deep-analysis.list", pattern: /^\/api\/deep-analysis$/, studentQuery: "studentId" },
];

/** Pure matcher — exported for the unit test. */
export function matchPhiRead(
  path: string,
  query: Record<string, unknown>,
): { route: string; studentId: string | null } | null {
  for (const rule of PHI_READ_RULES) {
    const m = rule.pattern.exec(path);
    if (!m) continue;
    let studentId: string | null = null;
    if (rule.studentGroup !== undefined) studentId = m[rule.studentGroup] ?? null;
    else if (rule.studentQuery) {
      const q = query[rule.studentQuery];
      studentId = typeof q === "string" && q ? q : null;
    }
    return { route: rule.route, studentId };
  }
  return null;
}

/** Bounded (user, route, student) → lastLoggedAt map. Exported for tests. */
export class ReadCoalescer {
  private seen = new Map<string, number>();
  constructor(private windowMs: number = COALESCE_WINDOW_MS) {}

  /** True the first time a key is seen within the window; false on repeats. */
  shouldLog(key: string, now: number = Date.now()): boolean {
    const last = this.seen.get(key);
    if (last !== undefined && now - last < this.windowMs) return false;
    if (this.seen.size >= MAX_SEEN) this.evict(now);
    this.seen.set(key, now);
    return true;
  }

  private evict(now: number): void {
    for (const [k, t] of this.seen) {
      if (now - t >= this.windowMs) this.seen.delete(k);
    }
    // Still full (a burst inside one window): drop the oldest half.
    if (this.seen.size >= MAX_SEEN) {
      let n = 0;
      for (const k of this.seen.keys()) {
        this.seen.delete(k);
        if (++n >= MAX_SEEN / 2) break;
      }
    }
  }
}

const coalescer = new ReadCoalescer();

export function phiReadAudit(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      next();
      return;
    }
    res.on("finish", () => {
      if (res.statusCode < 200 || res.statusCode >= 300) return;
      const userId = (req.user as any)?.id as string | undefined;
      if (!userId) return;
      const hit = matchPhiRead(req.path, req.query as Record<string, unknown>);
      if (!hit || !hit.studentId) return;
      if (!coalescer.shouldLog(`${userId}|${hit.route}|${hit.studentId}`)) return;
      activityLogService.log({
        userId,
        instituteId: typeof req.query.instituteId === "string" ? req.query.instituteId : null,
        eventType: "view",
        subjectType1: "student",
        subjectId1: hit.studentId,
        details: { route: hit.route },
      });
    });
    next();
  };
}
