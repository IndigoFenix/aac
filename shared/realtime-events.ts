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

// Client → server envelopes (subscribe/unsubscribe/ping)
export type ClientRealtimeCommand =
  | { type: "subscribe"; topic: string }
  | { type: "unsubscribe"; topic: string }
  | { type: "ping" };
