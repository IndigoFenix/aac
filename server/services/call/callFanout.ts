// Cross-instance fanout for live-call signaling + lifecycle events.
//
// Unlike person-chat (which keeps message bodies off the bus and rehydrates
// from Postgres), call signaling payloads (SDP/ICE, ring metadata) are ephemeral
// and not PHI, so the full event crosses the bus and is re-published locally on
// each instance. The two peers in a call may be connected to different server
// instances, so every ring / signal / lifecycle event must fan out.

import { publish, subscribePersonToTopic } from "../realtime/room-registry";
import { getBus } from "../realtime/bus-factory";
import { CALL_PERSON_TOPIC, CALL_TOPIC } from "./callService";
import type { CallEvent } from "@shared/realtime-events";

type BusMessage =
  | { from: string; op: "person"; personId: string; event: CallEvent }
  | { from: string; op: "call"; callId: string; event: CallEvent }
  | { from: string; op: "subscribe"; personId: string; callId: string };

const BUS_CHANNEL = "call";

export function initCallFanout(): void {
  const bus = getBus();
  bus.onMessage((channel, raw) => {
    if (channel !== BUS_CHANNEL) return;
    let msg: BusMessage;
    try {
      msg = JSON.parse(raw) as BusMessage;
    } catch (err) {
      console.error("[callFanout] parse error:", err);
      return;
    }
    if (msg.from === bus.instanceId) return; // ignore own echo
    try {
      if (msg.op === "person") {
        publish(CALL_PERSON_TOPIC(msg.personId), msg.event);
      } else if (msg.op === "call") {
        publish(CALL_TOPIC(msg.callId), msg.event);
      } else if (msg.op === "subscribe") {
        subscribePersonToTopic(msg.personId, CALL_TOPIC(msg.callId));
      }
    } catch (err) {
      console.error("[callFanout] dispatch error:", err);
    }
  });
}

// ---------- Broadcast helpers used by callService ----------

/** Deliver an event to a person's incoming-call topic (used for ringing). */
export async function broadcastToPerson(personId: string, event: CallEvent): Promise<void> {
  publish(CALL_PERSON_TOPIC(personId), event);
  await publishBus({ from: getBus().instanceId, op: "person", personId, event });
}

/** Deliver an event to everyone subscribed to a call (in-call signaling). */
export async function broadcastToCall(callId: string, event: CallEvent): Promise<void> {
  publish(CALL_TOPIC(callId), event);
  await publishBus({ from: getBus().instanceId, op: "call", callId, event });
}

/** Subscribe a person's open sockets (on every instance) to a call's topic. */
export async function broadcastSubscribeToCall(personId: string, callId: string): Promise<void> {
  subscribePersonToTopic(personId, CALL_TOPIC(callId));
  await publishBus({ from: getBus().instanceId, op: "subscribe", personId, callId });
}

async function publishBus(msg: BusMessage): Promise<void> {
  try {
    await getBus().publish(BUS_CHANNEL, JSON.stringify(msg));
  } catch (err) {
    console.error("[callFanout] bus publish error:", err);
  }
}
