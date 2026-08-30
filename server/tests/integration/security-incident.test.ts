/**
 * Security incident register integration tests.
 *
 * Exercises securityIncidentService against a real Postgres test DB. The
 * deadline POLICY is unit-tested in server/tests/security-incident-deadlines.test.ts;
 * this file covers the parts that only a database can show: that deadlines are
 * actually persisted at open time, that the timeline is append-only and ordered,
 * that recording a notification stops the obligation counting as overdue, and
 * that the overdue sweep's SQL filter agrees with the classifier.
 *
 * Backs the AKIM information-security appendix §6. See docs/AKIM_REMEDIATION_PLAN.md.
 */

import { describe, it, expect, afterEach } from '@jest/globals';

import { truncateAll } from '../helpers/db.js';
import {
  securityIncidentService,
  incidentReference,
} from '../../services/securityIncidentService.js';

const HOUR = 60 * 60 * 1000;

/** A discovery time far enough back that a 48h window is already blown. */
function hoursAgo(n: number): Date {
  return new Date(Date.now() - n * HOUR);
}

afterEach(async () => {
  await truncateAll();
});

describe('securityIncidentService.open', () => {
  it('persists both notification deadlines derived from discovery', async () => {
    const discoveredAt = new Date('2026-08-30T09:00:00.000Z');

    const incident = await securityIncidentService.open({
      kind: 'phi_breach',
      severity: 'high',
      title: 'Test exposure',
      discoveredAt,
      // il_moe carries a breach window; whatever it is, the stored deadline
      // must be discovery + that window, not a hardcoded number.
      regimes: ['il_moe'],
    });

    expect(incident.status).toBe('open');
    expect(incident.customerNotifyDueAt).not.toBeNull();
    // The AKIM contractual window is 48h from awareness.
    expect(incident.customerNotifyDueAt!.getTime()).toBe(
      discoveredAt.getTime() + 48 * HOUR,
    );
    expect(incident.regulatorNotifyDueAt).not.toBeNull();
    expect(incident.regulatorNotifyDueAt!.getTime()).toBeGreaterThan(
      discoveredAt.getTime(),
    );
  });

  it('leaves the regulator deadline null when no regime is in play', async () => {
    const incident = await securityIncidentService.open({
      kind: 'security_breach',
      severity: 'low',
      title: 'No regime',
      regimes: [],
    });
    expect(incident.regulatorNotifyDueAt).toBeNull();
    // The contractual window still applies.
    expect(incident.customerNotifyDueAt).not.toBeNull();
  });

  it('honours an explicit null contractual window', async () => {
    const incident = await securityIncidentService.open({
      kind: 'security_breach',
      severity: 'low',
      title: 'No contract term',
      contractualNotifyHours: null,
    });
    expect(incident.customerNotifyDueAt).toBeNull();
  });

  it('assigns a distinct, ascending reference to each incident', async () => {
    const a = await securityIncidentService.open({
      kind: 'security_breach',
      severity: 'low',
      title: 'First',
    });
    const b = await securityIncidentService.open({
      kind: 'security_breach',
      severity: 'low',
      title: 'Second',
    });

    expect(b.seq).toBeGreaterThan(a.seq);
    expect(incidentReference(a.seq)).not.toBe(incidentReference(b.seq));
  });

  it('opens the timeline with an "opened" entry', async () => {
    const incident = await securityIncidentService.open({
      kind: 'phi_breach',
      severity: 'critical',
      title: 'Timeline start',
    });

    const timeline = await securityIncidentService.getTimeline(incident.id);
    expect(timeline).toHaveLength(1);
    expect(timeline[0].kind).toBe('opened');
    expect(timeline[0].body).toBe('Timeline start');
  });
});

describe('securityIncidentService.update', () => {
  it('derives the investigation-report deadline when the event ends', async () => {
    const incident = await securityIncidentService.open({
      kind: 'phi_breach',
      severity: 'high',
      title: 'Ends later',
    });
    expect(incident.investigationReportDueAt).toBeNull();

    const endedAt = new Date('2026-09-04T12:00:00.000Z');
    const updated = await securityIncidentService.update(incident.id, { endedAt });

    // §6.3: three days from the END of the event.
    expect(updated!.investigationReportDueAt!.getTime()).toBe(
      endedAt.getTime() + 3 * 24 * HOUR,
    );
  });

  it('clears the report deadline if the end time is retracted', async () => {
    const incident = await securityIncidentService.open({
      kind: 'phi_breach',
      severity: 'high',
      title: 'Retract end',
    });
    await securityIncidentService.update(incident.id, { endedAt: new Date() });
    const retracted = await securityIncidentService.update(incident.id, {
      endedAt: null,
    });
    expect(retracted!.investigationReportDueAt).toBeNull();
  });

  it('records a status change on the timeline', async () => {
    const incident = await securityIncidentService.open({
      kind: 'security_breach',
      severity: 'medium',
      title: 'Status moves',
    });
    await securityIncidentService.update(incident.id, { status: 'contained' });

    const timeline = await securityIncidentService.getTimeline(incident.id);
    const change = timeline.find((e) => e.kind === 'status_change');
    expect(change).toBeDefined();
    expect(change!.metadata).toMatchObject({ from: 'open', to: 'contained' });
  });

  it('does not log a status change when the status did not move', async () => {
    const incident = await securityIncidentService.open({
      kind: 'security_breach',
      severity: 'medium',
      title: 'No move',
    });
    await securityIncidentService.update(incident.id, { status: 'open' });

    const timeline = await securityIncidentService.getTimeline(incident.id);
    expect(timeline.filter((e) => e.kind === 'status_change')).toHaveLength(0);
  });

  it('returns undefined for an unknown incident rather than throwing', async () => {
    const missing = await securityIncidentService.update(
      '00000000-0000-0000-0000-000000000000',
      { severity: 'low' },
    );
    expect(missing).toBeUndefined();
  });
});

describe('securityIncidentService.listOverdue', () => {
  it('surfaces an incident past its contractual window with nothing sent', async () => {
    const incident = await securityIncidentService.open({
      kind: 'phi_breach',
      severity: 'high',
      title: 'Late',
      discoveredAt: hoursAgo(72), // 48h window blown 24h ago
      regimes: [],
    });

    const overdue = await securityIncidentService.listOverdue();
    const found = overdue.find((o) => o.incident.id === incident.id);
    expect(found).toBeDefined();
    expect(found!.overdue).toContain('customer');
  });

  it('drops the obligation once the notification is recorded', async () => {
    const incident = await securityIncidentService.open({
      kind: 'phi_breach',
      severity: 'high',
      title: 'Late then notified',
      discoveredAt: hoursAgo(72),
      regimes: [],
    });

    await securityIncidentService.recordNotification(incident.id, 'customer', {
      channel: 'email',
      recipients: ['security@example.org'],
    });

    const overdue = await securityIncidentService.listOverdue();
    expect(overdue.find((o) => o.incident.id === incident.id)).toBeUndefined();
  });

  it('ignores an incident whose window has not expired', async () => {
    const incident = await securityIncidentService.open({
      kind: 'security_breach',
      severity: 'low',
      title: 'Still in time',
      discoveredAt: hoursAgo(1),
      regimes: [],
    });

    const overdue = await securityIncidentService.listOverdue();
    expect(overdue.find((o) => o.incident.id === incident.id)).toBeUndefined();
  });

  it('goes quiet once the incident is closed, even with a missed deadline', async () => {
    const incident = await securityIncidentService.open({
      kind: 'phi_breach',
      severity: 'high',
      title: 'Closed late',
      discoveredAt: hoursAgo(72),
      regimes: [],
    });
    await securityIncidentService.close(incident.id, 'Handled out of band');

    const overdue = await securityIncidentService.listOverdue();
    expect(overdue.find((o) => o.incident.id === incident.id)).toBeUndefined();
  });

  it('reports the overdue investigation report separately from the notices', async () => {
    const incident = await securityIncidentService.open({
      kind: 'phi_breach',
      severity: 'high',
      title: 'Report overdue',
      discoveredAt: hoursAgo(240),
      regimes: [],
    });
    // Notice sent, but the report never followed.
    await securityIncidentService.recordNotification(incident.id, 'customer', {
      channel: 'phone',
    });
    await securityIncidentService.update(incident.id, { endedAt: hoursAgo(200) });

    const overdue = await securityIncidentService.listOverdue();
    const found = overdue.find((o) => o.incident.id === incident.id);
    expect(found).toBeDefined();
    expect(found!.overdue).toEqual(['investigation_report']);
  });
});

describe('securityIncidentService notification recording', () => {
  it('stamps the sent time and writes a timeline entry', async () => {
    const incident = await securityIncidentService.open({
      kind: 'vendor_incident',
      severity: 'medium',
      title: 'Vendor told us',
    });

    const updated = await securityIncidentService.recordNotification(
      incident.id,
      'customer',
      { channel: 'email', recipients: ['a@example.org'], templateType: 'vendor-incident' },
    );
    expect(updated!.customerNotifiedAt).not.toBeNull();

    const timeline = await securityIncidentService.getTimeline(incident.id);
    const sent = timeline.find((e) => e.kind === 'notification_sent');
    expect(sent).toBeDefined();
    expect(sent!.metadata).toMatchObject({
      party: 'customer',
      channel: 'email',
      templateType: 'vendor-incident',
    });
  });

  it('records the investigation report against its own column', async () => {
    const incident = await securityIncidentService.open({
      kind: 'phi_breach',
      severity: 'high',
      title: 'Report sent',
    });

    const updated = await securityIncidentService.recordInvestigationReport(
      incident.id,
      { channel: 'email' },
    );
    expect(updated!.investigationReportSentAt).not.toBeNull();
    // Recording the report must not be mistaken for notifying the customer.
    expect(updated!.customerNotifiedAt).toBeNull();
  });
});

describe('securityIncidentService timeline', () => {
  it('is append-only and returned oldest first', async () => {
    const incident = await securityIncidentService.open({
      kind: 'security_breach',
      severity: 'low',
      title: 'Ordered',
    });
    await securityIncidentService.addNote(incident.id, 'First note');
    await securityIncidentService.addNote(incident.id, 'Second note');
    await securityIncidentService.close(incident.id, 'Done');

    const timeline = await securityIncidentService.getTimeline(incident.id);
    expect(timeline.map((e) => e.kind)).toEqual(['opened', 'note', 'note', 'closed']);
    for (let i = 1; i < timeline.length; i++) {
      expect(timeline[i].createdAt.getTime()).toBeGreaterThanOrEqual(
        timeline[i - 1].createdAt.getTime(),
      );
    }
  });
});
