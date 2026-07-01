// shared/social-world/useNpcConversations.ts
//
// The MIND layer for world NPCs, multiplayer-aware. Each NPC has ONE brain (a
// social-trainer DirectedSession over `/ws/social-bot`) hosted by exactly one peer
// — the OWNER (lowest participant id; the same peer that hosts the NPC bodies).
//
//   • OWNER: opens a WS per NPC, feeds it every nearby player's utterance (its own
//     directly, others' over the reliable `call:npc` relay), and broadcasts the
//     NPC's state + text + TTS audio back to everyone. One mind, one shared mood —
//     a group conversation where the NPC perceives the whole group (lines are
//     attributed by speaker name).
//   • NON-OWNER: opens no WS. It renders each NPC from the owner's broadcast state,
//     plays the broadcast audio for the NPC it's standing next to, and sends its
//     own player's utterances to the owner over the relay.
//   • SOLO (no transport): the local peer is the owner with nobody to broadcast to.
//
// Only the NPC the local player is standing next to (`activeId`) is voiced; its
// transcript + reacting face show in the dock. Engagement (mode/rapport → pull) is
// handed back to the world host to bias the NPC's body.

import { useEffect, useMemo, useRef, useState } from "react";
import { NEUTRAL_FACE, type FaceAppearance, type FaceTarget } from "../social-bot/ProceduralFace";
import type { NpcSpec } from "../world-engine/index.js";
import type { NpcEngagement } from "../world-engine/npc-controller.js";
import { NpcVoicePlayer } from "./npc-voice-player.js";
import { electNpcOwner, initParams, modeToPull, type ConvMode } from "./npc-conversation-logic.js";

// Re-export the pure kernels so existing importers keep working.
export { electNpcOwner, modeToPull, type ConvMode };

/** One line in an NPC's rolling conversation transcript. */
export interface TranscriptLine {
  /** Display name of the speaker (a player's name, or the NPC's name). */
  who: string;
  text: string;
  /** True when the NPC is the speaker (styled differently in the dock). */
  isNpc: boolean;
}

/** The per-NPC view-state the dock renders. */
export interface NpcConvState {
  npcId: string;
  phase: "connecting" | "ready" | "error";
  name: string;
  appearance: FaceAppearance | null;
  expressiveness: number;
  legibility: number;
  target: FaceTarget;
  mode: ConvMode;
  rapport: number;
  /** Rolling transcript (most recent last), capped. */
  transcript: TranscriptLine[];
  /** True between a message being sent and the NPC's reply landing. */
  awaitingReply: boolean;
  /** 0..1 mouth amplitude (only non-zero for the active, voiced NPC). */
  speakingLevel: number;
}

/** Messages on the reliable `call:npc` relay. `pos` (NPC body positions) is handled
 *  by CallGameSurface, not this hook; the rest are conversation. */
export type NpcNetMessage =
  | { k: "say"; npcId: string; fromName: string; text: string }
  | {
      k: "state";
      npcId: string;
      name: string;
      appearance: FaceAppearance | null;
      expressiveness: number;
      legibility: number;
      target: FaceTarget;
      mode: ConvMode;
      rapport: number;
      text?: string;
    }
  | { k: "audio"; npcId: string; chunk: string; format: "wav" | "mp3" }
  | { k: "pos"; avatars: unknown[] };

const TRANSCRIPT_CAP = 8;

function freshState(spec: NpcSpec): NpcConvState {
  return {
    npcId: spec.id,
    phase: "connecting",
    name: spec.name ?? "",
    appearance: null,
    expressiveness: 0.85,
    legibility: 1,
    target: { ...NEUTRAL_FACE },
    mode: "NEUTRAL",
    rapport: 0,
    transcript: [],
    awaitingReply: false,
    speakingLevel: 0,
  };
}

interface OwnerHandlers {
  onInit: (npcId: string, meta: { name: string; appearance: FaceAppearance | null; expressiveness: number; legibility: number }) => void;
  onState: (npcId: string, target: FaceTarget, mode: ConvMode, rapport: number) => void;
  onText: (npcId: string, text: string) => void;
  onAudio: (npcId: string, base64: string, format: "wav" | "mp3") => void;
  onError: (npcId: string) => void;
}

/** One NPC's brain WS (OWNER only). Emits semantic events; the hook owns view-state. */
class NpcBrainSession {
  private ws: WebSocket | null = null;
  private disposed = false;
  ready = false;

  constructor(
    private readonly spec: NpcSpec,
    private readonly wsUrl: string,
    private readonly language: string,
    private readonly h: OwnerHandlers,
  ) {
    try {
      const ws = new WebSocket(wsUrl);
      this.ws = ws;
      ws.onopen = () => ws.send(JSON.stringify({ type: "initialize", params: initParams(spec, language) }));
      ws.onmessage = (ev) => this.onMessage(ev);
      ws.onerror = () => h.onError(spec.id);
      ws.onclose = () => { if (!this.disposed && !this.ready) h.onError(spec.id); };
    } catch {
      h.onError(spec.id);
    }
  }

  private onMessage(ev: MessageEvent): void {
    let msg: any;
    try { msg = JSON.parse(typeof ev.data === "string" ? ev.data : ""); } catch { return; }
    switch (msg?.type) {
      case "initialized":
        this.ready = true;
        this.h.onInit(this.spec.id, {
          name: msg.characterName || this.spec.name || "",
          appearance: msg.appearance ?? null,
          expressiveness: typeof msg.expressiveness === "number" ? msg.expressiveness : 0.85,
          legibility: typeof msg.legibility === "number" ? msg.legibility : 1,
        });
        break;
      case "bot_state": {
        const d = msg.data ?? {};
        if (d.target) this.h.onState(this.spec.id, d.target, (d.mode as ConvMode) ?? "NEUTRAL", typeof d.rapport === "number" ? d.rapport : 0);
        break;
      }
      case "bot_text":
        if (typeof msg.data === "string") this.h.onText(this.spec.id, msg.data);
        break;
      case "bot_audio":
        if (typeof msg.data === "string") this.h.onAudio(this.spec.id, msg.data, msg.format === "mp3" ? "mp3" : "wav");
        break;
      case "error":
        this.h.onError(this.spec.id);
        break;
    }
  }

  send(text: string): void {
    if (this.disposed || !this.ready || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ type: "text_message", data: text }));
  }

  dispose(): void {
    this.disposed = true;
    try { this.ws?.close(); } catch { /* ignore */ }
    this.ws = null;
  }
}

export interface UseNpcConversationsArgs {
  /** Resolved absolute ws URL for `/ws/social-bot` (OWNER only needs it). */
  wsUrl: string | null;
  npcs: NpcSpec[];
  language: string;
  /** Does THIS peer host the NPC brains? (lowest-id owner; true in solo.) */
  isOwner: boolean;
  /** The local player's display name, for utterance attribution. */
  selfName: string;
  /** Resolve a participant's display name from the local roster (preferred over a
   *  message's self-reported name, so attribution is correct even if spoofed). */
  resolveName?: (personId: string) => string;
  /** Silence NPC voice locally (the window's audio-output mute). */
  muted?: boolean;
  /** Broadcast an NpcNetMessage to the call (undefined in solo → no broadcast). */
  sendNpc?: (msg: NpcNetMessage) => void;
}

export interface UseNpcConversations {
  states: Record<string, NpcConvState>;
  activeId: string | null;
  setActive: (npcId: string | null) => void;
  send: (text: string) => void;
  engagements: Record<string, NpcEngagement>;
  /** Feed an inbound `call:npc` conversation message (say/state/audio). */
  applyInbound: (fromPersonId: string, msg: NpcNetMessage) => void;
}

export function useNpcConversations({ wsUrl, npcs, language, isOwner, selfName, resolveName, muted, sendNpc }: UseNpcConversationsArgs): UseNpcConversations {
  const [states, setStates] = useState<Record<string, NpcConvState>>({});
  const [activeId, setActiveId] = useState<string | null>(null);
  const [engagements, setEngagements] = useState<Record<string, NpcEngagement>>({});

  const sessions = useRef(new Map<string, NpcBrainSession>());
  const voice = useRef<NpcVoicePlayer | null>(null);
  const activeRef = useRef<string | null>(null);
  const specById = useMemo(() => new Map(npcs.map((n) => [n.id, n])), [npcs]);

  // Latest props the long-lived sessions/handlers need, without re-subscribing.
  const ownerRef = useRef(isOwner); ownerRef.current = isOwner;
  const sendNpcRef = useRef(sendNpc); sendNpcRef.current = sendNpc;
  const selfNameRef = useRef(selfName); selfNameRef.current = selfName;
  const resolveNameRef = useRef(resolveName); resolveNameRef.current = resolveName;

  // --- view-state helpers ---------------------------------------------------

  const patch = (npcId: string, fn: (s: NpcConvState) => NpcConvState): void => {
    setStates((prev) => {
      const base = prev[npcId] ?? freshState(specById.get(npcId) ?? ({ id: npcId } as NpcSpec));
      return { ...prev, [npcId]: fn(base) };
    });
  };

  const setEngagementFromMood = (npcId: string, mode: ConvMode, rapport: number): void => {
    setEngagements((prev) => ({ ...prev, [npcId]: { partnerId: null, pull: modeToPull(mode, rapport) } }));
  };

  const appendLine = (s: NpcConvState, line: TranscriptLine): NpcConvState => ({
    ...s,
    transcript: [...s.transcript, line].slice(-TRANSCRIPT_CAP),
  });

  // Broadcast an NPC's current full state (+ optional fresh NPC line) to peers.
  // Reads the latest state via a functional update so it isn't a render dependency.
  const broadcastState = (npcId: string, npcLine?: string): void => {
    if (!sendNpcRef.current) return;
    setStates((prev) => {
      const s = prev[npcId];
      if (s) {
        sendNpcRef.current!({
          k: "state",
          npcId,
          name: s.name,
          appearance: s.appearance,
          expressiveness: s.expressiveness,
          legibility: s.legibility,
          target: s.target,
          mode: s.mode,
          rapport: s.rapport,
          text: npcLine,
        });
      }
      return prev;
    });
  };

  // --- shared voice player (active NPC only) --------------------------------

  const mutedRef = useRef(muted); mutedRef.current = muted;
  useEffect(() => { voice.current?.setMuted(!!muted); }, [muted]);

  useEffect(() => {
    const player = new NpcVoicePlayer();
    player.setMuted(!!mutedRef.current);
    voice.current = player;
    player.onLevel = (lvl) => {
      const id = activeRef.current;
      if (!id) return;
      setStates((prev) => (prev[id] ? { ...prev, [id]: { ...prev[id], speakingLevel: lvl } } : prev));
    };
    return () => {
      player.dispose();
      voice.current = null;
      for (const c of sessions.current.values()) c.dispose();
      sessions.current.clear();
    };
  }, []);

  // --- owner brain handlers -------------------------------------------------

  const ownerHandlers: OwnerHandlers = useMemo(() => ({
    onInit: (npcId, meta) => {
      patch(npcId, (s) => ({ ...s, phase: "ready", name: meta.name || s.name, appearance: meta.appearance, expressiveness: meta.expressiveness, legibility: meta.legibility }));
      broadcastState(npcId);
    },
    onState: (npcId, target, mode, rapport) => {
      patch(npcId, (s) => ({ ...s, target, mode, rapport }));
      setEngagementFromMood(npcId, mode, rapport);
      broadcastState(npcId, undefined);
    },
    onText: (npcId, text) => {
      patch(npcId, (s) => appendLine({ ...s, awaitingReply: false }, { who: s.name || "NPC", text, isNpc: true }));
      broadcastState(npcId, text);
    },
    onAudio: (npcId, base64, format) => {
      if (activeRef.current === npcId) voice.current?.enqueue(base64, format);
      sendNpcRef.current?.({ k: "audio", npcId, chunk: base64, format });
    },
    onError: (npcId) => patch(npcId, (s) => ({ ...s, phase: "error", awaitingReply: false })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), []);

  const ensureSession = (npcId: string): NpcBrainSession | null => {
    if (!ownerRef.current || !wsUrl) return null;
    let c = sessions.current.get(npcId);
    if (!c) {
      const spec = specById.get(npcId);
      if (!spec) return null;
      patch(npcId, (s) => ({ ...s, phase: "connecting" }));
      c = new NpcBrainSession(spec, wsUrl, language, ownerHandlers);
      sessions.current.set(npcId, c);
    }
    return c;
  };

  // --- public API -----------------------------------------------------------

  const setActive = (npcId: string | null): void => {
    if (npcId === activeRef.current) return;
    voice.current?.stop();
    activeRef.current = npcId;
    setActiveId(npcId);
    if (npcId && ownerRef.current) ensureSession(npcId); // owner warms the brain
  };

  /** Feed an utterance to an NPC's brain (owner only), attributing the speaker in
   *  multiplayer so the NPC can perceive who's talking. */
  const feedBrain = (npcId: string, speakerName: string, text: string): void => {
    const c = ensureSession(npcId);
    if (!c) return;
    const attributed = sendNpcRef.current ? `${speakerName}: ${text}` : text;
    patch(npcId, (s) => ({ ...s, awaitingReply: true }));
    c.send(attributed);
  };

  const send = (text: string): void => {
    const id = activeRef.current;
    const t = text.trim();
    if (!id || !t) return;
    const name = selfNameRef.current || "You";
    // Show my own line immediately.
    patch(id, (s) => appendLine(s, { who: name, text: t, isNpc: false }));
    if (ownerRef.current) feedBrain(id, name, t);
    sendNpcRef.current?.({ k: "say", npcId: id, fromName: name, text: t });
  };

  const applyInbound = (fromPersonId: string, msg: NpcNetMessage): void => {
    switch (msg.k) {
      case "say": {
        // A remote player's utterance. Prefer the local roster's name for the
        // sender over the message's self-reported one. Show it; if we're the
        // owner, feed the brain.
        const who = resolveNameRef.current?.(fromPersonId) || msg.fromName || "Someone";
        patch(msg.npcId, (s) => appendLine(s, { who, text: msg.text, isNpc: false }));
        if (ownerRef.current) feedBrain(msg.npcId, who, msg.text);
        break;
      }
      case "state":
        patch(msg.npcId, (s) => {
          let next: NpcConvState = {
            ...s,
            phase: "ready",
            name: msg.name || s.name,
            appearance: msg.appearance ?? s.appearance,
            expressiveness: msg.expressiveness,
            legibility: msg.legibility,
            target: msg.target,
            mode: msg.mode,
            rapport: msg.rapport,
            awaitingReply: false,
          };
          if (msg.text) next = appendLine(next, { who: msg.name || "NPC", text: msg.text, isNpc: true });
          return next;
        });
        setEngagementFromMood(msg.npcId, msg.mode, msg.rapport);
        break;
      case "audio":
        if (activeRef.current === msg.npcId) voice.current?.enqueue(msg.chunk, msg.format);
        break;
      case "pos":
        // Handled by CallGameSurface (injected into the world hub), not here.
        break;
    }
  };

  // Stop owning brains we no longer should (e.g. lost owner election).
  useEffect(() => {
    if (!isOwner) {
      for (const c of sessions.current.values()) c.dispose();
      sessions.current.clear();
    } else if (activeRef.current) {
      ensureSession(activeRef.current);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOwner]);

  return { states, activeId, setActive, send, engagements, applyInbound };
}
