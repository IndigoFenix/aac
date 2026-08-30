// Pins the deadline policy behind the security incident register.
//
// This is the part of the AKIM §6 commitment that has to be right: when the
// 48-hour contractual clock and the regulatory clock start, when the 3-day
// investigation-report clock starts, and which obligations count as late.
// A bug here does not throw — it just quietly makes us late.

import {
  DEFAULT_CONTRACTUAL_NOTIFY_HOURS,
  DEFAULT_INVESTIGATION_REPORT_DAYS,
  classifyApproaching,
  classifyOverdue,
  computeInvestigationReportDueAt,
  computeNotificationDeadlines,
  incidentReference,
  type DeadlineBearing,
} from "../services/security-incident-deadlines";

const DISCOVERED = new Date("2026-08-30T09:00:00.000Z");

/** A row with nothing due and nothing sent; tests set the fields they care about. */
function incident(overrides: Partial<DeadlineBearing> = {}): DeadlineBearing {
  return {
    status: "open",
    regulatorNotifyDueAt: null,
    regulatorNotifiedAt: null,
    customerNotifyDueAt: null,
    customerNotifiedAt: null,
    investigationReportDueAt: null,
    investigationReportSentAt: null,
    ...overrides,
  };
}

describe("computeNotificationDeadlines", () => {
  it("runs both clocks from discovery, not from occurrence", () => {
    const { regulatorNotifyDueAt, customerNotifyDueAt } = computeNotificationDeadlines({
      discoveredAt: DISCOVERED,
      regulatorNotifyHours: 72,
      contractualNotifyHours: DEFAULT_CONTRACTUAL_NOTIFY_HOURS,
    });

    expect(regulatorNotifyDueAt?.toISOString()).toBe("2026-09-02T09:00:00.000Z"); // +72h
    expect(customerNotifyDueAt?.toISOString()).toBe("2026-09-01T09:00:00.000Z"); // +48h
  });

  it("leaves the regulator deadline unset when no regime imposes one", () => {
    const d = computeNotificationDeadlines({
      discoveredAt: DISCOVERED,
      regulatorNotifyHours: null,
      contractualNotifyHours: 48,
    });
    expect(d.regulatorNotifyDueAt).toBeNull();
    expect(d.customerNotifyDueAt).not.toBeNull();
  });

  it("leaves the contractual deadline unset when no contract imposes one", () => {
    // A customer with no notice term in their agreement must not inherit
    // AKIM's 48 hours by accident.
    const d = computeNotificationDeadlines({
      discoveredAt: DISCOVERED,
      regulatorNotifyHours: 72,
      contractualNotifyHours: null,
    });
    expect(d.customerNotifyDueAt).toBeNull();
    expect(d.regulatorNotifyDueAt).not.toBeNull();
  });

  it("keeps the two windows independent when the regime is stricter than the contract", () => {
    const d = computeNotificationDeadlines({
      discoveredAt: DISCOVERED,
      regulatorNotifyHours: 24,
      contractualNotifyHours: 48,
    });
    expect(d.regulatorNotifyDueAt!.getTime()).toBeLessThan(d.customerNotifyDueAt!.getTime());
  });
});

describe("computeInvestigationReportDueAt", () => {
  it("runs from the event ENDING, not from discovery", () => {
    // §6.3: "בתוך זמן סביר ממועד סיום האירוע ... ולא יאוחר מ-3 ימים".
    const endedAt = new Date("2026-09-04T12:00:00.000Z");
    expect(computeInvestigationReportDueAt(endedAt)?.toISOString()).toBe(
      "2026-09-07T12:00:00.000Z",
    );
  });

  it("is unset while the event has not ended", () => {
    expect(computeInvestigationReportDueAt(null)).toBeNull();
  });

  it("uses the documented 3-day default", () => {
    expect(DEFAULT_INVESTIGATION_REPORT_DAYS).toBe(3);
  });
});

describe("classifyOverdue", () => {
  const now = new Date("2026-09-02T09:00:00.000Z");
  const past = new Date("2026-09-01T09:00:00.000Z");
  const future = new Date("2026-09-05T09:00:00.000Z");

  it("reports nothing when every deadline is still ahead", () => {
    expect(
      classifyOverdue(incident({ customerNotifyDueAt: future }), now),
    ).toEqual([]);
  });

  it("reports an obligation whose deadline has passed unmet", () => {
    expect(classifyOverdue(incident({ customerNotifyDueAt: past }), now)).toEqual([
      "customer",
    ]);
  });

  it("does not report an obligation that was met, however late", () => {
    expect(
      classifyOverdue(
        incident({ customerNotifyDueAt: past, customerNotifiedAt: now }),
        now,
      ),
    ).toEqual([]);
  });

  it("reports each overdue obligation separately", () => {
    expect(
      classifyOverdue(
        incident({
          regulatorNotifyDueAt: past,
          customerNotifyDueAt: past,
          investigationReportDueAt: past,
        }),
        now,
      ),
    ).toEqual(["regulator", "customer", "investigation_report"]);
  });

  it("treats a deadline exactly at now as due", () => {
    expect(classifyOverdue(incident({ customerNotifyDueAt: now }), now)).toEqual([
      "customer",
    ]);
  });

  it.each(["closed", "dismissed"])(
    "goes quiet on a %s incident so a stale miss stops paging",
    (status) => {
      expect(
        classifyOverdue(incident({ status, customerNotifyDueAt: past }), now),
      ).toEqual([]);
    },
  );

  it("keeps alerting on a contained-but-not-closed incident", () => {
    // Contained means the bleeding stopped, not that we told anyone.
    expect(
      classifyOverdue(incident({ status: "contained", customerNotifyDueAt: past }), now),
    ).toEqual(["customer"]);
  });
});

describe("classifyApproaching", () => {
  const now = new Date("2026-09-02T09:00:00.000Z");

  it("warns on a deadline inside the horizon", () => {
    const inSixHours = new Date("2026-09-02T15:00:00.000Z");
    expect(
      classifyApproaching(incident({ customerNotifyDueAt: inSixHours }), now, 12),
    ).toEqual(["customer"]);
  });

  it("stays quiet on a deadline beyond the horizon", () => {
    const inTwoDays = new Date("2026-09-04T09:00:00.000Z");
    expect(
      classifyApproaching(incident({ customerNotifyDueAt: inTwoDays }), now, 12),
    ).toEqual([]);
  });

  it("does not double-report something already overdue", () => {
    // Overdue is the other function's job; a missed deadline must not also
    // surface as "approaching" or the sweep alerts twice for one obligation.
    const past = new Date("2026-09-01T09:00:00.000Z");
    expect(classifyApproaching(incident({ customerNotifyDueAt: past }), now, 12)).toEqual(
      [],
    );
  });

  it("stays quiet once the obligation is met", () => {
    const inSixHours = new Date("2026-09-02T15:00:00.000Z");
    expect(
      classifyApproaching(
        incident({ customerNotifyDueAt: inSixHours, customerNotifiedAt: now }),
        now,
        12,
      ),
    ).toEqual([]);
  });
});

describe("incidentReference", () => {
  it("renders a stable, zero-padded handle", () => {
    expect(incidentReference(7)).toBe("INC-00007");
    expect(incidentReference(12345)).toBe("INC-12345");
  });

  it("does not truncate once the ordinal outgrows the padding", () => {
    expect(incidentReference(1234567)).toBe("INC-1234567");
  });
});
