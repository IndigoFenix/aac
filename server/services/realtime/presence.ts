// Cross-instance person presence.
//
// `room-registry` knows who is connected to THIS instance (the local
// personSockets map). When the app runs on more than one instance, "is this
// person online?" must also account for sockets on OTHER instances — the two
// parties to a call (or an AI deciding whether a contact is reachable) may be
// connected anywhere.
//
// This module keeps an aggregated view of remote presence by listening on the
// fanout bus:
//   - Each instance broadcasts a delta when a person's FIRST local socket opens
//     ("online") or LAST local socket closes ("offline").
//   - Each instance periodically re-broadcasts a full "sync" of its local
//     persons. Receivers replace that instance's set wholesale, so a missed
//     delta self-heals within one heartbeat.
//   - Instances whose heartbeat goes stale (crash / network partition) are
//     reaped, so their persons stop counting as online.
//
// Presence is ID-only — no PHI crosses the bus. `isPersonOnlineRemotely` is
// synchronous (reads the in-memory aggregate) so callers like
// `room-registry.isPersonOnline` stay synchronous.

import { getBus } from "./bus-factory";
import { localOnlinePersonIds } from "./room-registry";

const PRESENCE_CHANNEL = "presence";
const HEARTBEAT_MS = 15_000;
// Reap an instance after ~3 missed heartbeats. Until then its last-known
// persons keep counting as online (fail-open: better a brief false-online than
// dropping a live call's peer).
const STALE_MS = 50_000;

type PresenceMsg =
  | { from: string; op: "online"; personId: string }
  | { from: string; op: "offline"; personId: string }
  | { from: string; op: "sync"; personIds: string[] }
  | { from: string; op: "bye" };

interface RemoteInstance {
  lastSeen: number;
  persons: Set<string>;
}

// instanceId → its last-known online persons + freshness stamp.
const remote = new Map<string, RemoteInstance>();

let heartbeatTimer: NodeJS.Timeout | null = null;

function touch(instanceId: string): RemoteInstance {
  let inst = remote.get(instanceId);
  if (!inst) {
    inst = { lastSeen: Date.now(), persons: new Set() };
    remote.set(instanceId, inst);
  } else {
    inst.lastSeen = Date.now();
  }
  return inst;
}

function reapStale(): void {
  const now = Date.now();
  for (const [instanceId, inst] of remote) {
    if (now - inst.lastSeen > STALE_MS) remote.delete(instanceId);
  }
}

/** True if any non-stale OTHER instance reports this person as online. */
export function isPersonOnlineRemotely(personId: string): boolean {
  const now = Date.now();
  for (const inst of remote.values()) {
    if (now - inst.lastSeen > STALE_MS) continue;
    if (inst.persons.has(personId)) return true;
  }
  return false;
}

async function broadcast(msg: PresenceMsg): Promise<void> {
  try {
    await getBus().publish(PRESENCE_CHANNEL, JSON.stringify(msg));
  } catch (err) {
    console.error("[presence] bus publish error:", err);
  }
}

/** A person's first local socket opened on this instance. */
export function announceLocalOnline(personId: string): void {
  void broadcast({ from: getBus().instanceId, op: "online", personId });
}

/** A person's last local socket closed on this instance. */
export function announceLocalOffline(personId: string): void {
  void broadcast({ from: getBus().instanceId, op: "offline", personId });
}

/** Wire the presence handler onto the bus and start the heartbeat. */
export function initPresence(): void {
  const bus = getBus();
  bus.onMessage((channel, raw) => {
    if (channel !== PRESENCE_CHANNEL) return;
    let msg: PresenceMsg;
    try {
      msg = JSON.parse(raw) as PresenceMsg;
    } catch (err) {
      console.error("[presence] parse error:", err);
      return;
    }
    if (msg.from === bus.instanceId) return; // ignore our own echo
    try {
      if (msg.op === "online") {
        touch(msg.from).persons.add(msg.personId);
      } else if (msg.op === "offline") {
        touch(msg.from).persons.delete(msg.personId);
      } else if (msg.op === "sync") {
        const inst = touch(msg.from);
        inst.persons = new Set(msg.personIds);
      } else if (msg.op === "bye") {
        remote.delete(msg.from);
      }
    } catch (err) {
      console.error("[presence] dispatch error:", err);
    }
  });

  // Heartbeat: re-broadcast our full local set so peers self-heal missed
  // deltas, and reap instances that have gone silent. (On the Lambda path
  // setInterval is frozen between invocations and the bus is in-memory — this
  // is a no-op there, consistent with the rest of the fanout system.)
  if (!heartbeatTimer) {
    heartbeatTimer = setInterval(() => {
      reapStale();
      void broadcast({ from: bus.instanceId, op: "sync", personIds: localOnlinePersonIds() });
    }, HEARTBEAT_MS);
    if (typeof heartbeatTimer.unref === "function") heartbeatTimer.unref();
  }
}

/** Best-effort graceful departure on shutdown. */
export async function shutdownPresence(): Promise<void> {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  await broadcast({ from: getBus().instanceId, op: "bye" });
  remote.clear();
}
