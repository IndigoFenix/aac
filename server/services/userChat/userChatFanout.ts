// Cross-instance fanout for user-chat realtime events.
//
// The bus carries only identifiers (roomId, messageId, userId) — never message
// bodies. Each instance rehydrates from Postgres before pushing to its own
// locally-connected WebSockets. This keeps PHI off the bus regardless of
// whether we are running with PostgresBus or RedisBus underneath.
//
// Flow for a new message:
//   userChatService.sendMessage
//     → broadcastMessage(roomId, messageId, clientId)
//         → local publish (fetch msg, build payload, hit local sockets)
//         → bus.publish("message:<roomId>", {messageId, clientId, from: instanceId})
//   other instance
//     → bus onMessage
//         → fetch msg by id, build payload, hit local sockets
//
// Subscribing a user's open sockets to a new room is also fanned out over the
// bus (no payload — just userId + topic).

import { publish, subscribeUserToTopic } from "../realtime/room-registry";
import { getBus } from "../realtime/bus-factory";
import { userChatRepository } from "../../repositories/userChatRepository";
import { ROOM_TOPIC, USER_TOPIC } from "./userChatService";
import type { UserChatEvent } from "@shared/realtime-events";

// Internal bus-message shapes. Kept separate from UserChatEvent because they
// never contain bodies.
type BusMessage =
  | { kind: "message"; from: string; roomId: string; messageId: string; clientId?: string }
  | { kind: "unread"; from: string; userId: string; roomId: string; unreadCount: number }
  | { kind: "roomCreated"; from: string; userId: string; roomId: string }
  | { kind: "subscribeUser"; from: string; userId: string; topic: string };

const BUS_CHANNEL = "userChat";

export function initUserChatFanout(): void {
  const bus = getBus();
  bus.onMessage((channel, raw) => {
    if (channel !== BUS_CHANNEL) return;
    let msg: BusMessage;
    try {
      msg = JSON.parse(raw) as BusMessage;
    } catch (err) {
      console.error("[userChatFanout] parse error:", err);
      return;
    }
    // Ignore our own echo.
    if (msg.from === bus.instanceId) return;
    dispatchLocal(msg).catch((err) => console.error("[userChatFanout] dispatch error:", err));
  });
}

async function dispatchLocal(msg: BusMessage): Promise<void> {
  if (msg.kind === "message") {
    await deliverMessage(msg.roomId, msg.messageId, msg.clientId);
  } else if (msg.kind === "unread") {
    publish(USER_TOPIC(msg.userId), {
      type: "userChat:unread",
      topic: USER_TOPIC(msg.userId),
      payload: { roomId: msg.roomId, unreadCount: msg.unreadCount },
    });
  } else if (msg.kind === "roomCreated") {
    publish(USER_TOPIC(msg.userId), {
      type: "userChat:roomCreated",
      topic: USER_TOPIC(msg.userId),
      payload: { roomId: msg.roomId },
    });
  } else if (msg.kind === "subscribeUser") {
    subscribeUserToTopic(msg.userId, msg.topic);
  }
}

async function deliverMessage(roomId: string, messageId: string, clientId?: string): Promise<void> {
  const row = await userChatRepository.getMessageById(messageId);
  if (!row) return;
  const event: UserChatEvent = {
    type: "userChat:message",
    topic: ROOM_TOPIC(roomId),
    payload: {
      id: row.id,
      roomId: row.roomId,
      senderId: row.senderId,
      body: row.body,
      createdAt: row.createdAt.toISOString(),
      clientId,
    },
  };
  publish(ROOM_TOPIC(roomId), event);
}

// ---------- Broadcast helpers used by userChatService ----------

export async function broadcastMessage(
  roomId: string,
  messageId: string,
  clientId: string | undefined,
): Promise<void> {
  // Deliver locally right away so senders on this instance see zero extra
  // latency; rehydrating would be a wasted DB round-trip.
  await deliverMessage(roomId, messageId, clientId);
  await publishBus({
    kind: "message",
    from: getBus().instanceId,
    roomId,
    messageId,
    clientId,
  });
}

export async function broadcastUnread(
  userId: string,
  roomId: string,
  unreadCount: number,
): Promise<void> {
  publish(USER_TOPIC(userId), {
    type: "userChat:unread",
    topic: USER_TOPIC(userId),
    payload: { roomId, unreadCount },
  });
  await publishBus({ kind: "unread", from: getBus().instanceId, userId, roomId, unreadCount });
}

export async function broadcastRoomCreated(userId: string, roomId: string): Promise<void> {
  publish(USER_TOPIC(userId), {
    type: "userChat:roomCreated",
    topic: USER_TOPIC(userId),
    payload: { roomId },
  });
  await publishBus({ kind: "roomCreated", from: getBus().instanceId, userId, roomId });
}

export async function broadcastSubscribeUser(userId: string, topic: string): Promise<void> {
  subscribeUserToTopic(userId, topic);
  await publishBus({ kind: "subscribeUser", from: getBus().instanceId, userId, topic });
}

async function publishBus(msg: BusMessage): Promise<void> {
  try {
    await getBus().publish(BUS_CHANNEL, JSON.stringify(msg));
  } catch (err) {
    console.error("[userChatFanout] bus publish error:", err);
  }
}
