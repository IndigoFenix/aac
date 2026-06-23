// Typed event envelope shared between realtime server and clients.
// Generic transport layer — chat is one use case; student-activity monitoring
// (future) reuses the same envelope.

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

// Client → server call commands (handled by the /ws/call onCommand).
export type CallClientCommand =
  | { type: "call:act-as"; studentId: string } // AAC: act as the student being fronted (else the user acts as self)
  | { type: "call:invite"; callId: string; roomId: string; media: CallMediaFlags }
  | { type: "call:invite-contact"; callId: string; contactId: string; media: CallMediaFlags }
  | { type: "call:accept"; callId: string }
  | { type: "call:decline"; callId: string; reason?: string }
  | { type: "call:cancel"; callId: string }
  | { type: "call:signal"; callId: string; to: string; signal: CallSignal }
  | { type: "call:media-state"; callId: string; audio: boolean; video: boolean; pose: boolean }
  | { type: "call:focus"; callId: string; to: string | null } // caller declares who they're addressing (a remote personId), or null for everyone
  | { type: "call:conversation"; join: boolean; callId: string } // non-student caller joins/leaves the conversation room for the call (so they appear in AAC rosters + receive roster/focus)
  | { type: "call:utterance"; callId: string; text: string } // non-student caller's Web-Speech transcript → published into the conversation room (primary path)
  | { type: "call:audio"; callId: string; chunk: string; sampleRate: number; lang?: string } // FALLBACK: non-student caller's mic PCM (base64 LINEAR16 mono @ sampleRate) → server Google Cloud STT → published into the conversation room
  | { type: "call:leave"; callId: string };

// Server → client call events (delivered on call:<callId> or call:person:<id>).
export type CallEvent =
  | { type: "call:ringing"; topic: string; payload: { callId: string; roomId: string; fromPersonId: string; fromName?: string; media: CallMediaFlags } }
  | { type: "call:accepted"; topic: string; payload: { callId: string; byPersonId: string } }
  | { type: "call:declined"; topic: string; payload: { callId: string; byPersonId: string; reason?: string } }
  | { type: "call:cancelled"; topic: string; payload: { callId: string } }
  | { type: "call:peer-joined"; topic: string; payload: { callId: string; personId: string; role?: string; media: CallMediaFlags } }
  | { type: "call:peer-left"; topic: string; payload: { callId: string; personId: string } }
  | { type: "call:signal"; topic: string; payload: { callId: string; fromPersonId: string; toPersonId: string; signal: CallSignal } }
  | { type: "call:media-state"; topic: string; payload: { callId: string; personId: string; audio: boolean; video: boolean; pose: boolean } }
  | { type: "call:ended"; topic: string; payload: { callId: string; reason: string } }
  | { type: "call:error"; topic: string; payload: { callId?: string; code: string; message: string } };

// Client → server envelopes (subscribe/unsubscribe/ping)
export type ClientRealtimeCommand =
  | { type: "subscribe"; topic: string }
  | { type: "unsubscribe"; topic: string }
  | { type: "ping" };
