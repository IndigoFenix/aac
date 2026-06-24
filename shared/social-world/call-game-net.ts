// shared/social-world/call-game-net.ts
//
// Glue between the CallClient's "world" data channel and the SocialWorldCanvas
// net adapter. When a call has a game attached, world state rides the mesh's
// unreliable "world" channel: the canvas pushes outbound messages via
// CallClient.sendWorldData, and inbound peer messages arrive as the CallClient's
// `worldData` events. This hub lets the React context fan those events out to
// the (possibly later-mounted) canvas without the canvas knowing about the call.

import type { WorldNetMessage } from "../world-engine/index.js";
import type { SocialWorldNet } from "./SocialWorldCanvas";
import type { WorldPresence, WorldPresenceChannel } from "./world-presence.js";

type WorldHandler = (fromPersonId: string, msgs: WorldNetMessage[]) => void;

/** A minimal fan-out for inbound world messages. One per CallClient/context. */
export class CallWorldHub {
  private handlers = new Set<WorldHandler>();

  /** Feed an inbound CallClient `worldData` event in. `message` is the array the
   *  sender passed to net.send (typed unknown on the wire). */
  emit(fromPersonId: string, message: unknown): void {
    if (!Array.isArray(message)) return;
    const msgs = message as WorldNetMessage[];
    for (const h of this.handlers) h(fromPersonId, msgs);
  }

  subscribe(handler: WorldHandler): () => void {
    this.handlers.add(handler);
    return () => { this.handlers.delete(handler); };
  }

  clear(): void {
    this.handlers.clear();
  }
}

type NpcHandler = (fromPersonId: string, msg: unknown) => void;

/** Fan-out for inbound NPC-conversation messages (the reliable `call:npc` relay).
 *  Mirrors CallWorldHub: the call context feeds `npcData` events in, the mounted
 *  game surface subscribes to route them to the conversation layer. */
export class CallNpcHub {
  private handlers = new Set<NpcHandler>();

  emit(fromPersonId: string, msg: unknown): void {
    for (const h of this.handlers) h(fromPersonId, msg);
  }

  subscribe(handler: NpcHandler): () => void {
    this.handlers.add(handler);
    return () => { this.handlers.delete(handler); };
  }

  clear(): void {
    this.handlers.clear();
  }
}

/** Build the canvas net adapter from the call primitives. When `publishPresence`
 *  + `presence` are supplied, avatar positions ride the world-wide RELAY (the
 *  call WS) instead of the mesh, and the canvas applies remote avatars from the
 *  relay channel; otherwise the canvas falls back to streaming avatars over the
 *  mesh "world" channel (single-player / pre-Phase-1 behavior). */
export function buildSocialWorldNet(opts: {
  localId: string;
  send: (msgs: WorldNetMessage[]) => void;
  hub: CallWorldHub;
  publishPresence?: (p: WorldPresence) => void;
  presence?: WorldPresenceChannel;
}): SocialWorldNet {
  const net: SocialWorldNet = {
    localId: opts.localId,
    send: opts.send,
    subscribe: (handler) => opts.hub.subscribe(handler),
  };
  if (opts.publishPresence && opts.presence) {
    const channel = opts.presence;
    net.publishPresence = opts.publishPresence;
    net.subscribePresence = (handler) => channel.subscribePresence(handler);
    net.subscribePresenceLeave = (handler) => channel.subscribeLeave(handler);
  }
  return net;
}
