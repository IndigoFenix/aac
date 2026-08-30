// The facts a notification inherits from the register row.
//
// These are the values a customer reads in a breach letter — when we found
// out, when it happened, how many people. They must come from the record
// rather than from whoever is typing at 2am, or the letter and the register
// can tell different stories about the same incident.

import { deriveTemplateVars } from "../services/securityIncidentDispatcher";
import { incidentReference } from "../services/security-incident-deadlines";
import type { SecurityIncident } from "@shared/schema";

const NOW = new Date("2026-09-01T10:30:00.000Z");

function incident(overrides: Partial<SecurityIncident> = {}): SecurityIncident {
  return {
    id: "inc-1",
    seq: 42,
    kind: "phi_breach",
    severity: "high",
    status: "open",
    title: "Test",
    description: "A misconfigured share exposed three records.",
    discoveredAt: new Date("2026-08-30T09:00:00.000Z"),
    occurredAt: new Date("2026-08-29T22:15:00.000Z"),
    containedAt: null,
    endedAt: null,
    regimes: [],
    regulatorNotifyDueAt: null,
    regulatorNotifiedAt: null,
    customerNotifyDueAt: null,
    customerNotifiedAt: null,
    investigationReportDueAt: null,
    investigationReportSentAt: null,
    affectedInstituteIds: [],
    affectedSubjectCount: 3,
    affectedScope: "Names and dates of birth.",
    openedByAdminUserId: null,
    closedAt: null,
    closureSummary: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as SecurityIncident;
}

describe("deriveTemplateVars", () => {
  it("carries the register's reference so letter and record can be matched", () => {
    expect(deriveTemplateVars(incident(), NOW).incident_ref).toBe(incidentReference(42));
  });

  it("renders timestamps unambiguously in UTC", () => {
    const vars = deriveTemplateVars(incident(), NOW);
    expect(vars.incident_discovered_at).toBe("2026-08-30T09:00:00Z");
    expect(vars.incident_occurred_at).toBe("2026-08-29T22:15:00Z");
    expect(vars.notification_sent_at).toBe("2026-09-01T10:30:00Z");
  });

  it('says "unknown" rather than going blank for an absent time', () => {
    // A missing occurrence time must read as unknown in the sentence, not
    // vanish and leave "Incident occurred:" trailing into nothing.
    const vars = deriveTemplateVars(incident({ occurredAt: null }), NOW);
    expect(vars.incident_occurred_at).toBe("unknown");
  });

  it('says "unknown" rather than "0" for an uncounted subject population', () => {
    // Zero affected people and an uncounted population are very different
    // claims to put in a breach notification.
    const vars = deriveTemplateVars(incident({ affectedSubjectCount: null }), NOW);
    expect(vars.affected_subject_count).toBe("unknown");
    expect(deriveTemplateVars(incident({ affectedSubjectCount: 0 }), NOW)
      .affected_subject_count).toBe("0");
  });

  it("passes the register's own scope and description through", () => {
    const vars = deriveTemplateVars(incident(), NOW);
    expect(vars.incident_summary).toBe("A misconfigured share exposed three records.");
    expect(vars.affected_data_categories).toBe("Names and dates of birth.");
  });

  it("yields empty strings, not the literal 'null', for unwritten prose", () => {
    const vars = deriveTemplateVars(
      incident({ description: null, affectedScope: null }),
      NOW,
    );
    expect(vars.incident_summary).toBe("");
    expect(vars.affected_data_categories).toBe("");
  });
});
