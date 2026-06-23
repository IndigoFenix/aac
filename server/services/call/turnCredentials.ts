// TURN credential minting (coturn "REST API" / time-limited shared-secret auth).
//
// Our self-hosted coturn runs with `use-auth-secret` + a `static-auth-secret`
// shared with the app (env TURN_SECRET). We never store per-user TURN passwords;
// instead each client fetches a short-lived credential derived from that secret:
//
//   username   = "<unix-expiry>:<label>"
//   credential = base64( HMAC-SHA1( TURN_SECRET, username ) )
//
// coturn recomputes the same HMAC and checks the expiry, so the credential is
// self-validating and expires on its own — no server-side session state.
//
// Config (all optional; absent → STUN-only, no TURN relay):
//   TURN_URLS   comma-separated ICE urls, e.g.
//               "turn:turn.example.com:3478?transport=udp,turns:turn.example.com:5349?transport=tcp"
//   TURN_SECRET shared static-auth-secret (must match coturn)
//   TURN_TTL    credential lifetime in seconds (default 3600)
//   STUN_URLS   comma-separated STUN urls (default Google's public STUN)

import { createHmac } from "crypto";

const DEFAULT_STUN = ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"];
const DEFAULT_TTL_SECONDS = 3600;

export interface IceConfig {
  iceServers: RTCIceServerLike[];
}

// Minimal RTCIceServer shape (the DOM type isn't available server-side).
export interface RTCIceServerLike {
  urls: string | string[];
  username?: string;
  credential?: string;
}

function splitEnvList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Build the ICE server list for a client. STUN is always included. TURN is added
 * only when TURN_URLS + TURN_SECRET are configured, with a freshly-minted
 * time-limited credential.
 *
 * @param label   identity label embedded in the username (e.g. user/person id).
 * @param nowMs   injectable clock for testing (defaults to Date.now()).
 */
export function buildIceConfig(
  label: string,
  env: NodeJS.ProcessEnv = process.env,
  nowMs: number = Date.now(),
): IceConfig {
  const stunUrls = splitEnvList(env.STUN_URLS);
  const iceServers: RTCIceServerLike[] = [
    { urls: stunUrls.length > 0 ? stunUrls : DEFAULT_STUN },
  ];

  const turnUrls = splitEnvList(env.TURN_URLS);
  const secret = env.TURN_SECRET;
  if (turnUrls.length > 0 && secret) {
    const ttl = Number(env.TURN_TTL) > 0 ? Number(env.TURN_TTL) : DEFAULT_TTL_SECONDS;
    const expiry = Math.floor(nowMs / 1000) + ttl;
    // Sanitize the label: coturn usernames must not contain the ':' separator.
    const safeLabel = (label || "anon").replace(/[^A-Za-z0-9_-]/g, "");
    const username = `${expiry}:${safeLabel}`;
    const credential = createHmac("sha1", secret).update(username).digest("base64");
    iceServers.push({ urls: turnUrls, username, credential });
  }

  return { iceServers };
}

/** True when a TURN relay is configured (otherwise the app is STUN-only). */
export function turnConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return splitEnvList(env.TURN_URLS).length > 0 && !!env.TURN_SECRET;
}
