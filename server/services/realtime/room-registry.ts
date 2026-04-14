import type { WebSocket } from "ws";
import type { RealtimeEventEnvelope } from "@shared/realtime-events";

// In-memory pub/sub. Single-process for now; when we scale horizontally this
// will need a Redis fanout behind the same interface.

type Subscribers = Map<WebSocket, Set<string>>; // socket → topics it subscribed to
const socketTopics: Subscribers = new Map();
const topicSockets: Map<string, Set<WebSocket>> = new Map();

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
