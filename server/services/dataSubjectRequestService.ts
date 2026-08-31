// The register for data-subject ACCESS and AMENDMENT requests.
// AKIM appendix §18.3 (correct) / §18.4 (produce).
//
// Erasure is automated end to end. These two were not: they were handled by an
// engineer reading a mailbox, which is not a control and leaves nothing behind
// to show a regulator. `docs/AKIM_COMPLIANCE_ASSESSMENT.md` claimed a "72-hour
// handling" pipeline; this file is the first code that backs the claim.
//
// The row IS the evidence. `receivedAt`, `forwardDeadlineAt`, `forwardedAt`,
// `decidedAt` and `fulfilledAt` are what shows the window was met, and they are
// retained with the request rather than reconstructed from the audit log — the
// activity-log retention cron prunes rows on a regime clock and would eventually
// erase the proof. Audit events are written ALONGSIDE, because who did it and
// from where belongs in the same place as every other privileged act.
//
// Deliberately no clinician UI in v1: an admin-only API plus an hourly deadline
// sweep is what makes the obligation impossible to silently miss. A screen is
// worth building once there is traffic to put on it.

import { db } from "../db";
import {
  dataSubjectRequests,
  type DataSubjectRequest,
  type DataSubjectRequestKind,
  type DataSubjectRequestStatus,
} from "@shared/schema";
import { and, asc, desc, eq, isNull, lte, sql } from "drizzle-orm";
import { activityLogService } from "./activityLogService";
import { computeForwardDeadline, requestReference } from "./data-subject-deadlines";

export class DataSubjectRequestNotFound extends Error {
  constructor(id: string) {
    super(`Data-subject request ${id} not found`);
    this.name = "DataSubjectRequestNotFound";
  }
}

/** A transition the register refuses — e.g. deciding a request already withdrawn. */
export class DataSubjectRequestConflict extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DataSubjectRequestConflict";
  }
}

export interface OpenRequestInput {
  studentId: string;
  instituteId?: string | null;
  kind: DataSubjectRequestKind;
  /** Defaults to now. Supplied when a request arrived by post and is logged late. */
  receivedAt?: Date;
  requesterDescription?: string | null;
  // correct only
  targetTable?: string | null;
  targetRecordId?: string | null;
  targetField?: string | null;
  proposedValue?: string | null;
  currentValueSnapshot?: string | null;
  notes?: string | null;
}

export interface DecideInput {
  /** "accepted" / "rejected" / free prose — the substance of the answer. */
  decision: string;
  decisionReason?: string | null;
  /** The DATA SUBJECT's words, filed beside a record we declined to change. */
  statementOfDisagreement?: string | null;
  /** True when the amendment was made; false when refused. */
  accepted: boolean;
}

/** Statuses from which no further transition is accepted. */
const CLOSED_STATUSES: ReadonlySet<string> = new Set(["fulfilled", "denied", "withdrawn"]);

function assertOpenFor(request: DataSubjectRequest, action: string): void {
  if (CLOSED_STATUSES.has(request.status)) {
    throw new DataSubjectRequestConflict(
      `Cannot ${action}: request ${requestReference(request.id)} is already ${request.status}.`,
    );
  }
}

export class DataSubjectRequestService {
  /**
   * Record a request and start its clock.
   *
   * The deadline is FROZEN here — `computeForwardDeadline` is never called on
   * read. A policy change must not be able to rewrite the window a request that
   * already exists was held to.
   */
  async open(input: OpenRequestInput, actorUserId: string | null): Promise<DataSubjectRequest> {
    const receivedAt = input.receivedAt ?? new Date();
    const [row] = await db
      .insert(dataSubjectRequests)
      .values({
        studentId: input.studentId,
        instituteId: input.instituteId ?? null,
        kind: input.kind,
        status: "open",
        receivedAt,
        forwardDeadlineAt: computeForwardDeadline(receivedAt),
        requesterDescription: input.requesterDescription ?? null,
        targetTable: input.targetTable ?? null,
        targetRecordId: input.targetRecordId ?? null,
        targetField: input.targetField ?? null,
        proposedValue: input.proposedValue ?? null,
        currentValueSnapshot: input.currentValueSnapshot ?? null,
        notes: input.notes ?? null,
      })
      .returning();

    activityLogService.log({
      instituteId: input.instituteId ?? null,
      userId: actorUserId,
      eventType: "create",
      subjectType1: "data_subject_request",
      subjectId1: row.id,
      subjectType2: "student",
      subjectId2: input.studentId,
      details: {
        reference: requestReference(row.id),
        kind: row.kind,
        receivedAt: receivedAt.toISOString(),
        forwardDeadlineAt: row.forwardDeadlineAt.toISOString(),
      },
    });

    return row;
  }

  async get(id: string): Promise<DataSubjectRequest | null> {
    const [row] = await db.select().from(dataSubjectRequests).where(eq(dataSubjectRequests.id, id));
    return row ?? null;
  }

  async getOrThrow(id: string): Promise<DataSubjectRequest> {
    const row = await this.get(id);
    if (!row) throw new DataSubjectRequestNotFound(id);
    return row;
  }

  async list(filters: {
    status?: DataSubjectRequestStatus;
    studentId?: string;
    instituteId?: string;
    limit?: number;
  } = {}): Promise<DataSubjectRequest[]> {
    const conditions = [];
    if (filters.status) conditions.push(eq(dataSubjectRequests.status, filters.status));
    if (filters.studentId) conditions.push(eq(dataSubjectRequests.studentId, filters.studentId));
    if (filters.instituteId) conditions.push(eq(dataSubjectRequests.instituteId, filters.instituteId));

    const query = db.select().from(dataSubjectRequests);
    const filtered = conditions.length ? query.where(and(...conditions)) : query;
    return filtered.orderBy(desc(dataSubjectRequests.receivedAt)).limit(filters.limit ?? 200);
  }

  /**
   * Every request still owing a forward, whose deadline has passed.
   * Ordered oldest-first: the most overdue is the one to act on.
   */
  async listOverdueForward(now: Date = new Date()): Promise<DataSubjectRequest[]> {
    return db
      .select()
      .from(dataSubjectRequests)
      .where(
        and(
          isNull(dataSubjectRequests.forwardedAt),
          eq(dataSubjectRequests.status, "open"),
          lte(dataSubjectRequests.forwardDeadlineAt, now),
        ),
      )
      .orderBy(asc(dataSubjectRequests.forwardDeadlineAt));
  }

  /** Everything still awaiting a forward, overdue or not — the sweep's input. */
  async listAwaitingForward(): Promise<DataSubjectRequest[]> {
    return db
      .select()
      .from(dataSubjectRequests)
      .where(and(isNull(dataSubjectRequests.forwardedAt), eq(dataSubjectRequests.status, "open")))
      .orderBy(asc(dataSubjectRequests.forwardDeadlineAt));
  }

  /** The request reached the controller. This is the act the 72h window measures. */
  async markForwarded(
    id: string,
    actorUserId: string | null,
    opts: { forwardedAt?: Date; notes?: string | null } = {},
  ): Promise<DataSubjectRequest> {
    const existing = await this.getOrThrow(id);
    assertOpenFor(existing, "forward");
    const forwardedAt = opts.forwardedAt ?? new Date();

    const [row] = await db
      .update(dataSubjectRequests)
      .set({
        status: "forwarded",
        forwardedAt,
        notes: opts.notes ?? existing.notes,
        updatedAt: new Date(),
      })
      .where(eq(dataSubjectRequests.id, id))
      .returning();

    activityLogService.log({
      instituteId: existing.instituteId,
      userId: actorUserId,
      eventType: "update",
      subjectType1: "data_subject_request",
      subjectId1: id,
      subjectType2: "student",
      subjectId2: existing.studentId,
      details: {
        reference: requestReference(id),
        status: { from: existing.status, to: "forwarded" },
        forwardedAt: forwardedAt.toISOString(),
        // Whether we met the window, recorded at the moment we know it.
        onTime: forwardedAt <= existing.forwardDeadlineAt,
      },
    });

    return row;
  }

  /**
   * Answer an amendment request.
   *
   * A refusal is a legitimate outcome, but it is only lawful if it is reasoned
   * and if the subject can put their side beside the record — hence
   * `decisionReason` and `statementOfDisagreement` living on the same row as the
   * refusal itself, not in a mailbox.
   */
  async decide(
    id: string,
    input: DecideInput,
    actorUserId: string | null,
  ): Promise<DataSubjectRequest> {
    const existing = await this.getOrThrow(id);
    assertOpenFor(existing, "decide");
    if (existing.kind !== "correct") {
      throw new DataSubjectRequestConflict(
        `Only a "correct" request carries a decision; ${requestReference(id)} is "${existing.kind}".`,
      );
    }
    const now = new Date();
    const status: DataSubjectRequestStatus = input.accepted ? "fulfilled" : "denied";

    const [row] = await db
      .update(dataSubjectRequests)
      .set({
        status,
        decision: input.decision,
        decisionReason: input.decisionReason ?? null,
        statementOfDisagreement: input.statementOfDisagreement ?? existing.statementOfDisagreement,
        decidedByUserId: actorUserId,
        decidedAt: now,
        fulfilledAt: input.accepted ? now : existing.fulfilledAt,
        updatedAt: now,
      })
      .where(eq(dataSubjectRequests.id, id))
      .returning();

    activityLogService.log({
      instituteId: existing.instituteId,
      userId: actorUserId,
      eventType: "update",
      subjectType1: "data_subject_request",
      subjectId1: id,
      subjectType2: "student",
      subjectId2: existing.studentId,
      details: {
        reference: requestReference(id),
        status: { from: existing.status, to: status },
        // The decision text itself is on the row; the log records that a
        // decision happened, by whom, and whether the subject filed a statement.
        accepted: input.accepted,
        hasStatementOfDisagreement: Boolean(row.statementOfDisagreement),
      },
    });

    return row;
  }

  /**
   * Mark a produce request answered. Called after the bundle has been generated
   * and handed over; the `export` audit row is written by the caller that
   * actually produced the bytes (see the controller), so the log records the
   * disclosure at the point it happened rather than at the point it was filed.
   */
  async markFulfilled(
    id: string,
    actorUserId: string | null,
    details: Record<string, unknown> = {},
  ): Promise<DataSubjectRequest> {
    const existing = await this.getOrThrow(id);
    assertOpenFor(existing, "fulfil");
    const now = new Date();

    const [row] = await db
      .update(dataSubjectRequests)
      .set({ status: "fulfilled", fulfilledAt: now, updatedAt: now })
      .where(eq(dataSubjectRequests.id, id))
      .returning();

    activityLogService.log({
      instituteId: existing.instituteId,
      userId: actorUserId,
      eventType: "update",
      subjectType1: "data_subject_request",
      subjectId1: id,
      subjectType2: "student",
      subjectId2: existing.studentId,
      details: {
        reference: requestReference(id),
        status: { from: existing.status, to: "fulfilled" },
        ...details,
      },
    });

    return row;
  }

  /**
   * PHI left the system as a file, in answer to this request.
   *
   * Written on the STUDENT as subject 1 so it lands in the same place as every
   * other disclosure about that child — an accounting of disclosures that
   * skipped the subject-access copies would be missing the largest one.
   */
  logExport(
    studentId: string,
    actorUserId: string | null,
    details: Record<string, unknown>,
  ): void {
    activityLogService.log({
      userId: actorUserId,
      eventType: "export",
      subjectType1: "student",
      subjectId1: studentId,
      details: { format: "dsr-json", ...details },
    });
  }

  /** The requester dropped it. Not a refusal — nothing was decided. */
  async withdraw(
    id: string,
    actorUserId: string | null,
    reason?: string | null,
  ): Promise<DataSubjectRequest> {
    const existing = await this.getOrThrow(id);
    assertOpenFor(existing, "withdraw");
    const now = new Date();

    const [row] = await db
      .update(dataSubjectRequests)
      .set({
        status: "withdrawn",
        notes: reason ? `${existing.notes ? `${existing.notes}\n` : ""}Withdrawn: ${reason}` : existing.notes,
        updatedAt: now,
      })
      .where(eq(dataSubjectRequests.id, id))
      .returning();

    activityLogService.log({
      instituteId: existing.instituteId,
      userId: actorUserId,
      eventType: "update",
      subjectType1: "data_subject_request",
      subjectId1: id,
      subjectType2: "student",
      subjectId2: existing.studentId,
      details: {
        reference: requestReference(id),
        status: { from: existing.status, to: "withdrawn" },
      },
    });

    return row;
  }

  /**
   * Remember that the sweep has announced this (request, phase) so an hourly
   * cron does not send an hourly mail. A column rather than in-memory state:
   * the alarm has to survive a task restart, and under the multi-task ECS
   * profile the process that alerted may not be the one that runs next.
   */
  async recordAlert(id: string, kind: string, at: Date = new Date()): Promise<void> {
    await db
      .update(dataSubjectRequests)
      .set({ lastAlertKind: kind, lastAlertAt: at, updatedAt: sql`now()` })
      .where(eq(dataSubjectRequests.id, id));
  }
}

export const dataSubjectRequestService = new DataSubjectRequestService();
