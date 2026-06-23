import type { WebSocket } from "ws";
import type { RealtimeEventEnvelope } from "@shared/realtime-events";
import { announceLocalOnline, announceLocalOffline, isPersonOnlineRemotely } from "./presence";

// In-memory pub/sub. Single-process for now; when we scale horizontally this
// will need a Redis fanout behind the same interface.

type Subscribers = Map<WebSocket, Set<string>>; // socket → topics it subscribed to
const socketTopics: Subscribers = new Map();
const topicSockets: Map<string, Set<WebSocket>> = new Map();
const userSockets: Map<string, Set<WebSocket>> = new Map();
// person → sockets currently representing that person. A student-person has no
// socket of its own; it is reachable through whichever user is fronting it, so
// one socket may register several persons. Presence is derived from this map.
const personSockets: Map<string, Set<WebSocket>> = new Map();

export function registerUserSocket(userId: string, socket: WebSocket): void {
  if (!userSockets.has(userId)) userSockets.set(userId, new Set());
  userSockets.get(userId)!.add(socket);
  (socket as any).__userId = userId;
}

export function socketsForUser(userId: string): WebSocket[] {
  return Array.from(userSockets.get(userId) ?? []);
}

export function subscribeUserToTopic(userId: string, topic: string): void {
  for (const socket of socketsForUser(userId)) {
    subscribe(socket, topic);
  }
}

export function registerPersonSocket(personId: string, socket: WebSocket): void {
  let set = personSockets.get(personId);
  const wasOffline = !set || set.size === 0;
  if (!set) {
    set = new Set();
    personSockets.set(personId, set);
  }
  set.add(socket);
  const ids: Set<string> = (socket as any).__personIds ?? new Set<string>();
  ids.add(personId);
  (socket as any).__personIds = ids;
  // First local socket for this person → announce online cross-instance.
  if (wasOffline) announceLocalOnline(personId);
}

export function socketsForPerson(personId: string): WebSocket[] {
  return Array.from(personSockets.get(personId) ?? []);
}

/** Every person currently represented by at least one socket on this instance. */
export function localOnlinePersonIds(): string[] {
  return Array.from(personSockets.keys());
}

/**
 * A person is online/reachable if any socket on THIS instance represents them,
 * or any other instance reports them online over the presence bus.
 */
export function isPersonOnline(personId: string): boolean {
  if ((personSockets.get(personId)?.size ?? 0) > 0) return true;
  return isPersonOnlineRemotely(personId);
}

export function subscribePersonToTopic(personId: string, topic: string): void {
  for (const socket of socketsForPerson(personId)) {
    subscribe(socket, topic);
  }
}

export function subscribe(socket: WebSocket, topic: string): void {
  if (!socketTopics.has(socket)) socketTopics.set(socket, new Set());
  socketTopics.get(socket)!.add(topic);
  if (!topicSockets.has(topic)) topicSockets.set(topic, new Set());
  topicSockets.get(topic)!.add(socket);
}

export function unsubscribe(socket: WebSocket, topic: string): void {
  socketTopics.get(socket)?.delete(topic);
  topicSockets.get(topic)?.delete(socket);
  if (topicSockets.get(topic)?.size === 0) topicSockets.delete(topic);
}

export function removeSocket(socket: WebSocket): void {
  const topics = socketTopics.get(socket);
  if (topics) {
    for (const topic of topics) {
      topicSockets.get(topic)?.delete(socket);
      if (topicSockets.get(topic)?.size === 0) topicSockets.delete(topic);
    }
  }
  socketTopics.delete(socket);
  const userId: string | undefined = (socket as any).__userId;
  if (userId) {
    userSockets.get(userId)?.delete(socket);
    if (userSockets.get(userId)?.size === 0) userSockets.delete(userId);
  }
  const personIds: Set<string> | undefined = (socket as any).__personIds;
  if (personIds) {
    for (const personId of personIds) {
      const set = personSockets.get(personId);
      set?.delete(socket);
      if (set && set.size === 0) {
        personSockets.delete(personId);
        // Last local socket for this person closed → announce offline.
        announceLocalOffline(personId);
      }
    }
  }
}

export function publish(topic: string, event: RealtimeEventEnvelope): void {
  const sockets = topicSockets.get(topic);
  if (!sockets) return;
  const serialized = JSON.stringify({ ...event, topic });
  for (const socket of sockets) {
    if (socket.readyState === socket.OPEN) {
      try {
        socket.send(serialized);
      } catch (err) {
        console.error("[realtime] publish send error:", err);
      }
    }
  }
}

export function topicsForSocket(socket: WebSocket): string[] {
  return Array.from(socketTopics.get(socket) ?? []);
}
