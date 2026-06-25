// Typed event envelope shared between realtime server and clients.
// Generic transport layer — chat is one use case; student-activity monitoring
// (future) reuses the same envelope.

import type { WorldSpec } from "./world-engine/types.js";
import type { WorldPresence } from "./social-world/world-presence.js";

export interface RealtimeEventEnvelope<T = unknown> {
  type: string;
  topic?: string;
  payload: T;
}

// Person chat events
export type PersonChatEvent =
  | { type: "personChat:message"; topic: string; payload: PersonChatMessagePayload }
  | { type: "personChat:roomUpdated"; topic: string; payload: PersonChatRoomUpdatedPayload }
  | { type: "personChat:unread"; topic: string; payload: PersonChatUnreadPayload }
  | { type: "personChat:roomCreated"; topic: string; payload: PersonChatRoomCreatedPayload };

export interface PersonChatMessagePayload {
  id: string;
  roomId: string;
  senderPersonId: string;
  body: string;
  createdAt: string;
  clientId?: string;
}

export interface PersonChatRoomUpdatedPayload {
  roomId: string;
  lastMessageAt: string;
  lastMessagePreview?: string;
}

export interface PersonChatUnreadPayload {
  roomId: string;
  unreadCount: number;
}

export interface PersonChatRoomCreatedPayload {
  roomId: string;
}

// =============================================================================
// LIVE CALLS — WebRTC signaling over the realtime WS. The server is a dumb
// relay for SDP/ICE; media itself flows peer-to-peer and never reaches us.
// =============================================================================

/** Which tracks a participant has enabled. */
export interface CallMediaFlags {
  audio: boolean;
  video: boolean;
  pose: boolean;
}

/** Opaque WebRTC signal (SDP offer/answer or ICE candidate). Relayed verbatim. */
export type CallSignal = Record<string, unknown>;

/**
 * A social game attached to a call. A call (chatroom) is plain video chat when
 * `game` is null; setting a game turns the call panel into the game surface for
 * every participant. The reference is intentionally lightweight — clients load
 * the actual definition/world by `appId` (custom app) or `worldSpecKey` (a
 * built-in world spec). World state itself flows over the mesh "world" channel,
 * never through this event.
 */
export interface CallGame {
  /** custom_apps.id, or a built-in app id (e.g. "social_world"). */
  appId: string;
  /** Engine discriminator that decides how the client renders it (e.g. "social_world"). */
  engine: string;
  /** For built-in world-engine specs; defaults to "social-field". */
  worldSpecKey?: string;
  /** Certified WorldSpec for a CUSTOM world app (travels with the game so every
   *  participant renders the same world without a second fetch). Built-in games
   *  use `worldSpecKey` instead. */
  worldSpec?: WorldSpec;
  /** Display label. */
  name?: string;
  /** Optional player cap (from the app's multiplayer spec). */
  maxPlayers?: number;
  /**
   * When true, the world forms proximity-based CONVERSATION CIRCLES: each client
   * dynamically connects only to peers within range (the circle solver / media
   * gate), so multiple conversations form in parallel. When false/absent the
   * call stays a single full-mesh circle (everyone hears everyone) — the safe
   * default for small call-with-game sessions. See the large-world planning doc.
   */
  conversationCircles?: boolean;
}

// Client → server call commands (handled by the /ws/call onCommand).
export type CallClientCommand =
  | { type: "call:act-as"; studentId: string } // AAC: act as the student being fronted (else the user acts as self)
  | { type: "call:invite"; callId: string; roomId: string; media: CallMediaFlags; autoAccept?: boolean } // autoAccept: rung AAC clients auto-open the call instead of ringing
  | { type: "call:invite-contact"; callId: string; contactId: string; media: CallMediaFlags; autoAccept?: boolean }
  | { type: "call:invite-person"; callId: string; personId: string; media: CallMediaFlags; autoAccept?: boolean } // ring a specific person INTO an existing call (clinician multi-party invite, by personId)
  | { type: "call:accept"; callId: string }
  | { type: "call:decline"; callId: string; reason?: string }
  | { type: "call:cancel"; callId: string }
  | { type: "call:signal"; callId: string; to: string; signal: CallSignal }
  | { type: "call:media-state"; callId: string; audio: boolean; video: boolean; pose: boolean }
  | { type: "call:set-game"; callId: string; game: CallGame | null } // attach/detach a social game on the call (null → back to plain video)
  | { type: "call:start-solo-game"; callId: string; game: CallGame } // open a one-person room with a game (no ring), joinable via invite
  | { type: "call:invite-into-call"; callId: string; contactId: string; media: CallMediaFlags; autoAccept?: boolean } // ring a contact INTO the existing call (vs starting a new one)
  | { type: "call:world"; callId: string; presence: WorldPresence } // RELAY: this participant's avatar position, fanned world-wide to feed the circle solver (decoupled from the media mesh)
  | { type: "call:npc"; callId: string; msg: unknown } // RELIABLE relay for AI-NPC conversation (say/state/audio/position) — server-fanned to every participant, independent of the media mesh (which prunes distant peers). `msg` is an NpcNetMessage (shared/social-world), relayed verbatim.
  | { type: "call:focus"; callId: string; to: string | null } // caller declares who they're addressing (a remote personId), or null for everyone
  | { type: "call:conversation"; join: boolean; callId: string } // non-student caller joins/leaves the conversation room for the call (so they appear in AAC rosters + receive roster/focus)
  | { type: "call:utterance"; callId: string; text: string } // non-student caller's Web-Speech transcript → published into the conversation room (primary path)
  | { type: "call:audio"; callId: string; chunk: string; sampleRate: number; lang?: string } // FALLBACK: non-student caller's mic PCM (base64 LINEAR16 mono @ sampleRate) → server Google Cloud STT → published into the conversation room
  | { type: "call:leave"; callId: string };

// Server → client call events (delivered on call:<callId> or call:person:<id>).
export type CallEvent =
  | { type: "call:ringing"; topic: string; payload: { callId: string; roomId: string; fromPersonId: string; fromName?: string; fromPhoto?: string; media: CallMediaFlags; autoAccept?: boolean } }
  | { type: "call:accepted"; topic: string; payload: { callId: string; byPersonId: string } }
  | { type: "call:declined"; topic: string; payload: { callId: string; byPersonId: string; reason?: string } }
  | { type: "call:cancelled"; topic: string; payload: { callId: string } }
  | { type: "call:peer-joined"; topic: string; payload: { callId: string; personId: string; role?: string; media: CallMediaFlags } }
  | { type: "call:peer-left"; topic: string; payload: { callId: string; personId: string } }
  | { type: "call:signal"; topic: string; payload: { callId: string; fromPersonId: string; toPersonId: string; signal: CallSignal } }
  | { type: "call:media-state"; topic: string; payload: { callId: string; personId: string; audio: boolean; video: boolean; pose: boolean } }
  | { type: "call:game"; topic: string; payload: { callId: string; game: CallGame | null; byPersonId: string } } // a participant attached/detached a game (also sent to late joiners as catch-up)
  | { type: "call:world"; topic: string; payload: { callId: string; personId: string; presence: WorldPresence } } // a participant's relayed avatar position (world-wide position channel)
  | { type: "call:npc"; topic: string; payload: { callId: string; fromPersonId: string; msg: unknown } } // an NPC-conversation message relayed from `fromPersonId` to every participant
  | { type: "call:ended"; topic: string; payload: { callId: string; reason: string } }
  | { type: "call:error"; topic: string; payload: { callId?: string; code: string; message: string } };

// Client → server envelopes (subscribe/unsubscribe/ping)
export type ClientRealtimeCommand =
  | { type: "subscribe"; topic: string }
  | { type: "unsubscribe"; topic: string }
  | { type: "ping" };
