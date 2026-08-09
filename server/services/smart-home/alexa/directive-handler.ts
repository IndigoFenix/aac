// server/services/smart-home/alexa/directive-handler.ts
//
// ALEXA SMART HOME FULFILLMENT — pure, transport-free directive handling.
//
// Alexa sends every directive as `{directive:{header,endpoint?,payload}}` and
// expects `{event:{header,endpoint?,payload}, context?}` back. This module turns
// one envelope into the other and does NOTHING else: no express, no db, no env,
// no fetch. That matters more here than on the Google side — a production Alexa
// smart home skill MUST be fronted by a Lambda, not an HTTPS route, so the same
// handler has to run under two different transports:
//
//   dev / tunnel testing  →  ./router.ts        (express, not mounted)
//   production            →  a thin Lambda wrapper the future Terraform adds
//
// ── THE VIRTUAL DEVICE ──────────────────────────────────────────────────────
// One endpoint per ENABLED `alexa` home-action slot; the endpointId IS
// `action.id` (virtual-device law, planning-docs/smart-home-actions.md). The
// class is a DOORBELL, because `DoorbellPress` is a first-class "When this
// happens" trigger in the Alexa Routines editor — the family binds each slot to
// a routine they authored themselves, which is the whole security story: the
// worst a compromised slot can do is fire a routine the family already wrote.
//
// Shapes verified against developer.amazon.com (2026-08):
//   • Alexa.Discovery — Discover / Discover.Response, payloadVersion "3",
//     `payload.endpoints[]` = {endpointId, manufacturerName, description,
//     friendlyName, displayCategories, capabilities}.
//     ("alexa-discovery.html")
//   • "you must include the `Alexa` interface for all endpoints" — hence the
//     bare `{"type":"AlexaInterface","interface":"Alexa","version":"3"}` entry.
//     ("alexa-discovery.html")
//   • Alexa.DoorbellEventSource capability declares `proactivelyReported: true`
//     at the CAPABILITY level, with no `properties` block — it is an event
//     source, not a property. displayCategories: ["DOORBELL"].
//     ("alexa-doorbelleventsource.html")
//   • Alexa.EndpointHealth is version "3.1" with
//     `properties.supported:[{name:"connectivity"}]`, and its value is the
//     NESTED `{"value":{"value":"OK"}}`. ("alexa-endpointhealth.html")
//   • Alexa.ReportState → Alexa.StateReport: `context.properties[]` plus an
//     `event` whose header echoes the request's `correlationToken` and whose
//     `endpoint` carries only `endpointId`; `payload` is `{}`.
//     ("alexa-statereport.html")
//   • Alexa.Authorization AcceptGrant: `payload.grant = {type:
//     "OAuth2.AuthorizationCode", code}`, `payload.grantee = {type:
//     "BearerToken", token}`; success is `AcceptGrant.Response` with an empty
//     payload; failure is namespace `Alexa.Authorization`, name `ErrorResponse`,
//     `payload = {type, message}`. ("alexa-authorization.html")
//   • Alexa.ErrorResponse types used here — INVALID_DIRECTIVE,
//     INVALID_AUTHORIZATION_CREDENTIAL, NO_SUCH_ENDPOINT, INTERNAL_ERROR — are
//     all in the documented type table. ("alexa-errorresponse.html")
//
// ── DISCOVERY AND AN UNRESOLVABLE BEARER ────────────────────────────────────
// The current Discovery doc says: "If you can't handle a `Discover` directive
// successfully, respond with an `Alexa.ErrorResponse` event", and lists
// INVALID_AUTHORIZATION_CREDENTIAL among the permitted types. So a bearer that
// resolves to nobody is answered with that error, NOT with an empty endpoint
// list — which matches `account-link-service.ts`'s own contract ("handlers must
// treat null as 'no such user' … never as an empty device list"). An empty
// `endpoints` array is reserved for its true meaning: this student is linked and
// currently has no enabled `alexa` slots. That IS the state every real student
// is in today, so discovery legitimately returns `[]` until a clinician authors
// a cloud slot.
//
// UNTRUSTED INPUT: `body` comes off the wire. Every field is re-checked here
// rather than assumed, and nothing throws for a malformed envelope.

import { randomUUID } from "crypto";
import type { HomeAction } from "@shared/schema";
import { enabledHomeActions } from "@shared/home-actions";
import type { AccountLinkIdentity } from "../account-link-service";
import type { LwaExchangeResult, LwaTokenSet } from "./event-gateway-client";

// ---------------------------------------------------------------------------
// The virtual-endpoint shape (ONE definition — tests and the Lambda read these)
// ---------------------------------------------------------------------------

export const ALEXA_PAYLOAD_VERSION = "3";

/** Shown in the Alexa app under the device. */
export const ALEXA_MANUFACTURER_NAME = "Aivota";

/** Doorbell class: `DoorbellPress` is a first-class Routine trigger. */
export const ALEXA_TRIGGER_DISPLAY_CATEGORY = "DOORBELL";

/** Used when a slot carries no clinician-authored `description`. */
export const ALEXA_DEFAULT_ENDPOINT_DESCRIPTION = "Aivota home action trigger";

/** Used when a slot's label sanitizes down to nothing (e.g. emoji-only). */
export const ALEXA_DEFAULT_FRIENDLY_NAME = "Aivota Home Action";

export interface AlexaCapability {
  type: "AlexaInterface";
  interface: string;
  version: string;
  proactivelyReported?: boolean;
  properties?: {
    supported: Array<{ name: string }>;
    proactivelyReported: boolean;
    retrievable: boolean;
  };
}

/**
 * Every virtual doorbell declares the same three capabilities.
 *
 * EndpointHealth is `retrievable: true` / `proactivelyReported: false` on
 * purpose: we answer `ReportState` with OK (the Alexa app then shows the
 * endpoint as healthy rather than "not responding"), but we never push a
 * ChangeReport for connectivity — and declaring a proactive report we do not
 * actually send is exactly what skill certification fails you for.
 */
export const ALEXA_TRIGGER_CAPABILITIES: readonly AlexaCapability[] = [
  { type: "AlexaInterface", interface: "Alexa", version: "3" },
  {
    type: "AlexaInterface",
    interface: "Alexa.DoorbellEventSource",
    version: "3",
    proactivelyReported: true,
  },
  {
    type: "AlexaInterface",
    interface: "Alexa.EndpointHealth",
    version: "3.1",
    properties: {
      supported: [{ name: "connectivity" }],
      proactivelyReported: false,
      retrievable: true,
    },
  },
];

export interface AlexaEndpoint {
  endpointId: string;
  manufacturerName: string;
  description: string;
  friendlyName: string;
  displayCategories: string[];
  capabilities: AlexaCapability[];
}

/**
 * A slot label as Alexa will accept it. Friendly names are spoken and matched by
 * voice, so Alexa rejects punctuation and symbols; emoji in particular are
 * common in our labels (the same string doubles as button text). Unicode LETTERS
 * and digits survive — a Hebrew or Portuguese label must not be mangled — while
 * punctuation, symbols and emoji are dropped and runs of whitespace collapse.
 */
export function alexaFriendlyName(label: string): string {
  const cleaned = String(label ?? "")
    .replace(/[^\p{L}\p{N} ]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 128)
    .trim();
  return cleaned || ALEXA_DEFAULT_FRIENDLY_NAME;
}

/**
 * The student's ENABLED `alexa` slots as Alexa endpoints. `spoken` slots
 * actuate on the device and `google` slots belong to the other ecosystem, so
 * neither may ever appear here; a disabled slot stays authored but inert.
 */
export function alexaTriggerEndpoints(actions: HomeAction[]): AlexaEndpoint[] {
  return enabledHomeActions(Array.isArray(actions) ? actions : [])
    .filter((action) => action.type === "alexa" && !!action.id)
    .map((action) => ({
      endpointId: action.id,
      manufacturerName: ALEXA_MANUFACTURER_NAME,
      description: (action.description ?? "").trim() || ALEXA_DEFAULT_ENDPOINT_DESCRIPTION,
      friendlyName: alexaFriendlyName(action.label),
      displayCategories: [ALEXA_TRIGGER_DISPLAY_CATEGORY],
      capabilities: ALEXA_TRIGGER_CAPABILITIES.map((c) => ({ ...c })),
    }));
}

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

export interface AlexaDirectiveHeader {
  namespace?: string;
  name?: string;
  messageId?: string;
  correlationToken?: string;
  payloadVersion?: string;
}

export interface AlexaDirectiveEnvelope {
  directive?: {
    header?: AlexaDirectiveHeader;
    endpoint?: {
      scope?: { type?: string; token?: string };
      endpointId?: string;
      cookie?: Record<string, unknown>;
    };
    payload?: Record<string, unknown>;
  };
}

export interface AlexaProperty {
  namespace: string;
  name: string;
  value: unknown;
  timeOfSample: string;
  uncertaintyInMilliseconds: number;
}

export interface AlexaEventEnvelope {
  event: {
    header: {
      namespace: string;
      name: string;
      messageId: string;
      payloadVersion: string;
      correlationToken?: string;
    };
    endpoint?: {
      scope?: { type: "BearerToken"; token: string };
      endpointId?: string;
    };
    payload: Record<string, unknown>;
  };
  context?: { properties: AlexaProperty[] };
}

// ---------------------------------------------------------------------------
// Injected collaborators
// ---------------------------------------------------------------------------

export interface AlexaDirectiveDeps {
  /**
   * Bearer (the token WE issued at account linking) → the student it was granted
   * for. Null means unknown/expired/revoked. `router.ts` supplies
   * `resolveAccountLinkBearer`.
   */
  resolveBearer(token: string): Promise<AccountLinkIdentity | null>;
  /**
   * The student's home-action slots, read OUTSIDE a live session. The real
   * implementation (in `router.ts`) goes
   * `aacSettingsRepository.getByStudentId(studentId)` →
   * `normalizeHomeActions(settings?.homeActions)` — the same shared sanitizer
   * `dual-agent-service.ts` applies in-session, never the raw jsonb.
   */
  loadHomeActions(studentId: string): Promise<HomeAction[]>;
  /**
   * AcceptGrant's `grant.code` → event-gateway tokens, via LWA. Supplied by
   * `event-gateway-client.ts`, which owns the client credentials.
   */
  exchangeGrantCode(code: string): Promise<LwaExchangeResult>;
  /**
   * Persist those tokens in the encrypted vault under provider `'alexa'`. This
   * is the ONLY way outbound DoorbellPress events can ever be authorized, so an
   * AcceptGrant whose store fails must report failure, not success.
   */
  storeEventGatewayTokens(studentId: string, tokens: LwaTokenSet): Promise<void>;
}

// ---------------------------------------------------------------------------
// Response builders
// ---------------------------------------------------------------------------

function nowIso(): string {
  return new Date().toISOString();
}

function header(
  namespace: string,
  name: string,
  correlationToken?: string,
): AlexaEventEnvelope["event"]["header"] {
  const built: AlexaEventEnvelope["event"]["header"] = {
    namespace,
    name,
    messageId: randomUUID(),
    payloadVersion: ALEXA_PAYLOAD_VERSION,
  };
  if (correlationToken) built.correlationToken = correlationToken;
  return built;
}

/**
 * The generic `Alexa`-namespace ErrorResponse. `endpoint` is included only when
 * the directive actually named one — a Discovery failure has no endpoint to
 * blame, and inventing an empty one is worse than omitting the field.
 */
export function alexaErrorResponse(opts: {
  type: string;
  message: string;
  namespace?: string;
  correlationToken?: string;
  endpointId?: string;
  scopeToken?: string;
}): AlexaEventEnvelope {
  const event: AlexaEventEnvelope["event"] = {
    header: header(opts.namespace ?? "Alexa", "ErrorResponse", opts.correlationToken),
    payload: { type: opts.type, message: opts.message },
  };
  if (opts.endpointId) {
    event.endpoint = { endpointId: opts.endpointId };
    if (opts.scopeToken) {
      event.endpoint.scope = { type: "BearerToken", token: opts.scopeToken };
    }
  }
  return { event };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function bearerFrom(directive: AlexaDirectiveEnvelope["directive"]): string {
  // Discovery carries the scope in the PAYLOAD; every endpoint-addressed
  // directive carries it on the ENDPOINT. Accept either, in that order.
  const payloadScope = (directive?.payload as { scope?: { token?: unknown } } | undefined)?.scope;
  const payloadToken = typeof payloadScope?.token === "string" ? payloadScope.token.trim() : "";
  if (payloadToken) return payloadToken;
  const endpointToken = directive?.endpoint?.scope?.token;
  return typeof endpointToken === "string" ? endpointToken.trim() : "";
}

/**
 * Resolve a bearer to the student whose `alexa` slots it may act on. A bearer
 * minted for the OTHER ecosystem is as invalid as an unknown one.
 */
async function resolveAlexaStudent(
  token: string,
  deps: AlexaDirectiveDeps,
): Promise<string | null> {
  if (!token) return null;
  const identity = await deps.resolveBearer(token);
  if (!identity || identity.provider !== "alexa" || !identity.studentId) return null;
  return identity.studentId;
}

/**
 * Handle one Alexa directive envelope. Never throws: an unexpected failure comes
 * back as an `INTERNAL_ERROR` ErrorResponse, which is what Alexa is built to
 * read, whereas a rejected promise would surface to the family as a dead skill.
 */
export async function handleAlexaDirective(
  body: unknown,
  deps: AlexaDirectiveDeps,
): Promise<AlexaEventEnvelope> {
  const directive = ((body ?? {}) as AlexaDirectiveEnvelope).directive;
  const namespace = typeof directive?.header?.namespace === "string" ? directive.header.namespace : "";
  const name = typeof directive?.header?.name === "string" ? directive.header.name : "";
  const correlationToken =
    typeof directive?.header?.correlationToken === "string"
      ? directive.header.correlationToken
      : undefined;

  try {
    if (namespace === "Alexa.Discovery" && name === "Discover") {
      return await handleDiscover(directive, deps);
    }
    if (namespace === "Alexa.Authorization" && name === "AcceptGrant") {
      return await handleAcceptGrant(directive, deps);
    }
    if (namespace === "Alexa" && name === "ReportState") {
      return await handleReportState(directive, deps);
    }
    return alexaErrorResponse({
      type: "INVALID_DIRECTIVE",
      message: `Unsupported directive ${namespace || "?"}.${name || "?"}`,
      correlationToken,
      endpointId: directive?.endpoint?.endpointId,
    });
  } catch (error: any) {
    console.error(
      `[AlexaSmartHome] ${namespace || "?"}.${name || "?"} failed:`,
      error?.message || error,
    );
    return alexaErrorResponse({
      type: "INTERNAL_ERROR",
      message: "The add-on could not process the directive.",
      correlationToken,
      endpointId: directive?.endpoint?.endpointId,
    });
  }
}

// ---------------------------------------------------------------------------
// Alexa.Discovery
// ---------------------------------------------------------------------------

async function handleDiscover(
  directive: AlexaDirectiveEnvelope["directive"],
  deps: AlexaDirectiveDeps,
): Promise<AlexaEventEnvelope> {
  const studentId = await resolveAlexaStudent(bearerFrom(directive), deps);
  if (!studentId) {
    // NOT an empty endpoint list — see the header. An empty list would tell the
    // family "linked, you just own nothing", hiding a broken link forever.
    return alexaErrorResponse({
      type: "INVALID_AUTHORIZATION_CREDENTIAL",
      message: "The bearer token is not linked to an Aivota student.",
    });
  }

  const actions = await deps.loadHomeActions(studentId);
  return {
    event: {
      header: header("Alexa.Discovery", "Discover.Response"),
      payload: { endpoints: alexaTriggerEndpoints(actions) },
    },
  };
}

// ---------------------------------------------------------------------------
// Alexa.Authorization
// ---------------------------------------------------------------------------

/**
 * AcceptGrant carries TWO credentials and they point opposite ways:
 *   • `grantee.token` is OUR bearer — who this grant is for.
 *   • `grant.code` is AMAZON's one-time code, which we exchange at LWA for the
 *     access/refresh pair that authorizes our OUTBOUND event-gateway posts.
 * Without this exchange a press can never fire a routine, so a failure here is
 * reported honestly (the customer sees enablement fail) rather than swallowed.
 */
async function handleAcceptGrant(
  directive: AlexaDirectiveEnvelope["directive"],
  deps: AlexaDirectiveDeps,
): Promise<AlexaEventEnvelope> {
  const payload = (directive?.payload ?? {}) as {
    grant?: { type?: unknown; code?: unknown };
    grantee?: { type?: unknown; token?: unknown };
  };
  const granteeToken = typeof payload.grantee?.token === "string" ? payload.grantee.token.trim() : "";
  const code = typeof payload.grant?.code === "string" ? payload.grant.code.trim() : "";

  const studentId = await resolveAlexaStudent(granteeToken, deps);
  if (!studentId) {
    return alexaErrorResponse({
      namespace: "Alexa.Authorization",
      type: "INVALID_AUTHORIZATION_CREDENTIAL",
      message: "The grantee token is not linked to an Aivota student.",
    });
  }
  if (!code) {
    return alexaErrorResponse({
      namespace: "Alexa.Authorization",
      type: "ACCEPT_GRANT_FAILED",
      message: "Failed to handle the AcceptGrant directive because no authorization code was sent.",
    });
  }

  const exchanged = await deps.exchangeGrantCode(code);
  if (!exchanged.ok) {
    console.error(
      `[AlexaSmartHome] AcceptGrant exchange failed for student ${studentId}: ${exchanged.reason}`,
      exchanged.detail ?? "",
    );
    return alexaErrorResponse({
      namespace: "Alexa.Authorization",
      type: "ACCEPT_GRANT_FAILED",
      message:
        "Failed to handle the AcceptGrant directive because the authorization code " +
        `could not be exchanged (${exchanged.reason}).`,
    });
  }

  await deps.storeEventGatewayTokens(studentId, exchanged.tokens);

  return {
    event: {
      header: header("Alexa.Authorization", "AcceptGrant.Response"),
      payload: {},
    },
  };
}

// ---------------------------------------------------------------------------
// Alexa.ReportState
// ---------------------------------------------------------------------------

/** The one property a virtual trigger has: it is reachable. */
export function endpointHealthOk(timeOfSample: string = nowIso()): AlexaProperty {
  return {
    namespace: "Alexa.EndpointHealth",
    name: "connectivity",
    // NESTED on purpose — EndpointHealth's connectivity value is an object.
    value: { value: "OK" },
    timeOfSample,
    uncertaintyInMilliseconds: 0,
  };
}

async function handleReportState(
  directive: AlexaDirectiveEnvelope["directive"],
  deps: AlexaDirectiveDeps,
): Promise<AlexaEventEnvelope> {
  const correlationToken =
    typeof directive?.header?.correlationToken === "string"
      ? directive.header.correlationToken
      : undefined;
  const endpointId =
    typeof directive?.endpoint?.endpointId === "string" ? directive.endpoint.endpointId : "";
  const scopeToken = bearerFrom(directive);

  const studentId = await resolveAlexaStudent(scopeToken, deps);
  if (!studentId) {
    return alexaErrorResponse({
      type: "INVALID_AUTHORIZATION_CREDENTIAL",
      message: "The bearer token is not linked to an Aivota student.",
      correlationToken,
      endpointId,
      scopeToken,
    });
  }

  // A slot the clinician deleted or disabled still exists in the family's Alexa
  // app until they re-discover. Claiming it is healthy would be a lie the app
  // never corrects, so answer with the type Alexa has for exactly this.
  const endpoints = alexaTriggerEndpoints(await deps.loadHomeActions(studentId));
  if (!endpoints.some((e) => e.endpointId === endpointId)) {
    return alexaErrorResponse({
      type: "NO_SUCH_ENDPOINT",
      message: `No home action with id "${endpointId}" exists for this student.`,
      correlationToken,
      endpointId,
      scopeToken,
    });
  }

  return {
    context: { properties: [endpointHealthOk()] },
    event: {
      header: header("Alexa", "StateReport", correlationToken),
      endpoint: { endpointId },
      payload: {},
    },
  };
}
