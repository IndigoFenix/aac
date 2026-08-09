// server/services/smart-home/google/fulfillment.ts
//
// GOOGLE CLOUD-TO-CLOUD FULFILLMENT — pure, transport-free intent handlers.
//
// Google sends every intent to ONE endpoint as `{requestId, inputs:[{intent,
// payload}]}`. This module turns that envelope into a response object and
// nothing else: no express, no db, no env. The Express seam lives in
// `./router.ts`, which resolves the bearer to a student and supplies the deps.
// (Keeping the handlers transport-agnostic mirrors the Alexa side, which must
// run inside a Lambda wrapper rather than an HTTP route.)
//
// ── THE VIRTUAL DEVICE ──────────────────────────────────────────────────────
// One device per ENABLED `google` home-action slot; the device id IS
// `action.id` (virtual-device law, planning-docs/smart-home-actions.md).
// Shape, verified against developers.home.google.com (2026-08):
//
//   type   action.devices.types.SENSOR
//   trait  action.devices.traits.OpenClose  with queryOnlyOpenClose: true
//
// The SENSOR device guide states it verbatim: "Sensors that report data covered
// by another trait should use that trait with the `queryOnly*` attribute for
// that trait set to `true`. For example, window sensors should use the OpenClose
// trait with the `queryOnlyOpenClose` attribute set to `true`." There is no
// CONTACT_SENSOR device type — a contact sensor IS `SENSOR` + query-only
// OpenClose. `discreteOnlyOpenClose: true` makes it a two-state contact (fully
// open or fully closed), never a percentage slider.
//
// STARTER-ELIGIBLE: the Automations Script Editor exposes OpenClose as a device
// state starter — `developers.home.google.com/automations/schema/reference/
// entity/sht_device/open_close_state` documents exactly this YAML:
//
//   starters:
//     - type: device.state.OpenClose
//       device: My Device - Room Name
//       state: openPercent
//       is: 100
//
// …which is why the trigger fires by driving `openPercent` to 100 and back to 0
// (see `google-trigger-provider.ts`). `willReportState: true` is what makes
// Home Graph accept our Report State pushes at all.
//
// Because the trait is QUERY-ONLY these devices accept no commands: EXECUTE
// always answers `status:"ERROR", errorCode:"functionNotSupported"`.
//
// ── agentUserId ─────────────────────────────────────────────────────────────
// The studentId. Home actions are per-STUDENT (the slot list lives in that
// student's `aac_settings`, and an account-link grant binds provider→student),
// so the student id is the stable, immutable user handle Google needs.

import type { HomeAction } from "@shared/schema";
import { enabledHomeActions } from "@shared/home-actions";
import type { SmartHomeProvider } from "../types";
import type { HomeGraphClient, HomeGraphDeviceState } from "./homegraph-client";

// ---------------------------------------------------------------------------
// The virtual-device shape (ONE definition — the provider imports these too)
// ---------------------------------------------------------------------------

export const GOOGLE_TRIGGER_DEVICE_TYPE = "action.devices.types.SENSOR";
export const GOOGLE_TRIGGER_TRAIT = "action.devices.traits.OpenClose";

/** Query-only + discrete = a contact sensor, not a controllable opening. */
export const GOOGLE_TRIGGER_ATTRIBUTES: Record<string, unknown> = {
  discreteOnlyOpenClose: true,
  queryOnlyOpenClose: true,
};

/** Resting: contact CLOSED. Everything but the instant of a trigger. */
export const GOOGLE_TRIGGER_RESTING_STATE: HomeGraphDeviceState = {
  online: true,
  openPercent: 0,
};

/** Fired: contact OPEN. `openPercent: 100` is what `is: 100` starters match. */
export const GOOGLE_TRIGGER_OPEN_STATE: HomeGraphDeviceState = {
  online: true,
  openPercent: 100,
};

const DEVICE_INFO = {
  manufacturer: "aivota",
  model: "home-action-trigger",
  hwVersion: "1.0",
  swVersion: "1.0",
};

/** Shown in the Home app before the family renames the device. */
const DEFAULT_DEVICE_NAME = "Aivota Home Action";

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

export interface GoogleIntentRequest {
  requestId?: string;
  inputs?: Array<{ intent?: string; payload?: unknown }>;
}

export interface GoogleSyncDevice {
  id: string;
  type: string;
  traits: string[];
  name: { name: string; defaultNames: string[]; nicknames: string[] };
  willReportState: boolean;
  attributes: Record<string, unknown>;
  deviceInfo: { manufacturer: string; model: string; hwVersion: string; swVersion: string };
}

export interface GoogleSyncResponse {
  requestId: string;
  payload: { agentUserId: string; devices: GoogleSyncDevice[] };
}

export interface GoogleQueryResponse {
  requestId: string;
  payload: { devices: Record<string, HomeGraphDeviceState> };
}

export interface GoogleExecuteCommandResult {
  ids: string[];
  status: "SUCCESS" | "PENDING" | "OFFLINE" | "EXCEPTIONS" | "ERROR";
  errorCode?: string;
  states?: HomeGraphDeviceState;
}

export interface GoogleExecuteResponse {
  requestId: string;
  payload: { commands: GoogleExecuteCommandResult[] };
}

export interface GoogleErrorResponse {
  requestId: string;
  payload: { errorCode: string };
}

/** DISCONNECT's documented response has NO properties — the body is `{}`. */
export type GoogleDisconnectResponse = Record<string, never>;

export type GoogleFulfillmentResponse =
  | GoogleSyncResponse
  | GoogleQueryResponse
  | GoogleExecuteResponse
  | GoogleErrorResponse
  | GoogleDisconnectResponse;

// ---------------------------------------------------------------------------
// Injected collaborators
// ---------------------------------------------------------------------------

/** Whose devices this request is about — the resolved bearer's student. */
export interface GoogleFulfillmentIdentity {
  studentId: string;
}

export interface GoogleFulfillmentDeps {
  /**
   * The student's home-action slots, read OUTSIDE a live session. The real
   * implementation (in `router.ts`) goes
   * `aacSettingsRepository.getByStudentId(studentId)` →
   * `normalizeHomeActions(settings?.homeActions)` — the same shared sanitizer
   * `dual-agent-service.ts` uses, never the raw jsonb.
   */
  loadHomeActions(studentId: string): Promise<HomeAction[]>;
  /**
   * Optional. Google asks integrations to prime Home Graph with current state
   * after answering SYNC, so an automation has a baseline to compare against.
   * Absent or unconfigured ⇒ silently skipped.
   */
  homegraph?: HomeGraphClient;
  /**
   * Optional. Called on DISCONNECT. The DISCONNECT spec requires only that we
   * STOP calling Report State / Request Sync for the user — dropping the grant
   * is how we guarantee that (and is prudent regardless). Failures are
   * swallowed: the acknowledgement must go out either way.
   */
  revokeAccountLink?(studentId: string, provider: SmartHomeProvider): Promise<void>;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Handle one Google cloud-to-cloud intent envelope.
 *
 * `body` is UNTRUSTED wire input — every field is re-checked here rather than
 * assumed. Never throws for a malformed envelope; an unrecognised intent gets
 * Google's generic `notSupported` error payload.
 */
export async function handleGoogleFulfillment(
  body: unknown,
  identity: GoogleFulfillmentIdentity,
  deps: GoogleFulfillmentDeps,
): Promise<GoogleFulfillmentResponse> {
  const request = (body ?? {}) as GoogleIntentRequest;
  const requestId = typeof request.requestId === "string" ? request.requestId : "";
  const input = Array.isArray(request.inputs) ? request.inputs[0] : undefined;
  const intent = typeof input?.intent === "string" ? input.intent : "";

  switch (intent) {
    case "action.devices.SYNC":
      return handleSync(requestId, identity, deps);
    case "action.devices.QUERY":
      return handleQuery(requestId, input?.payload);
    case "action.devices.EXECUTE":
      return handleExecute(requestId, input?.payload);
    case "action.devices.DISCONNECT":
      return handleDisconnect(identity, deps);
    default:
      return { requestId, payload: { errorCode: "notSupported" } };
  }
}

// ---------------------------------------------------------------------------
// SYNC
// ---------------------------------------------------------------------------

/** One enabled `google` slot → one virtual contact sensor. */
export function toSyncDevice(action: HomeAction): GoogleSyncDevice {
  return {
    id: action.id,
    type: GOOGLE_TRIGGER_DEVICE_TYPE,
    traits: [GOOGLE_TRIGGER_TRAIT],
    name: {
      name: action.label,
      defaultNames: [DEFAULT_DEVICE_NAME],
      nicknames: [action.label],
    },
    willReportState: true,
    attributes: { ...GOOGLE_TRIGGER_ATTRIBUTES },
    deviceInfo: { ...DEVICE_INFO },
  };
}

/** The devices a student currently exposes: ENABLED `google` slots only. */
export function googleTriggerDevices(actions: HomeAction[]): GoogleSyncDevice[] {
  return enabledHomeActions(actions)
    .filter((action) => action.type === "google")
    .map(toSyncDevice);
}

async function handleSync(
  requestId: string,
  identity: GoogleFulfillmentIdentity,
  deps: GoogleFulfillmentDeps,
): Promise<GoogleSyncResponse> {
  const actions = await deps.loadHomeActions(identity.studentId);
  const devices = googleTriggerDevices(actions);
  const response: GoogleSyncResponse = {
    requestId,
    payload: { agentUserId: identity.studentId, devices },
  };
  await primeHomeGraph(identity.studentId, devices, deps);
  return response;
}

/**
 * Push the resting state of every synced device so Home Graph is not empty.
 * AWAITED, never detached: this server runs on AWS Lambda, which freezes the
 * container after the response, so a background promise would silently die.
 */
async function primeHomeGraph(
  agentUserId: string,
  devices: GoogleSyncDevice[],
  deps: GoogleFulfillmentDeps,
): Promise<void> {
  const client = deps.homegraph;
  if (!client || devices.length === 0) return;
  if (!client.isConfigured()) return;
  const states: Record<string, HomeGraphDeviceState> = {};
  for (const device of devices) states[device.id] = { ...GOOGLE_TRIGGER_RESTING_STATE };
  try {
    const result = await client.reportState(agentUserId, states);
    if (!result.ok) {
      console.warn(`[GoogleFulfillment] SYNC state priming failed: ${result.reason}`);
    }
  } catch (error: any) {
    // Priming is best-effort — a failure must never spoil the SYNC answer.
    console.warn("[GoogleFulfillment] SYNC state priming threw:", error?.message || error);
  }
}

// ---------------------------------------------------------------------------
// QUERY
// ---------------------------------------------------------------------------

/**
 * Every requested device answers with the RESTING state (contact closed,
 * online). A virtual trigger has no backing resource to poll: `openPercent: 0`
 * is the truthful answer at every instant except the sub-second window inside
 * `googleTriggerProvider.execute`, and Google reconciles the device LIST
 * through SYNC/requestSync rather than through QUERY.
 */
function handleQuery(requestId: string, payload: unknown): GoogleQueryResponse {
  const requested = (payload ?? {}) as { devices?: Array<{ id?: unknown }> };
  const devices: Record<string, HomeGraphDeviceState> = {};
  for (const entry of Array.isArray(requested.devices) ? requested.devices : []) {
    const id = typeof entry?.id === "string" ? entry.id.trim() : "";
    if (!id) continue;
    devices[id] = { ...GOOGLE_TRIGGER_RESTING_STATE, status: "SUCCESS" };
  }
  return { requestId, payload: { devices } };
}

// ---------------------------------------------------------------------------
// EXECUTE
// ---------------------------------------------------------------------------

/**
 * These devices are sensors — `queryOnlyOpenClose: true` — so there is nothing
 * to command. Google's documented shape for a device that cannot perform a
 * command is `{ids, status:"ERROR", errorCode:"functionNotSupported"}`.
 */
function handleExecute(requestId: string, payload: unknown): GoogleExecuteResponse {
  const body = (payload ?? {}) as {
    commands?: Array<{ devices?: Array<{ id?: unknown }> }>;
  };
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const command of Array.isArray(body.commands) ? body.commands : []) {
    for (const device of Array.isArray(command?.devices) ? command.devices : []) {
      const id = typeof device?.id === "string" ? device.id.trim() : "";
      if (!id || seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }
  }
  if (ids.length === 0) return { requestId, payload: { commands: [] } };
  return {
    requestId,
    payload: { commands: [{ ids, status: "ERROR", errorCode: "functionNotSupported" }] },
  };
}

// ---------------------------------------------------------------------------
// DISCONNECT
// ---------------------------------------------------------------------------

/**
 * The family unlinked us in the Home app. The documented response has no
 * properties — an empty object. The spec's actual requirement is that we stop
 * calling Report State / Request Sync for this user, which dropping the grant
 * enforces at the source.
 */
async function handleDisconnect(
  identity: GoogleFulfillmentIdentity,
  deps: GoogleFulfillmentDeps,
): Promise<GoogleDisconnectResponse> {
  if (deps.revokeAccountLink) {
    try {
      await deps.revokeAccountLink(identity.studentId, "google");
    } catch (error: any) {
      // Acknowledge regardless — Google retries a failed DISCONNECT, and a
      // stuck unlink is worse than a grant we clean up on the next attempt.
      console.error(
        `[GoogleFulfillment] DISCONNECT could not revoke the grant for student ${identity.studentId}:`,
        error?.message || error,
      );
    }
  }
  return {};
}
