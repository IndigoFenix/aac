import { apiRequest } from "@/lib/queryClient";
import type { CallGame } from "@shared/realtime-events";

/**
 * Fetch the ICE servers (STUN/TURN) the WebRTC peer connection should use.
 * Backed by GET /api/call/ice-servers.
 */
export async function fetchIceServers(): Promise<RTCIceServer[]> {
  const res = await apiRequest("GET", "/api/call/ice-servers");
  const data = await res.json();
  if (!data?.success) throw new Error(data?.message || "Failed to fetch ICE servers");
  return (data.iceServers ?? []) as RTCIceServer[];
}

/** A student who has listed the current user as a callable contact. */
export interface CallableStudent {
  contactId: string;
  studentId: string;
  personId: string;
  name: string;
  online: boolean;
}

/** Students the current user may call (they listed this user as a callable contact). */
export async function fetchCallableStudents(): Promise<CallableStudent[]> {
  const res = await apiRequest("GET", "/api/call/callable-students");
  const data = await res.json();
  if (!data?.success) throw new Error(data?.message || "Failed to fetch callable students");
  return (data.students ?? []) as CallableStudent[];
}

/** A participant in an active call (for the in-call addressee picker). The
 *  clinician now receives these live over the call WS (conversation-room
 *  roster), but the HTTP endpoint remains available for non-WS callers. */
export interface CallParticipantInfo {
  personId: string;
  name: string;
  /** Stored-face photo (data URL), when available — used for in-game avatar faces. */
  photo?: string;
}

/** Social games attachable to a call: the built-in default + the institute's
 *  multiplayer custom apps (each a ready-to-attach CallGame with its WorldSpec). */
export async function fetchSocialGameOptions(instituteId: string): Promise<CallGame[]> {
  const res = await apiRequest("GET", `/api/social-game/options/${instituteId}`);
  const data = await res.json();
  if (!data?.success) throw new Error(data?.message || "Failed to fetch social games");
  return (data.options ?? []) as CallGame[];
}
