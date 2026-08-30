/**
 * Security incident controller tests.
 *
 * The contract worth pinning here is the notify endpoint's shape. `apiRequest`
 * on the client throws away the body of a non-2xx response, so a refusal that
 * came back as 400 would reach the operator as the string "400" rather than
 * the list of placeholders they still have to fill. Refusals are therefore
 * 200-with-an-`outcome`, and only a missing incident is a real HTTP error.
 *
 * SAFETY: the test environment carries live SES credentials. Every notify call
 * below is a dry run — none may set `dryRun: false`.
 *
 * See docs/AKIM_REMEDIATION_PLAN.md.
 */

import { describe, it, expect, afterEach } from "@jest/globals";
import { truncateAll } from "../helpers/db.js";
import { makeReq, makeRes } from "../helpers/http.js";
import { securityIncidentController } from "../../controllers/securityIncidentController.js";
import { securityIncidentService } from "../../services/securityIncidentService.js";
import { adminUserRepository } from "../../repositories/adminUserRepository.js";

const ACTOR_ID = "system-admin-id";

function actor() {
  return { id: ACTOR_ID, email: "actor@aivota.ai", isSystemAdmin: true };
}

/**
 * The register attributes an opened incident to the admin who opened it, and
 * that column is a real FK to `admin_users`. Admin logins get a shell row in
 * `users` sharing the SAME id (adminAuthService.ensureAdminShellUser), so in
 * production `req.user.id` always resolves — but a fabricated actor does not,
 * and the insert would fail on the constraint.
 */
async function seedActor() {
  await adminUserRepository.create({
    id: ACTOR_ID,
    email: "actor@aivota.ai",
    permissions: ["*"],
  } as any);
}

async function call(
  method: keyof typeof securityIncidentController,
  opts: { body?: unknown; params?: Record<string, string>; query?: Record<string, string> } = {},
) {
  const req = makeReq({ user: actor(), ...opts } as any);
  const { res, capture } = makeRes();
  await (securityIncidentController as any)[method](req, res);
  return { status: capture.statusCode, body: capture.jsonBody as any };
}

async function seedIncident(overrides: Record<string, unknown> = {}) {
  return securityIncidentService.open({
    kind: "phi_breach",
    severity: "high",
    title: "Seeded incident",
    description: "A share link exposed three records.",
    affectedScope: "Names and dates of birth.",
    regimes: [],
    ...overrides,
  } as any);
}

describe("Security incident controller", () => {
  afterEach(truncateAll);

  it("opens an incident and returns its derived reference and deadlines", async () => {
    await seedActor();
    const { status, body } = await call("create", {
      body: { kind: "phi_breach", severity: "critical", title: "Exposed share" },
    });

    expect(status).toBe(201);
    expect(body.incident.reference).toMatch(/^INC-\d{5}/);
    expect(body.incident.customerNotifyDueAt).toBeTruthy();
    expect(body.incident.overdue).toEqual([]);
  });

  it("rejects an unknown kind rather than storing it", async () => {
    const { status } = await call("create", {
      body: { kind: "not_a_kind", severity: "high", title: "x" },
    });
    expect(status).toBe(400);
  });

  it("rejects an incident with no title", async () => {
    const { status } = await call("create", {
      body: { kind: "phi_breach", severity: "high", title: "   " },
    });
    expect(status).toBe(400);
  });

  it("hides closed incidents from the default list but keeps them retrievable", async () => {
    const incident = await seedIncident();
    await securityIncidentService.close(incident.id, "Done");

    const open = await call("list", { query: {} });
    expect(open.body.incidents).toHaveLength(0);

    const all = await call("list", { query: { includeClosed: "true" } });
    expect(all.body.incidents).toHaveLength(1);
    expect(all.body.incidents[0].status).toBe("closed");
  });

  it("returns the timeline alongside the incident", async () => {
    const incident = await seedIncident();
    const { status, body } = await call("get", { params: { id: incident.id } });

    expect(status).toBe(200);
    expect(body.timeline[0].kind).toBe("opened");
  });

  it("404s for an incident that does not exist", async () => {
    const { status } = await call("get", {
      params: { id: "00000000-0000-0000-0000-000000000000" },
    });
    expect(status).toBe(404);
  });

  it("derives the report deadline when the operator marks the event ended", async () => {
    const incident = await seedIncident();
    const endedAt = new Date("2026-09-04T12:00:00.000Z");

    const { body } = await call("update", {
      params: { id: incident.id },
      body: { endedAt: endedAt.toISOString() },
    });

    expect(new Date(body.incident.investigationReportDueAt).getTime()).toBe(
      endedAt.getTime() + 3 * 24 * 60 * 60 * 1000,
    );
  });

  it("rejects a malformed date instead of silently dropping the deadline", async () => {
    const incident = await seedIncident();
    const { status } = await call("update", {
      params: { id: incident.id },
      body: { endedAt: "not-a-date" },
    });
    expect(status).toBe(400);
  });

  it("requires a closure summary to close", async () => {
    const incident = await seedIncident();
    const { status } = await call("close", {
      params: { id: incident.id },
      body: { closureSummary: "" },
    });
    expect(status).toBe(400);
  });
});

describe("Security incident controller — notify", () => {
  afterEach(truncateAll);

  it("reports unfilled placeholders as a 200 outcome, not an HTTP error", async () => {
    // A 400 here would reach the operator as the bare string "400": the client
    // helper discards non-2xx bodies, and the list of missing tokens is the
    // entire point of the preview.
    const incident = await seedIncident();

    const { status, body } = await call("notify", {
      params: { id: incident.id },
      body: {
        target: "customer",
        recipients: ["ciso@example.org"],
        locale: "en",
        dryRun: true,
      },
    });

    expect(status).toBe(200);
    expect(body.outcome).toBe("unfilled_tokens");
    expect(body.missingTokens.length).toBeGreaterThan(0);
    // The rendered letter comes back too, so the gaps can be filled in place.
    expect(typeof body.text).toBe("string");
  });

  it("returns a clean preview once every placeholder is supplied", async () => {
    const incident = await seedIncident();

    const probe = await call("notify", {
      params: { id: incident.id },
      body: { target: "customer", recipients: ["ciso@example.org"], locale: "en", dryRun: true },
    });
    const vars = Object.fromEntries(
      (probe.body.missingTokens as string[]).map((t) => [t, `filled-${t}`]),
    );

    const { status, body } = await call("notify", {
      params: { id: incident.id },
      body: {
        target: "customer",
        recipients: ["ciso@example.org"],
        locale: "en",
        vars,
        dryRun: true,
      },
    });

    expect(status).toBe(200);
    expect(body.outcome).toBe("preview");
    expect(body.text).not.toMatch(/\{[a-z_]+\}/);

    // A preview must never stamp the clock.
    const after = await securityIncidentService.getById(incident.id);
    expect(after!.customerNotifiedAt).toBeNull();
  });

  it("defaults to a preview when dryRun is omitted", async () => {
    // Sending is irreversible; it must be the explicit choice, never the
    // default that a missing field falls into.
    const incident = await seedIncident();

    const { body } = await call("notify", {
      params: { id: incident.id },
      body: { target: "customer", recipients: ["ciso@example.org"], locale: "en" },
    });

    expect(["preview", "unfilled_tokens"]).toContain(body.outcome);
    const after = await securityIncidentService.getById(incident.id);
    expect(after!.customerNotifiedAt).toBeNull();
  });

  it("rejects an invalid notification target", async () => {
    const incident = await seedIncident();
    const { status } = await call("notify", {
      params: { id: incident.id },
      body: { target: "the_press", recipients: ["x@example.org"], dryRun: true },
    });
    expect(status).toBe(400);
  });

  it("404s when notifying an incident that does not exist", async () => {
    const { status } = await call("notify", {
      params: { id: "00000000-0000-0000-0000-000000000000" },
      body: { target: "customer", recipients: ["x@example.org"], dryRun: true },
    });
    expect(status).toBe(404);
  });
});
