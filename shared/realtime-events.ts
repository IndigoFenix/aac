// Typed event envelope shared between realtime server and clients.
// Generic transport layer — chat is one use case; student-activity monitoring
// (future) reuses the same envelope.

export interface RealtimeEventEnvelope<T = unknown> {
  type: string;
  topic?: string;
  payload: T;
}

// User chat events
export type UserChatEvent =
  | { type: "userChat:message"; topic: string; payload: UserChatMessagePayload }
  | { type: "userChat:roomUpdated"; topic: string; payload: UserChatRoomUpdatedPayload }
  | { type: "userChat:unread"; topic: string; payload: UserChatUnreadPayload };

export interface UserChatMessagePayload {
  id: string;
  roomId: string;
  senderId: string;
  body: string;
  createdAt: string;
}

export interface UserChatRoomUpdatedPayload {
  roomId: string;
  lastMessageAt: string;
  lastMessagePreview?: string;
}

export interface UserChatUnreadPayload {
  roomId: string;
  unreadCount: number;
}

// Client → server envelopes (subscribe/unsubscribe/ping)
export type ClientRealtimeCommand =
  | { type: "subscribe"; topic: string }
  | { type: "unsubscribe"; topic: string }
  | { type: "ping" };
