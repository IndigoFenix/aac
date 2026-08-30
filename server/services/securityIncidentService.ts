// Security / privacy incident register.
//
// The AKIM information-security appendix §6 commits us to an immediate verbal
// and written notice within 48 hours of a security or cyber event, and an
// investigation report within 3 days of the event ending. Before this service
// those were promises with nothing behind them: `incidentTemplateService` could
// render a notification but nothing called it, no record of an incident existed,
// and nothing started a clock. A deadline that depends on someone remembering
// is not a control.
//
// What this owns:
//   * opening an incident, and deriving its deadlines ONCE, at open time
//   * the append-only timeline that the investigation report is assembled from
//   * recording that a party was notified, and when
//   * answering "what is overdue right now" for the sweep in maintenanceCrons
//
// What it deliberately does not own: sending the notification (that is the
// dispatcher, which composes this with incidentTemplateService and
// emailService) and deciding whether something IS an incident (a human does).
//
// Regulatory windows come from shared/regime/regimes.ts rather than being
// hardcoded — they differ per regime and the strictest one wins. The
// contractual window is separate and per-customer: AKIM's 48 hours is a
// contract term, not a regulation, and a different customer may have a
// different one.
//
// No subject identifiers are stored on the register. See the table comment in
// shared/schema.ts and docs/AKIM_REMEDIATION_PLAN.md.

import { db } from "../db";
import { and, asc, desc, eq, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import {
  securityIncidents,
  securityIncidentEvents,
  type SecurityIncident,
  type SecurityIncidentEvent,
} from "@shared/schema";
import { resolveBreachNotificationHours } from "@shared/regime/regimes";
import { activityLogService } from "./activityLogService";
import {
  DEFAULT_CONTRACTUAL_NOTIFY_HOURS,
  DEFAULT_INVESTIGATION_REPORT_DAYS,
  classifyOverdue,
  computeInvestigationReportDueAt,
  computeNotificationDeadlines,
  incidentReference,
  type OverdueObligation,
} from "./security-incident-deadlines";

export {
  DEFAULT_CONTRACTUAL_NOTIFY_HOURS,
  DEFAULT_INVESTIGATION_REPORT_DAYS,
  incidentReference,
};

export type SecurityIncidentKind = SecurityIncident["kind"];
export type SecurityIncidentSeverity = SecurityIncident["severity"];
export type SecurityIncidentStatus = SecurityIncident["status"];

/** Parties we owe a notification to. Each maps to a due/sent column pair. */
export type NotifiedParty = "regulator" | "customer";

export interface OpenIncidentInput {
  kind: SecurityIncidentKind;
  severity: SecurityIncidentSeverity;
  title: string;
  description?: string | null;
  /** When we became AWARE. Every window runs from here. Defaults to now. */
  discoveredAt?: Date;
  /** When it actually happened, if known and different from discovery. */
  occurredAt?: Date | null;
  /** Regime slugs in play — drives the regulator deadline. */
  regimes?: string[];
  affectedInstituteIds?: string[];
  affectedSubjectCount?: number | null;
  affectedScope?: string | null;
  /** Override the 48h contractual window; null means no contractual window. */
  contractualNotifyHours?: number | null;
  openedByAdminUserId?: string | null;
}

export interface UpdateIncidentInput {
  severity?: SecurityIncidentSeverity;
  status?: SecurityIncidentStatus;
  description?: string | null;
  containedAt?: Date | null;
  /** Setting this (re)derives the investigation-report deadline. */
  endedAt?: Date | null;
  affectedInstituteIds?: string[];
  affectedSubjectCount?: number | null;
  affectedScope?: string | null;
}

/** An incident with at least one deadline in the past and nothing sent. */
export interface OverdueIncident {
  incident: SecurityIncident;
  overdue: OverdueObligation[];
}

class SecurityIncidentService {
  /**
   * Open an incident and freeze its deadlines.
   *
   * Deadlines are computed here and stored, never re-derived on read: if the
   * regime registry changes next year, this incident must still show the
   * deadline it was actually held to.
   */
  async open(input: OpenIncidentInput): Promise<SecurityIncident> {
    const discoveredAt = input.discoveredAt ?? new Date();
    const regimes = input.regimes ?? [];

    const regulatorHours = resolveBreachNotificationHours(regimes);
    const contractualHours =
      input.contractualNotifyHours === undefined
        ? DEFAULT_CONTRACTUAL_NOTIFY_HOURS
        : input.contractualNotifyHours;

    const deadlines = computeNotificationDeadlines({
      discoveredAt,
      regulatorNotifyHours: regulatorHours,
      contractualNotifyHours: contractualHours,
    });

    const [row] = await db
      .insert(securityIncidents)
      .values({
        kind: input.kind,
        severity: input.severity,
        status: "open",
        title: input.title,
        description: input.description ?? null,
        discoveredAt,
        occurredAt: input.occurredAt ?? null,
        regimes,
        regulatorNotifyDueAt: deadlines.regulatorNotifyDueAt,
        customerNotifyDueAt: deadlines.customerNotifyDueAt,
        affectedInstituteIds: input.affectedInstituteIds ?? [],
        affectedSubjectCount: input.affectedSubjectCount ?? null,
        affectedScope: input.affectedScope ?? null,
        openedByAdminUserId: input.openedByAdminUserId ?? null,
      })
      .returning();

    await this.appendEvent(row.id, {
      kind: "opened",
      body: input.title,
      metadata: {
        regimes,
        regulatorNotifyHours: regulatorHours,
        contractualNotifyHours: contractualHours,
      },
      actorAdminUserId: input.openedByAdminUserId ?? null,
    });

    this.audit(row, "security_incident_opened", {
      kind: row.kind,
      severity: row.severity,
    });

    return row;
  }

  async getById(incidentId: string): Promise<SecurityIncident | undefined> {
    const [row] = await db
      .select()
      .from(securityIncidents)
      .where(eq(securityIncidents.id, incidentId))
      .limit(1);
    return row;
  }

  /** The timeline, oldest first — the order an investigation report wants. */
  async getTimeline(incidentId: string): Promise<SecurityIncidentEvent[]> {
    return db
      .select()
      .from(securityIncidentEvents)
      .where(eq(securityIncidentEvents.incidentId, incidentId))
      .orderBy(asc(securityIncidentEvents.createdAt));
  }

  async update(
    incidentId: string,
    patch: UpdateIncidentInput,
    actorAdminUserId?: string | null,
  ): Promise<SecurityIncident | undefined> {
    const before = await this.getById(incidentId);
    if (!before) return undefined;

    const values: Record<string, unknown> = { updatedAt: new Date() };
    if (patch.severity !== undefined) values.severity = patch.severity;
    if (patch.status !== undefined) values.status = patch.status;
    if (patch.description !== undefined) values.description = patch.description;
    if (patch.containedAt !== undefined) values.containedAt = patch.containedAt;
    if (patch.affectedInstituteIds !== undefined) {
      values.affectedInstituteIds = patch.affectedInstituteIds;
    }
    if (patch.affectedSubjectCount !== undefined) {
      values.affectedSubjectCount = patch.affectedSubjectCount;
    }
    if (patch.affectedScope !== undefined) values.affectedScope = patch.affectedScope;

    // The investigation-report clock starts when the event ENDS, so it can only
    // be set once we know that — which is why it is derived here and not at open.
    if (patch.endedAt !== undefined) {
      values.endedAt = patch.endedAt;
      values.investigationReportDueAt = computeInvestigationReportDueAt(patch.endedAt);
    }

    const [row] = await db
      .update(securityIncidents)
      .set(values)
      .where(eq(securityIncidents.id, incidentId))
      .returning();

    if (patch.status !== undefined && patch.status !== before.status) {
      await this.appendEvent(incidentId, {
        kind: "status_change",
        body: `${before.status} → ${patch.status}`,
        metadata: { from: before.status, to: patch.status },
        actorAdminUserId: actorAdminUserId ?? null,
      });
    }

    this.audit(row, "security_incident_updated", {
      changed: Object.keys(values).filter((k) => k !== "updatedAt"),
    });

    return row;
  }

  async addNote(
    incidentId: string,
    body: string,
    actorAdminUserId?: string | null,
  ): Promise<SecurityIncidentEvent> {
    return this.appendEvent(incidentId, {
      kind: "note",
      body,
      actorAdminUserId: actorAdminUserId ?? null,
    });
  }

  /**
   * Record that the sweep announced a deadline as approaching or blown.
   *
   * Written by the system, so no actor. `metadata.obligation` is what the
   * sweep reads back to avoid announcing the same thing every hour — the
   * timeline doubles as the de-duplication key, so the evidence trail and the
   * alert suppression cannot drift apart.
   */
  async recordDeadlineEvent(
    incidentId: string,
    detail: {
      phase: "approaching" | "missed";
      obligation: OverdueObligation;
      dueAt: Date | null;
    },
  ): Promise<SecurityIncidentEvent> {
    return this.appendEvent(incidentId, {
      kind: detail.phase === "missed" ? "deadline_missed" : "deadline_warning",
      body:
        detail.phase === "missed"
          ? `Deadline passed with nothing sent: ${detail.obligation}`
          : `Deadline approaching: ${detail.obligation}`,
      metadata: {
        obligation: detail.obligation,
        phase: detail.phase,
        dueAt: detail.dueAt ? detail.dueAt.toISOString() : null,
      },
      actorAdminUserId: null,
    });
  }

  /**
   * Record that a party has been notified. Called by the dispatcher AFTER the
   * message actually went out — this stamps the clock, it does not send.
   */
  async recordNotification(
    incidentId: string,
    party: NotifiedParty,
    detail: {
      channel: string;
      recipients?: string[];
      templateType?: string;
      sentAt?: Date;
    },
    actorAdminUserId?: string | null,
  ): Promise<SecurityIncident | undefined> {
    const sentAt = detail.sentAt ?? new Date();
    const column =
      party === "regulator"
        ? { regulatorNotifiedAt: sentAt }
        : { customerNotifiedAt: sentAt };

    const [row] = await db
      .update(securityIncidents)
      .set({ ...column, updatedAt: new Date() })
      .where(eq(securityIncidents.id, incidentId))
      .returning();
    if (!row) return undefined;

    await this.appendEvent(incidentId, {
      kind: "notification_sent",
      body: `Notified ${party} via ${detail.channel}`,
      metadata: {
        party,
        channel: detail.channel,
        recipients: detail.recipients ?? [],
        templateType: detail.templateType ?? null,
      },
      actorAdminUserId: actorAdminUserId ?? null,
    });

    this.audit(row, "security_incident_notification_sent", {
      party,
      channel: detail.channel,
    });

    return row;
  }

  /** Mark the investigation report as delivered (annex §6.3). */
  async recordInvestigationReport(
    incidentId: string,
    detail: { channel: string; recipients?: string[]; sentAt?: Date },
    actorAdminUserId?: string | null,
  ): Promise<SecurityIncident | undefined> {
    const sentAt = detail.sentAt ?? new Date();
    const [row] = await db
      .update(securityIncidents)
      .set({ investigationReportSentAt: sentAt, updatedAt: new Date() })
      .where(eq(securityIncidents.id, incidentId))
      .returning();
    if (!row) return undefined;

    await this.appendEvent(incidentId, {
      kind: "notification_sent",
      body: `Investigation report sent via ${detail.channel}`,
      metadata: {
        party: "investigation_report",
        channel: detail.channel,
        recipients: detail.recipients ?? [],
      },
      actorAdminUserId: actorAdminUserId ?? null,
    });

    this.audit(row, "security_incident_notification_sent", {
      party: "investigation_report",
      channel: detail.channel,
    });

    return row;
  }

  async close(
    incidentId: string,
    closureSummary: string,
    actorAdminUserId?: string | null,
  ): Promise<SecurityIncident | undefined> {
    const now = new Date();
    const [row] = await db
      .update(securityIncidents)
      .set({ status: "closed", closedAt: now, closureSummary, updatedAt: now })
      .where(eq(securityIncidents.id, incidentId))
      .returning();
    if (!row) return undefined;

    await this.appendEvent(incidentId, {
      kind: "closed",
      body: closureSummary,
      actorAdminUserId: actorAdminUserId ?? null,
    });

    this.audit(row, "security_incident_closed", { kind: row.kind });
    return row;
  }

  /**
   * Every incident with a deadline that has passed and nothing sent against it.
   *
   * Closed and dismissed incidents are excluded: a closed incident's missed
   * deadline is history, and re-alerting on it forever would train people to
   * ignore the alert.
   */
  async listOverdue(now: Date = new Date()): Promise<OverdueIncident[]> {
    const rows = await db
      .select()
      .from(securityIncidents)
      .where(
        and(
          sql`${securityIncidents.status} NOT IN ('closed', 'dismissed')`,
          or(
            and(
              isNotNull(securityIncidents.regulatorNotifyDueAt),
              lte(securityIncidents.regulatorNotifyDueAt, now),
              isNull(securityIncidents.regulatorNotifiedAt),
            ),
            and(
              isNotNull(securityIncidents.customerNotifyDueAt),
              lte(securityIncidents.customerNotifyDueAt, now),
              isNull(securityIncidents.customerNotifiedAt),
            ),
            and(
              isNotNull(securityIncidents.investigationReportDueAt),
              lte(securityIncidents.investigationReportDueAt, now),
              isNull(securityIncidents.investigationReportSentAt),
            ),
          ),
        ),
      )
      .orderBy(asc(securityIncidents.discoveredAt));

    // The SQL above narrows; classifyOverdue is the single source of truth for
    // WHICH obligation is late, so the query and the sweep cannot disagree.
    return rows.map((incident) => ({
      incident,
      overdue: classifyOverdue(incident, now),
    }));
  }

  /**
   * Every incident, closed ones included, newest discovery first.
   *
   * The register is evidence: a closed incident is still the thing we hand a
   * customer or a regulator later, so it stays retrievable rather than being
   * filtered out of existence once it stops being urgent.
   */
  async listAll(): Promise<SecurityIncident[]> {
    return db
      .select()
      .from(securityIncidents)
      .orderBy(desc(securityIncidents.discoveredAt));
  }

  /** Open incidents, oldest discovery first — the ones nearest their deadline. */
  async listOpen(): Promise<SecurityIncident[]> {
    return db
      .select()
      .from(securityIncidents)
      .where(sql`${securityIncidents.status} NOT IN ('closed', 'dismissed')`)
      .orderBy(asc(securityIncidents.discoveredAt));
  }

  /**
   * Append to the timeline. Awaited rather than fire-and-forget: unlike an
   * activity-log row, a lost timeline entry is a hole in the evidence we hand
   * a customer, and the caller should fail if it cannot be written.
   */
  private async appendEvent(
    incidentId: string,
    entry: {
      kind: SecurityIncidentEvent["kind"];
      body?: string | null;
      metadata?: Record<string, unknown> | null;
      actorAdminUserId?: string | null;
    },
  ): Promise<SecurityIncidentEvent> {
    const [row] = await db
      .insert(securityIncidentEvents)
      .values({
        incidentId,
        kind: entry.kind,
        body: entry.body ?? null,
        metadata: entry.metadata ?? null,
        actorAdminUserId: entry.actorAdminUserId ?? null,
      })
      .returning();
    return row;
  }

  /** Mirror a transition into the audit log. Fire-and-forget by design. */
  private audit(
    incident: SecurityIncident,
    eventType:
      | "security_incident_opened"
      | "security_incident_updated"
      | "security_incident_notification_sent"
      | "security_incident_closed",
    details: Record<string, unknown>,
  ): void {
    activityLogService.log({
      eventType,
      subjectType1: "security_incident",
      subjectId1: incident.id,
      // Only when unambiguous — a multi-customer incident has no single
      // institute to attribute the row to.
      subjectType2: incident.affectedInstituteIds.length === 1 ? "institute" : null,
      subjectId2:
        incident.affectedInstituteIds.length === 1 ? incident.affectedInstituteIds[0] : null,
      details: { reference: incidentReference(incident.seq), ...details },
    });
  }
}

export const securityIncidentService = new SecurityIncidentService();
