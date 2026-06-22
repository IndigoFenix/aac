// Cross-instance fanout for person-chat realtime events.
//
// The bus carries only identifiers (roomId, messageId, personId) — never message
// bodies. Each instance rehydrates from Postgres before pushing to its own
// locally-connected WebSockets. This keeps PHI off the bus regardless of
// whether we are running with PostgresBus or RedisBus underneath.
//
// Flow for a new message:
//   personChatService.sendMessage
//     → broadcastMessage(roomId, messageId, clientId)
//         → local publish (fetch msg, build payload, hit local sockets)
//         → bus.publish("personChat", {messageId, clientId, from: instanceId})
//   other instance
//     → bus onMessage
//         → fetch msg by id, build payload, hit local sockets
//
// Subscribing a person's open sockets to a new room is also fanned out over the
// bus (no payload — just personId + topic).

import { publish, subscribePersonToTopic } from "../realtime/room-registry";
import { getBus } from "../realtime/bus-factory";
import { personChatRepository } from "../../repositories/personChatRepository";
import { ROOM_TOPIC, PERSON_TOPIC } from "./personChatService";
import type { PersonChatEvent } from "@shared/realtime-events";

// Internal bus-message shapes. Kept separate from PersonChatEvent because they
// never contain bodies.
type BusMessage =
  | { kind: "message"; from: string; roomId: string; messageId: string; clientId?: string }
  | { kind: "unread"; from: string; personId: string; roomId: string; unreadCount: number }
  | { kind: "roomCreated"; from: string; personId: string; roomId: string }
  | { kind: "subscribePerson"; from: string; personId: string; topic: string };

const BUS_CHANNEL = "personChat";

export function initPersonChatFanout(): void {
  const bus = getBus();
  bus.onMessage((channel, raw) => {
    if (channel !== BUS_CHANNEL) return;
    let msg: BusMessage;
    try {
      msg = JSON.parse(raw) as BusMessage;
    } catch (err) {
      console.error("[personChatFanout] parse error:", err);
      return;
    }
    // Ignore our own echo.
    if (msg.from === bus.instanceId) return;
    dispatchLocal(msg).catch((err) => console.error("[personChatFanout] dispatch error:", err));
  });
}

async function dispatchLocal(msg: BusMessage): Promise<void> {
  if (msg.kind === "message") {
    await deliverMessage(msg.roomId, msg.messageId, msg.clientId);
  } else if (msg.kind === "unread") {
    publish(PERSON_TOPIC(msg.personId), {
      type: "personChat:unread",
      topic: PERSON_TOPIC(msg.personId),
      payload: { roomId: msg.roomId, unreadCount: msg.unreadCount },
    });
  } else if (msg.kind === "roomCreated") {
    publish(PERSON_TOPIC(msg.personId), {
      type: "personChat:roomCreated",
      topic: PERSON_TOPIC(msg.personId),
      payload: { roomId: msg.roomId },
    });
  } else if (msg.kind === "subscribePerson") {
    subscribePersonToTopic(msg.personId, msg.topic);
  }
}

async function deliverMessage(roomId: string, messageId: string, clientId?: string): Promise<void> {
  const row = await personChatRepository.getMessageById(messageId);
  if (!row) return;
  const event: PersonChatEvent = {
    type: "personChat:message",
    topic: ROOM_TOPIC(roomId),
    payload: {
      id: row.id,
      roomId: row.roomId,
      senderPersonId: row.senderPersonId,
      body: row.body,
      createdAt: row.createdAt.toISOString(),
      clientId,
    },
  };
  publish(ROOM_TOPIC(roomId), event);
}

// ---------- Broadcast helpers used by personChatService ----------

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
  personId: string,
  roomId: string,
  unreadCount: number,
): Promise<void> {
  publish(PERSON_TOPIC(personId), {
    type: "personChat:unread",
    topic: PERSON_TOPIC(personId),
    payload: { roomId, unreadCount },
  });
  await publishBus({ kind: "unread", from: getBus().instanceId, personId, roomId, unreadCount });
}

export async function broadcastRoomCreated(personId: string, roomId: string): Promise<void> {
  publish(PERSON_TOPIC(personId), {
    type: "personChat:roomCreated",
    topic: PERSON_TOPIC(personId),
    payload: { roomId },
  });
  await publishBus({ kind: "roomCreated", from: getBus().instanceId, personId, roomId });
}

export async function broadcastSubscribePerson(personId: string, topic: string): Promise<void> {
  subscribePersonToTopic(personId, topic);
  await publishBus({ kind: "subscribePerson", from: getBus().instanceId, personId, topic });
}

async function publishBus(msg: BusMessage): Promise<void> {
  try {
    await getBus().publish(BUS_CHANNEL, JSON.stringify(msg));
  } catch (err) {
    console.error("[personChatFanout] bus publish error:", err);
  }
}
