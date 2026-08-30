/**
 * Incident notification dispatch + deadline sweep, against a real Postgres.
 *
 * SAFETY: the test environment carries live SES credentials, so every test
 * here either runs with `dryRun` or injects a fake `sendMail`. Nothing in this
 * file may call the dispatcher's default sender — that would post a real
 * breach-notification e-mail.
 *
 * Backs AKIM appendix §6. See docs/AKIM_REMEDIATION_PLAN.md.
 */

import { describe, it, expect, afterEach } from '@jest/globals';

import { truncateAll } from '../helpers/db.js';
import { securityIncidentService } from '../../services/securityIncidentService.js';
import {
  dispatchIncidentNotification,
  type SendMail,
} from '../../services/securityIncidentDispatcher.js';
import {
  runSecurityIncidentDeadlineSweep,
  type AlertSender,
} from '../../services/securityIncidentSweepCron.js';

const HOUR = 60 * 60 * 1000;

function hoursAgo(n: number): Date {
  return new Date(Date.now() - n * HOUR);
}

/** Records what would have been sent; never touches the network. */
function fakeSender(outcome: { success: boolean } | ((to: string) => { success: boolean })) {
  const sent: Array<{ to: string; subject: string; text: string }> = [];
  const sendMail: SendMail = async (msg) => {
    sent.push({ to: msg.to, subject: msg.subject, text: msg.text });
    return typeof outcome === 'function' ? outcome(msg.to) : outcome;
  };
  return { sendMail, sent };
}

async function openIncident(overrides: Record<string, unknown> = {}) {
  return securityIncidentService.open({
    kind: 'phi_breach',
    severity: 'high',
    title: 'Misconfigured share',
    description: 'A share link exposed three student records.',
    affectedScope: 'Names and dates of birth.',
    affectedSubjectCount: 3,
    regimes: [],
    ...overrides,
  } as any);
}

/**
 * Ask the dispatcher what it still needs, then supply exactly that. Keeps the
 * test from hardcoding a token list that the counsel-reviewed templates own.
 */
async function fullVarsFor(incidentId: string): Promise<Record<string, string>> {
  const probe = await dispatchIncidentNotification({
    incidentId,
    target: 'customer',
    recipients: ['ciso@example.org'],
    locale: 'en',
    dryRun: true,
  });
  if (probe.ok) return {};
  const missing = probe.missingTokens ?? [];
  return Object.fromEntries(missing.map((t) => [t, `«${t}»`]));
}

/**
 * Captures the alert instead of sending it. NEVER omit this from a sweep call:
 * the test environment has live SES credentials, and the default channel would
 * mail a real "deadline missed" alert to the on-call mailbox.
 */
function fakeAlerter() {
  const alerts: Array<{ subject: string; lines: string[] }> = [];
  const alert: AlertSender = async (subject, lines) => {
    alerts.push({ subject, lines });
    return { sent: true };
  };
  return { alert, alerts };
}

/** Sweep with alerting stubbed out. */
async function sweep(deps = fakeAlerter()) {
  return runSecurityIncidentDeadlineSweep(new Date(), { alert: deps.alert });
}

afterEach(async () => {
  await truncateAll();
});

describe('dispatchIncidentNotification refusals', () => {
  it('refuses to send a template with unfilled tokens, and names them', async () => {
    const incident = await openIncident();

    const result = await dispatchIncidentNotification({
      incidentId: incident.id,
      target: 'customer',
      recipients: ['ciso@example.org'],
      locale: 'en',
      // No narrative vars supplied.
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('unfilled_tokens');
    expect(result.missingTokens!.length).toBeGreaterThan(0);
    // The refusal has to be actionable: the caller learns what it still owes.
    expect(result.missingTokens).toEqual([...result.missingTokens!].sort());
  });

  it('does not stamp the clock when the template was refused', async () => {
    const incident = await openIncident();
    await dispatchIncidentNotification({
      incidentId: incident.id,
      target: 'customer',
      recipients: ['ciso@example.org'],
      locale: 'en',
    });

    const after = await securityIncidentService.getById(incident.id);
    expect(after!.customerNotifiedAt).toBeNull();
  });

  it('refuses an unknown incident', async () => {
    const result = await dispatchIncidentNotification({
      incidentId: '00000000-0000-0000-0000-000000000000',
      target: 'customer',
      recipients: ['ciso@example.org'],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('incident_not_found');
  });

  it('refuses an empty recipient list', async () => {
    const incident = await openIncident();
    const result = await dispatchIncidentNotification({
      incidentId: incident.id,
      target: 'customer',
      recipients: ['  '],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('no_recipients');
  });
});

describe('dispatchIncidentNotification delivery', () => {
  it('renders without sending or stamping under dryRun', async () => {
    const incident = await openIncident();
    const vars = await fullVarsFor(incident.id);
    const { sendMail, sent } = fakeSender({ success: true });

    const result = await dispatchIncidentNotification(
      {
        incidentId: incident.id,
        target: 'customer',
        recipients: ['ciso@example.org'],
        locale: 'en',
        vars,
        dryRun: true,
      },
      { sendMail },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.dryRun).toBe(true);
    expect(sent).toHaveLength(0);

    const after = await securityIncidentService.getById(incident.id);
    expect(after!.customerNotifiedAt).toBeNull();
  });

  it('stamps the clock and records the timeline entry on a real send', async () => {
    const incident = await openIncident();
    const vars = await fullVarsFor(incident.id);
    const { sendMail, sent } = fakeSender({ success: true });

    const result = await dispatchIncidentNotification(
      {
        incidentId: incident.id,
        target: 'customer',
        recipients: ['ciso@example.org', 'legal@example.org'],
        locale: 'en',
        vars,
      },
      { sendMail },
    );

    expect(result.ok).toBe(true);
    expect(sent.map((s) => s.to)).toEqual(['ciso@example.org', 'legal@example.org']);
    // No token braces survived into what went out.
    expect(sent[0].text).not.toMatch(/\{[a-z_]+\}/);

    const after = await securityIncidentService.getById(incident.id);
    expect(after!.customerNotifiedAt).not.toBeNull();

    const timeline = await securityIncidentService.getTimeline(incident.id);
    expect(timeline.some((e) => e.kind === 'notification_sent')).toBe(true);
  });

  it('leaves the obligation overdue when every recipient fails', async () => {
    // The whole point: an undelivered notification must keep counting against
    // us rather than quietly reading as done.
    const incident = await openIncident({ discoveredAt: hoursAgo(72) });
    const vars = await fullVarsFor(incident.id);
    const { sendMail } = fakeSender({ success: false });

    const result = await dispatchIncidentNotification(
      {
        incidentId: incident.id,
        target: 'customer',
        recipients: ['ciso@example.org'],
        locale: 'en',
        vars,
      },
      { sendMail },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('send_failed');

    const after = await securityIncidentService.getById(incident.id);
    expect(after!.customerNotifiedAt).toBeNull();

    const overdue = await securityIncidentService.listOverdue();
    expect(overdue.find((o) => o.incident.id === incident.id)?.overdue).toContain(
      'customer',
    );
  });

  it('stamps a partial delivery but records who could not be reached', async () => {
    const incident = await openIncident();
    const vars = await fullVarsFor(incident.id);
    const { sendMail } = fakeSender((to) => ({ success: to !== 'broken@example.org' }));

    const result = await dispatchIncidentNotification(
      {
        incidentId: incident.id,
        target: 'customer',
        recipients: ['ciso@example.org', 'broken@example.org'],
        locale: 'en',
        vars,
      },
      { sendMail },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.recipients).toEqual(['ciso@example.org']);

    const timeline = await securityIncidentService.getTimeline(incident.id);
    const note = timeline.find((e) => e.kind === 'note');
    expect(note?.body).toContain('broken@example.org');
  });

  it('routes the investigation report to its own column', async () => {
    const incident = await openIncident();
    const vars = await fullVarsFor(incident.id);
    const { sendMail } = fakeSender({ success: true });

    await dispatchIncidentNotification(
      {
        incidentId: incident.id,
        target: 'investigation_report',
        recipients: ['ciso@example.org'],
        locale: 'en',
        vars,
      },
      { sendMail },
    );

    const after = await securityIncidentService.getById(incident.id);
    expect(after!.investigationReportSentAt).not.toBeNull();
    expect(after!.customerNotifiedAt).toBeNull();
  });
});

describe('runSecurityIncidentDeadlineSweep', () => {
  it('raises a finding for a blown deadline', async () => {
    const incident = await openIncident({ discoveredAt: hoursAgo(72) });

    const result = await sweep();
    const finding = result.raised.find((f) => f.incidentId === incident.id);

    expect(finding).toBeDefined();
    expect(finding!.phase).toBe('missed');
    expect(finding!.obligation).toBe('customer');
  });

  it('does not re-raise the same finding on the next run', async () => {
    // Hourly sweep, 48-hour window: without suppression this would alert ~24
    // times for one missed deadline and train everyone to ignore it.
    const incident = await openIncident({ discoveredAt: hoursAgo(72) });

    const first = await sweep();
    expect(first.raised.some((f) => f.incidentId === incident.id)).toBe(true);

    const second = await sweep();
    expect(second.raised.some((f) => f.incidentId === incident.id)).toBe(false);
    expect(second.suppressed).toBeGreaterThan(0);
  });

  it('warns before the deadline, not only after it', async () => {
    // Discovered 40h ago against a 48h window — 8h left, inside the horizon.
    const incident = await openIncident({ discoveredAt: hoursAgo(40) });

    const result = await sweep();
    const finding = result.raised.find((f) => f.incidentId === incident.id);

    expect(finding).toBeDefined();
    expect(finding!.phase).toBe('approaching');
  });

  it('stays silent for an incident still well within its window', async () => {
    const incident = await openIncident({ discoveredAt: hoursAgo(1) });
    const result = await sweep();
    expect(result.raised.some((f) => f.incidentId === incident.id)).toBe(false);
  });

  it('stops raising once the notification is recorded', async () => {
    const incident = await openIncident({ discoveredAt: hoursAgo(72) });
    await securityIncidentService.recordNotification(incident.id, 'customer', {
      channel: 'phone',
    });

    const result = await sweep();
    expect(result.raised.some((f) => f.incidentId === incident.id)).toBe(false);
  });

  it('ignores closed incidents entirely', async () => {
    const incident = await openIncident({ discoveredAt: hoursAgo(72) });
    await securityIncidentService.close(incident.id, 'Handled');

    const result = await sweep();
    expect(result.raised.some((f) => f.incidentId === incident.id)).toBe(false);
    expect(result.scanned).toBe(0);
  });

  it('writes the finding onto the incident timeline as evidence', async () => {
    const incident = await openIncident({ discoveredAt: hoursAgo(72) });
    await sweep();

    const timeline = await securityIncidentService.getTimeline(incident.id);
    const missed = timeline.find((e) => e.kind === 'deadline_missed');
    expect(missed).toBeDefined();
    expect(missed!.metadata).toMatchObject({ obligation: 'customer', phase: 'missed' });
  });
});
