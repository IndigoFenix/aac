/**
 * Security Incident Controller
 *
 * The operator's surface onto the incident register. Gated to admins holding
 * the `security-incidents` section permission (or the `"*"` wildcard).
 *
 * The point of this layer is that opening an incident and sending a breach
 * notification must be possible from a browser at 2am by whoever is on call —
 * not only from a shell with database credentials, which under the AKIM
 * appendix §5.7 access rules is a slower and more privileged path than the
 * 48-hour clock allows for.
 *
 * Notification sending is deliberately two-step: a preview (dry run) that
 * renders the counsel-reviewed template and reports any tokens still unfilled,
 * and then a send. Nobody should discover what a breach letter says by mailing
 * it to a customer.
 *
 * See docs/AKIM_REMEDIATION_PLAN.md.
 */

import type { Request, Response } from "express";
import {
  securityIncidentService,
  type SecurityIncidentKind,
  type SecurityIncidentSeverity,
  type SecurityIncidentStatus,
} from "../services/securityIncidentService";
import { dispatchIncidentNotification } from "../services/securityIncidentDispatcher";
import {
  classifyOverdue,
  incidentReference,
} from "../services/security-incident-deadlines";
import type { IncidentTemplateLocale } from "../services/incidentTemplateService";
import type { SecurityIncident } from "@shared/schema";

const KINDS: SecurityIncidentKind[] = ["phi_breach", "security_breach", "vendor_incident"];
const SEVERITIES: SecurityIncidentSeverity[] = ["low", "medium", "high", "critical"];
const STATUSES: SecurityIncidentStatus[] = [
  "open",
  "contained",
  "notified",
  "closed",
  "dismissed",
];

/** Shape sent to the client. `reference` and `overdue` are derived, not stored. */
function formatIncident(row: SecurityIncident, now = new Date()) {
  return {
    id: row.id,
    reference: incidentReference(row.seq),
    kind: row.kind,
    severity: row.severity,
    status: row.status,
    title: row.title,
    description: row.description,
    discoveredAt: row.discoveredAt,
    occurredAt: row.occurredAt,
    containedAt: row.containedAt,
    endedAt: row.endedAt,
    regimes: row.regimes,
    regulatorNotifyDueAt: row.regulatorNotifyDueAt,
    regulatorNotifiedAt: row.regulatorNotifiedAt,
    customerNotifyDueAt: row.customerNotifyDueAt,
    customerNotifiedAt: row.customerNotifiedAt,
    investigationReportDueAt: row.investigationReportDueAt,
    investigationReportSentAt: row.investigationReportSentAt,
    affectedInstituteIds: row.affectedInstituteIds,
    affectedSubjectCount: row.affectedSubjectCount,
    affectedScope: row.affectedScope,
    closedAt: row.closedAt,
    closureSummary: row.closureSummary,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    // Computed here so the list can be sorted and coloured without the client
    // re-implementing the deadline rules — one owner for that logic.
    overdue: classifyOverdue(row, now),
  };
}

/** Parse an ISO date from the body. Returns undefined when absent. */
function parseDate(value: unknown, field: string): Date | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  if (typeof value !== "string") throw new Error(`${field} must be an ISO date string`);
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new Error(`${field} is not a valid date`);
  return d;
}

/** The acting admin, for attribution on the timeline. */
function actorId(req: Request): string | null {
  return (req.user as { id?: string } | undefined)?.id ?? null;
}

class SecurityIncidentController {
  async list(req: Request, res: Response): Promise<void> {
    try {
      const now = new Date();
      const includeClosed = req.query.includeClosed === "true";
      const rows = includeClosed
        ? await securityIncidentService.listAll()
        : await securityIncidentService.listOpen();
      res.json({ success: true, incidents: rows.map((r) => formatIncident(r, now)) });
    } catch (error: any) {
      console.error("List security incidents error:", error);
      res.status(500).json({ success: false, message: "Failed to list incidents" });
    }
  }

  async get(req: Request, res: Response): Promise<void> {
    try {
      const incident = await securityIncidentService.getById(req.params.id);
      if (!incident) {
        res.status(404).json({ success: false, message: "Incident not found" });
        return;
      }
      const timeline = await securityIncidentService.getTimeline(incident.id);
      res.json({ success: true, incident: formatIncident(incident), timeline });
    } catch (error: any) {
      console.error("Get security incident error:", error);
      res.status(500).json({ success: false, message: "Failed to load incident" });
    }
  }

  async create(req: Request, res: Response): Promise<void> {
    try {
      const body = req.body ?? {};
      if (!KINDS.includes(body.kind)) {
        res.status(400).json({ success: false, message: "A valid kind is required" });
        return;
      }
      if (!SEVERITIES.includes(body.severity)) {
        res.status(400).json({ success: false, message: "A valid severity is required" });
        return;
      }
      if (typeof body.title !== "string" || body.title.trim().length === 0) {
        res.status(400).json({ success: false, message: "A title is required" });
        return;
      }

      const discoveredAt = parseDate(body.discoveredAt, "discoveredAt");
      const occurredAt = parseDate(body.occurredAt, "occurredAt");

      const incident = await securityIncidentService.open({
        kind: body.kind,
        severity: body.severity,
        title: body.title.trim(),
        description: typeof body.description === "string" ? body.description : null,
        // Awareness defaults to now; an operator logging an incident found
        // earlier must be able to say so, because every clock runs from here.
        discoveredAt: discoveredAt ?? undefined,
        occurredAt: occurredAt ?? null,
        regimes: Array.isArray(body.regimes) ? body.regimes.filter((r: unknown) => typeof r === "string") : [],
        affectedInstituteIds: Array.isArray(body.affectedInstituteIds)
          ? body.affectedInstituteIds.filter((r: unknown) => typeof r === "string")
          : [],
        affectedSubjectCount:
          typeof body.affectedSubjectCount === "number" ? body.affectedSubjectCount : null,
        affectedScope: typeof body.affectedScope === "string" ? body.affectedScope : null,
        contractualNotifyHours:
          body.contractualNotifyHours === null || typeof body.contractualNotifyHours === "number"
            ? body.contractualNotifyHours
            : undefined,
        openedByAdminUserId: actorId(req),
      });

      res.status(201).json({ success: true, incident: formatIncident(incident) });
    } catch (error: any) {
      console.error("Create security incident error:", error);
      res.status(400).json({ success: false, message: error?.message ?? "Failed to open incident" });
    }
  }

  async update(req: Request, res: Response): Promise<void> {
    try {
      const body = req.body ?? {};
      if (body.status !== undefined && !STATUSES.includes(body.status)) {
        res.status(400).json({ success: false, message: "Invalid status" });
        return;
      }
      if (body.severity !== undefined && !SEVERITIES.includes(body.severity)) {
        res.status(400).json({ success: false, message: "Invalid severity" });
        return;
      }

      const incident = await securityIncidentService.update(
        req.params.id,
        {
          severity: body.severity,
          status: body.status,
          description: body.description,
          containedAt: parseDate(body.containedAt, "containedAt"),
          endedAt: parseDate(body.endedAt, "endedAt"),
          affectedInstituteIds: body.affectedInstituteIds,
          affectedSubjectCount: body.affectedSubjectCount,
          affectedScope: body.affectedScope,
        },
        actorId(req),
      );
      if (!incident) {
        res.status(404).json({ success: false, message: "Incident not found" });
        return;
      }
      res.json({ success: true, incident: formatIncident(incident) });
    } catch (error: any) {
      console.error("Update security incident error:", error);
      res.status(400).json({ success: false, message: error?.message ?? "Failed to update incident" });
    }
  }

  async addNote(req: Request, res: Response): Promise<void> {
    try {
      const body = req.body ?? {};
      if (typeof body.body !== "string" || body.body.trim().length === 0) {
        res.status(400).json({ success: false, message: "A note body is required" });
        return;
      }
      const incident = await securityIncidentService.getById(req.params.id);
      if (!incident) {
        res.status(404).json({ success: false, message: "Incident not found" });
        return;
      }
      const event = await securityIncidentService.addNote(
        incident.id,
        body.body.trim(),
        actorId(req),
      );
      res.status(201).json({ success: true, event });
    } catch (error: any) {
      console.error("Add incident note error:", error);
      res.status(500).json({ success: false, message: "Failed to add note" });
    }
  }

  async close(req: Request, res: Response): Promise<void> {
    try {
      const body = req.body ?? {};
      if (typeof body.closureSummary !== "string" || body.closureSummary.trim().length === 0) {
        res.status(400).json({ success: false, message: "A closure summary is required" });
        return;
      }
      const incident = await securityIncidentService.close(
        req.params.id,
        body.closureSummary.trim(),
        actorId(req),
      );
      if (!incident) {
        res.status(404).json({ success: false, message: "Incident not found" });
        return;
      }
      res.json({ success: true, incident: formatIncident(incident) });
    } catch (error: any) {
      console.error("Close security incident error:", error);
      res.status(500).json({ success: false, message: "Failed to close incident" });
    }
  }

  /**
   * Preview or send a notification.
   *
   * `dryRun` (the default) renders the letter and reports unfilled tokens
   * WITHOUT sending. Sending requires an explicit `dryRun: false`, so the
   * irreversible act is never the accidental one.
   */
  async notify(req: Request, res: Response): Promise<void> {
    try {
      const body = req.body ?? {};
      const target = body.target;
      if (!["customer", "regulator", "investigation_report"].includes(target)) {
        res.status(400).json({ success: false, message: "Invalid notification target" });
        return;
      }
      const recipients = Array.isArray(body.recipients)
        ? body.recipients.filter((r: unknown) => typeof r === "string")
        : [];

      const result = await dispatchIncidentNotification({
        incidentId: req.params.id,
        target,
        recipients,
        locale: (body.locale === "en" ? "en" : "he") as IncidentTemplateLocale,
        vars: typeof body.vars === "object" && body.vars ? body.vars : {},
        actorAdminUserId: actorId(req),
        // Send only on an explicit opt-out of the preview.
        dryRun: body.dryRun !== false,
      });

      // Outcomes, not HTTP errors. "You still owe three tokens" is what a
      // preview is FOR, and `apiRequest` throws away the body of a non-2xx —
      // the operator would see "400" instead of the list they need. Only a
      // missing incident is a real HTTP failure here.
      if (!result.ok) {
        if (result.reason === "incident_not_found") {
          res.status(404).json({ success: false, message: "Incident not found" });
          return;
        }
        res.json({
          success: true,
          outcome: result.reason,
          missingTokens: result.missingTokens,
          failedRecipients: result.failedRecipients,
          // The rendered letter still comes back on an unfilled-token refusal
          // so the operator can see it and fill the gaps in place.
          subject: result.subject,
          text: result.text,
        });
        return;
      }

      res.json({
        success: true,
        outcome: result.dryRun ? "preview" : "sent",
        subject: result.subject,
        text: result.text,
        recipients: result.recipients,
        incident: result.incident ? formatIncident(result.incident) : undefined,
      });
    } catch (error: any) {
      console.error("Notify security incident error:", error);
      res.status(500).json({ success: false, message: "Failed to dispatch notification" });
    }
  }
}

export const securityIncidentController = new SecurityIncidentController();
