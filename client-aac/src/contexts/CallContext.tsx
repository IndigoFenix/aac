// client-aac/src/contexts/CallContext.tsx
// AAC-client wrapper around the shared CallClient (WebRTC video calls).
//
// Mirrors the clinician CallContext (client/src/features/call/CallContext.tsx)
// but adapted for the AAC client:
//   - acts as the fronted STUDENT (actAsStudentId = current studentId), so the
//     CallClient auto-sends `call:act-as` on the /ws/call socket open.
//   - dials via startCallToContact(contactId) (server resolves the room) rather
//     than creating a room first.
//   - resolves callers/contacts via /api/call/callable-contacts/:studentId so
//     the incoming popup + phone app can show a name (+ online flag).
//   - consumes the AI-initiated `call_directive` surfaced by the live session
//     (DualAgentContext) and dials automatically.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  CallClient,
  type CallClientEvent,
  type CallState,
  type IncomingCall,
} from "@shared/call/call-client";
import type { CallGame, CallMediaFlags } from "@shared/realtime-events";
import type { WorldNetMessage } from "@shared/world-engine/index";
import { CallWorldHub, CallNpcHub } from "@shared/social-world/call-game-net";
import { WorldPresenceChannel, type WorldPresence } from "@shared/social-world/world-presence";
import { proximityRule, solveAudibleFor, audibleRecvIds } from "@shared/social-world/circle-solver";
import { audibleGains } from "@shared/social-world/media-gate";
import { DEFAULT_SOCIAL_GAME } from "@shared/social-world/default-game";
import { API_BASE_URL } from "@/lib/api-base";
import { apiGet } from "@/lib/queryClient";
import { useDualAgentContextOptional } from "@/contexts/DualAgentContext";

/** A contact the student can call, from /api/call/callable-contacts/:studentId. */
export interface CallableContact {
  contactId: string;
  personId: string;
  name: string;
  relationship?: string | null;
  online: boolean;
}

/** Resolved details of the currently active/outgoing/incoming call's other party. */
export interface ActiveContactInfo {
  name: string | null;
  contactId: string | null;
  personId: string | null;
}

const DEFAULT_MEDIA: CallMediaFlags = { audio: true, video: true, pose: false };

/** How often the proximity media gate re-evaluates (ms). ~1s re-form is fine. */
const MEDIA_GATE_INTERVAL_MS = 700;

/** Cheap equality so the gate only triggers a re-render when gains actually change. */
function sameGains(a: Map<string, number>, b: Map<string, number>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}

/** Build the ws(s):// URL for a server path, mirroring useLiveSession's logic. */
function resolveCallWsUrl(): string {
  const apiBase = API_BASE_URL;
  if (apiBase) {
    // "http(s)://host" → "ws(s)://host/ws/call"
    return apiBase.replace(/^http/, "ws") + "/ws/call";
  }
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/ws/call`;
}

async function fetchIceServers(): Promise<RTCIceServer[]> {
  try {
    const res = await apiGet<{ success: boolean; iceServers: RTCIceServer[] }>(
      "/api/call/ice-servers",
    );
    return res.iceServers ?? [{ urls: "stun:stun.l.google.com:19302" }];
  } catch {
    return [{ urls: "stun:stun.l.google.com:19302" }];
  }
}

interface CallContextValue {
  callState: CallState;
  /** True whenever a call is in any non-idle state (ringing / connecting / active). */
  active: boolean;
  incoming: IncomingCall | null;
  selfPersonId: string | null;
  localStream: MediaStream | null;
  remoteStreams: Map<string, MediaStream>;
  /** Resolved details of the other party (name resolved from contacts). */
  activeContact: ActiveContactInfo | null;
  error: { code: string; message: string } | null;
  audioEnabled: boolean;
  videoEnabled: boolean;
  /** Callable contacts for this student (photo-less; name + online flag). */
  contacts: CallableContact[];
  contactsLoading: boolean;
  refreshContacts: () => void;

  startCallToContact: (contactId: string) => Promise<void>;
  accept: () => Promise<void>;
  decline: () => void;
  cancel: () => void;
  hangUp: () => void;
  toggleAudio: () => void;
  toggleVideo: () => void;

  /** Social game attached to the active call (null = plain video chat). */
  game: CallGame | null;
  /** The game the student is currently in — the call's game, or a solo (callless)
   *  game they started by themselves. Drives the game-mode layout + surface. */
  activeGame: CallGame | null;
  /** Start a game BY MYSELF — a joinable one-person room (others can be invited). */
  startSoloGame: (game?: CallGame) => void;
  /** Ring a contact INTO the current game/call (grow a solo game). */
  inviteIntoCall: (contactId: string) => void;
  /** End the active game (leaves the call — for a solo game that ends the room). */
  endGame: () => void;
  /** Call a contact AND attach a game once connected (the "Play with friends" flow). */
  startGameWithContact: (contactId: string, game?: CallGame) => Promise<void>;
  /** Attach a game to the call already in progress. */
  startGame: (game?: CallGame) => void;
  /** Detach the game (back to plain video chat). */
  stopGame: () => void;
  /** Broadcast world state over the call's unreliable "world" channel. */
  sendWorld: (msgs: WorldNetMessage[]) => void;
  /** Fan-out of inbound peer world messages (fed by the CallClient). */
  worldHub: CallWorldHub;
  /** Broadcast an NPC-conversation message over the reliable `call:npc` relay. */
  sendNpc: (msg: unknown) => void;
  /** Fan-out of inbound NPC-conversation messages (fed by the CallClient). */
  npcHub: CallNpcHub;
  /** Phase 1 position relay: publish the local avatar's position world-wide. */
  publishPresence: (p: WorldPresence) => void;
  /** Phase 1 position relay: inbound positions of everyone in the world. */
  presenceChannel: WorldPresenceChannel;
  /** Circle solver: who the local student can currently hear (proximity rule).
   *  Computed on demand. */
  getAudibleIds: () => Set<string>;
  /** Per-peer audio gain 0..1 from the proximity media gate (Phase 2). Peers out
   *  of range are disconnected entirely (absent here); connected peers in the
   *  hysteresis band fade. Tiles apply it as element volume. */
  peerGains: Map<string, number>;
}

const CallContext = createContext<CallContextValue | null>(null);

export function CallProvider({ children }: { children: ReactNode }) {
  // studentId comes from the live-session context (the fronted student). The
  // CallClient only connects once it's known.
  const dual = useDualAgentContextOptional();
  const studentId = dual?.studentId ?? null;
  // Stable ref so the once-constructed CallClient can pull the latest synthesized-
  // voice stream when it acquires local media for a call.
  const dualRef = useRef(dual);
  dualRef.current = dual;

  const clientRef = useRef<CallClient | null>(null);

  const [callState, setCallState] = useState<CallState>("idle");
  const [incoming, setIncoming] = useState<IncomingCall | null>(null);
  const [selfPersonId, setSelfPersonId] = useState<string | null>(null);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStreams, setRemoteStreams] = useState<Map<string, MediaStream>>(new Map());
  const [activeContact, setActiveContact] = useState<ActiveContactInfo | null>(null);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const [audioEnabled, setAudioEnabled] = useState(true);
  const [videoEnabled, setVideoEnabled] = useState(true);
  const [game, setGameState] = useState<CallGame | null>(null);
  const [peerGains, setPeerGains] = useState<Map<string, number>>(new Map());
  // Inbound world-message fan-out for the mounted CallGameSurface.
  const worldHubRef = useRef(new CallWorldHub());
  const npcHubRef = useRef(new CallNpcHub());
  // Phase 1 position relay: world-wide avatar positions, fed by `presence` events.
  const presenceChannelRef = useRef(new WorldPresenceChannel());
  // Mirror remoteStreams in a ref so the proximity A/V gate reads it without
  // restarting its interval on every connect.
  const remoteStreamsRef = useRef(remoteStreams);
  remoteStreamsRef.current = remoteStreams;
  // A game queued by "Play with friends": applied by the INITIATOR once the call
  // goes active (callees receive it via the server's call:game catch-up).
  const pendingGameRef = useRef<CallGame | null>(null);

  const [contacts, setContacts] = useState<CallableContact[]>([]);
  const [contactsLoading, setContactsLoading] = useState(false);
  // Kept in a ref so event handlers can resolve a caller without re-subscribing.
  const contactsRef = useRef<CallableContact[]>([]);
  contactsRef.current = contacts;

  // Outcome tracking for AI feedback: did the call ever connect, and what ended
  // it? Read by the inCall effect to tell the server why a call finished.
  const everConnectedRef = useRef(false);
  const lastEndReasonRef = useRef<string | null>(null);

  const clearStreams = useCallback(() => {
    setLocalStream(null);
    setRemoteStreams(new Map());
    setGameState(null);
    setPeerGains(new Map());
    pendingGameRef.current = null;
    worldHubRef.current.clear();
    npcHubRef.current.clear();
    presenceChannelRef.current.clear();
  }, []);


  // Resolve a personId to a known contact (incoming caller identity).
  const resolveContactByPerson = useCallback((personId: string): CallableContact | null => {
    return contactsRef.current.find((c) => c.personId === personId) ?? null;
  }, []);

  const handleEvent = useCallback((event: CallClientEvent) => {
    switch (event.type) {
      case "ready":
        setSelfPersonId(event.selfPersonId);
        break;
      case "incoming": {
        setIncoming(event.call);
        const match = resolveContactByPerson(event.call.fromPersonId);
        setActiveContact({
          name: match?.name ?? event.call.fromName ?? null,
          contactId: match?.contactId ?? null,
          personId: event.call.fromPersonId,
        });
        setError(null);
        break;
      }
      case "state":
        setCallState(event.state);
        if (event.state === "active") {
          everConnectedRef.current = true;
          // We're the initiator of a "Play with friends" call — attach the queued
          // game now that signaling is up (callees get it via call:game catch-up).
          if (pendingGameRef.current) {
            clientRef.current?.setGame(pendingGameRef.current);
            pendingGameRef.current = null;
          }
        }
        if (event.state === "ringing-out" || event.state === "ringing-in") {
          // Fresh call attempt — reset outcome trackers.
          everConnectedRef.current = false;
          lastEndReasonRef.current = null;
        }
        if (event.state === "idle" || event.state === "ended") {
          clearStreams();
          setActiveContact(null);
          setAudioEnabled(true);
          setVideoEnabled(true);
        }
        break;
      case "localStream":
        setLocalStream(event.stream);
        break;
      case "remoteStream":
        setRemoteStreams((prev) => {
          const next = new Map(prev);
          next.set(event.personId, event.stream);
          return next;
        });
        break;
      case "peerLeft":
        setRemoteStreams((prev) => {
          const next = new Map(prev);
          next.delete(event.personId);
          return next;
        });
        presenceChannelRef.current.leave(event.personId);
        break;
      case "ended":
        lastEndReasonRef.current = event.reason;
        setIncoming(null);
        clearStreams();
        setActiveContact(null);
        break;
      case "error":
        // "offline" surfaces when the callee has no live socket — treat it as an
        // end reason so the AI is told they were unavailable.
        if (event.code === "offline") lastEndReasonRef.current = "offline";
        setError({ code: event.code, message: event.message });
        break;
      case "game":
        // A participant attached/detached a social game on the call.
        setGameState(event.game);
        break;
      case "worldData":
        // Inbound peer world state → fan out to the mounted game surface, AND
        // feed avatar positions into the circle solver's channel so it works off
        // the (reliable, always-connected) mesh world layer.
        worldHubRef.current.emit(event.personId, event.message);
        if (Array.isArray(event.message)) {
          for (const m of event.message as WorldNetMessage[]) {
            if (m?.t === "avatar") {
              presenceChannelRef.current.receive({ personId: m.id, x: m.x, y: m.y, fx: m.fx, fy: m.fy, vx: m.vx, vy: m.vy });
            }
          }
        }
        break;
      case "presence":
        // Relayed avatar position (redundant with the mesh while everyone is
        // connected; the solver's backup source) → feed the same channel.
        presenceChannelRef.current.receive(event.presence);
        break;
      case "npcData":
        // Inbound NPC-conversation message (reliable relay) → fan out to the game
        // surface's conversation layer.
        npcHubRef.current.emit(event.fromPersonId, event.message);
        break;
      case "mediaState":
      case "data":
        // Remote media-state + data-channel extras unused by the AAC call UI.
        break;
    }
  }, [clearStreams, resolveContactByPerson]);

  // Stable ref so the CallClient (created once) always reaches the latest handler.
  const handleEventRef = useRef(handleEvent);
  handleEventRef.current = handleEvent;

  // -------------------------------------------------------------------------
  // Connection lifecycle — connect once studentId is known.
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (!studentId) return;
    const client = new CallClient({
      wsUrl: resolveCallWsUrl(),
      getIceServers: fetchIceServers,
      emit: (e) => handleEventRef.current(e),
      actAsStudentId: studentId,
      // The AAC student speaks via TTS — feed that synthesized voice into the call
      // as an extra outgoing audio track so the other side actually hears them.
      getAppAudioTrack: () => dualRef.current?.getCallAudioStream?.()?.getAudioTracks()[0] ?? null,
    });
    clientRef.current = client;
    client.connect();
    return () => {
      client.disconnect();
      clientRef.current = null;
    };
  }, [studentId]);

  // -------------------------------------------------------------------------
  // Callable contacts — fetched once per student (and on demand). Used by the
  // Phone-call app and to resolve incoming callers' identities.
  // -------------------------------------------------------------------------
  const refreshContacts = useCallback(() => {
    if (!studentId) return;
    setContactsLoading(true);
    apiGet<{ success: boolean; contacts: CallableContact[] }>(
      `/api/call/callable-contacts/${studentId}`,
    )
      .then((res) => setContacts(res.contacts ?? []))
      .catch((err) => console.warn("[CallContext] Failed to load callable contacts:", err))
      .finally(() => setContactsLoading(false));
  }, [studentId]);

  useEffect(() => {
    if (studentId) refreshContacts();
    else setContacts([]);
  }, [studentId, refreshContacts]);

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------
  const startCallToContact = useCallback(async (contactId: string) => {
    const client = clientRef.current;
    if (!client) return;
    setError(null);
    setAudioEnabled(true);
    setVideoEnabled(true);
    const match = contactsRef.current.find((c) => c.contactId === contactId) ?? null;
    setActiveContact({
      name: match?.name ?? null,
      contactId,
      personId: match?.personId ?? null,
    });
    try {
      await client.startCallToContact(contactId, DEFAULT_MEDIA, match?.personId);
    } catch (err: any) {
      setError({ code: "start_failed", message: err?.message ?? "Could not start the call" });
      setActiveContact(null);
    }
  }, []);

  // "Play with friends": call a contact and attach the game once connected. The
  // pending game is applied by the initiator on the "active" transition.
  const startGameWithContact = useCallback(async (contactId: string, g: CallGame = DEFAULT_SOCIAL_GAME) => {
    pendingGameRef.current = g;
    await startCallToContact(contactId);
  }, [startCallToContact]);

  const startGame = useCallback((g: CallGame = DEFAULT_SOCIAL_GAME) => {
    clientRef.current?.setGame(g);
  }, []);

  const stopGame = useCallback(() => {
    clientRef.current?.setGame(null);
  }, []);

  // Start a game by myself — a real joinable one-person room (server-backed), so
  // friends can be invited in. The game arrives back via the call:game event.
  const startSoloGame = useCallback((g: CallGame = DEFAULT_SOCIAL_GAME) => {
    void clientRef.current?.startSoloGameCall(g);
  }, []);

  // Ring a contact into the current game/call.
  const inviteIntoCall = useCallback((contactId: string) => {
    void clientRef.current?.inviteIntoCall(contactId);
  }, []);

  // End the active game by leaving the call (a solo room ends; a shared call the
  // student leaves). The AAC student's only in-game exit.
  const endGame = useCallback(() => {
    clientRef.current?.hangUp();
  }, []);

  const sendWorld = useCallback((msgs: WorldNetMessage[]) => {
    clientRef.current?.sendWorldData(msgs);
  }, []);

  const sendNpc = useCallback((msg: unknown) => {
    clientRef.current?.sendNpc(msg);
  }, []);

  // Phase 1 position relay. Publishing also records our own presence locally so
  // the solver sees self alongside everyone else (the relay echoes others to us
  // but filters our own avatar back out).
  const publishPresence = useCallback((p: WorldPresence) => {
    clientRef.current?.publishPresence(p);
    presenceChannelRef.current.receive(p);
  }, []);

  // The circle solver: who can the local student currently hear? Proximity rule
  // for now; computed on demand (Phase 2 will subscribe to gate media).
  const getAudibleIds = useCallback((): Set<string> => {
    const me = selfPersonId;
    if (!me) return new Set();
    const all = presenceChannelRef.current.participants();
    const self = all.find((p) => p.personId === me);
    if (!self) return new Set();
    const others = all.filter((p) => p.personId !== me);
    return audibleRecvIds(solveAudibleFor(self, others, [proximityRule()]));
  }, [selfPersonId]);

  // Drop participants who stopped publishing (closed tab / lost focus).
  useEffect(() => {
    const channel = presenceChannelRef.current;
    const id = setInterval(() => channel.prune(), 2000);
    return () => clearInterval(id);
  }, []);

  // Phase 2: proximity A/V gate. Everyone stays on the mesh (so all avatars
  // render in the world); only the live AUDIO/VIDEO is constrained to the
  // student's circle. Peers out of range have their tracks muted and their video
  // tile hidden; in-range peers fade with distance. Disabled for plain calls and
  // non-circle games (full A/V to everyone).
  const circlesOn = !!game?.conversationCircles;
  useEffect(() => {
    if (!circlesOn || !selfPersonId) {
      // Make sure nothing stays muted when circles are off.
      for (const stream of remoteStreamsRef.current.values()) {
        for (const t of stream.getTracks()) t.enabled = true;
      }
      setPeerGains(new Map());
      return;
    }
    const channel = presenceChannelRef.current;
    const id = setInterval(() => {
      const gains = audibleGains(selfPersonId, channel.participants());
      for (const [pid, stream] of remoteStreamsRef.current) {
        const inRange = gains.has(pid);
        for (const t of stream.getTracks()) t.enabled = inRange;
      }
      setPeerGains((prev) => (sameGains(prev, gains) ? prev : gains));
    }, MEDIA_GATE_INTERVAL_MS);
    return () => clearInterval(id);
  }, [circlesOn, selfPersonId]);

  const accept = useCallback(async () => {
    const client = clientRef.current;
    if (!client) return;
    setError(null);
    setAudioEnabled(true);
    setVideoEnabled(true);
    try {
      await client.accept();
    } catch (err: any) {
      setError({ code: "accept_failed", message: err?.message ?? "Could not accept the call" });
    } finally {
      setIncoming(null);
    }
  }, []);

  const decline = useCallback(() => {
    clientRef.current?.declineIncoming();
    setIncoming(null);
  }, []);

  const cancel = useCallback(() => {
    clientRef.current?.cancel();
  }, []);

  const hangUp = useCallback(() => {
    clientRef.current?.hangUp();
  }, []);

  const toggleAudio = useCallback(() => {
    setAudioEnabled((prev) => {
      const next = !prev;
      clientRef.current?.toggleAudio(next);
      return next;
    });
  }, []);

  const toggleVideo = useCallback(() => {
    setVideoEnabled((prev) => {
      const next = !prev;
      clientRef.current?.toggleVideo(next);
      return next;
    });
  }, []);

  // -------------------------------------------------------------------------
  // AI-initiated call bridge — the live session surfaces a `call_directive`
  // (action: "start", contactId) which we dial automatically. Guarded against
  // re-firing on the same directive and against dialing while already in a call.
  // -------------------------------------------------------------------------
  const callDirective = dual?.callDirective ?? null;
  const lastDirectiveAtRef = useRef<number>(0);
  const startCallToContactRef = useRef(startCallToContact);
  startCallToContactRef.current = startCallToContact;
  useEffect(() => {
    if (!callDirective || callDirective.action !== "start" || !callDirective.contactId) return;
    if (callDirective.at <= lastDirectiveAtRef.current) return;
    lastDirectiveAtRef.current = callDirective.at;
    if (callState !== "idle") {
      console.warn("[CallContext] Ignoring AI call_directive — already in a call");
      return;
    }
    void startCallToContactRef.current(callDirective.contactId);
  }, [callDirective, callState]);

  // Tell the live session when we enter/leave a call so the AI steps into
  // facilitator mode (and out again) — same idea as the social trainer.
  const inCall = callState !== "idle";
  const prevInCallRef = useRef(false);
  const sendCallActive = dual?.sendCallActive;
  const sendConversationRoom = dual?.sendConversationRoom;

  // Facilitator mode + call outcome — keyed on the inCall transition.
  useEffect(() => {
    if (inCall === prevInCallRef.current) return;
    prevInCallRef.current = inCall;
    if (inCall) {
      sendCallActive?.(true);
      return;
    }
    // Call ended — classify the outcome so the AI can react when it never
    // connected (declined / no answer / unavailable) vs a normal hang-up.
    let outcome = "ended";
    if (!everConnectedRef.current) {
      switch (lastEndReasonRef.current) {
        case "declined": outcome = "declined"; break;
        case "missed":   outcome = "no_answer"; break;
        case "offline":  outcome = "unavailable"; break;
        case "cancelled": outcome = "cancelled"; break;
        default:         outcome = "no_answer"; break;
      }
    }
    sendCallActive?.(false, outcome);
  }, [inCall, sendCallActive]);

  // Shape C: join a shared conversation room keyed by the call's id so peer
  // utterances flow to this session's AI/boards. Keyed on callState (not the
  // inCall transition) because for the CALLEE the callId only exists AFTER
  // accept() — at ringing-in `this.call` is still null, so an inCall-transition
  // join would send `null` and never re-fire. We join the moment getCallId() is
  // available and leave when it's gone.
  const joinedRoomRef = useRef<string | null>(null);
  useEffect(() => {
    const callId = clientRef.current?.getCallId() ?? null;
    if (callId && joinedRoomRef.current !== callId) {
      joinedRoomRef.current = callId;
      console.log(`[AAC CallContext] joining conversation room ${callId}`);
      sendConversationRoom?.(callId);
    } else if (!callId && joinedRoomRef.current) {
      console.log("[AAC CallContext] leaving conversation room");
      joinedRoomRef.current = null;
      sendConversationRoom?.(null);
    }
  }, [callState, sendConversationRoom]);

  const value: CallContextValue = useMemo(() => ({
    callState,
    active: callState !== "idle",
    incoming,
    selfPersonId,
    localStream,
    remoteStreams,
    activeContact,
    error,
    audioEnabled,
    videoEnabled,
    contacts,
    contactsLoading,
    refreshContacts,
    startCallToContact,
    accept,
    decline,
    cancel,
    hangUp,
    toggleAudio,
    toggleVideo,
    game,
    activeGame: game,
    startSoloGame,
    inviteIntoCall,
    endGame,
    startGameWithContact,
    startGame,
    stopGame,
    sendWorld,
    worldHub: worldHubRef.current,
    sendNpc,
    npcHub: npcHubRef.current,
    publishPresence,
    presenceChannel: presenceChannelRef.current,
    getAudibleIds,
    peerGains,
  }), [
    callState, incoming, selfPersonId, localStream, remoteStreams, activeContact,
    error, audioEnabled, videoEnabled, contacts, contactsLoading, refreshContacts,
    startCallToContact, accept, decline, cancel, hangUp, toggleAudio, toggleVideo,
    game, startSoloGame, inviteIntoCall, endGame, startGameWithContact, startGame, stopGame, sendWorld, sendNpc,
    publishPresence, getAudibleIds, peerGains,
  ]);

  return <CallContext.Provider value={value}>{children}</CallContext.Provider>;
}

export function useCall(): CallContextValue {
  const ctx = useContext(CallContext);
  if (!ctx) throw new Error("useCall must be used within CallProvider");
  return ctx;
}

/** Non-throwing variant for components that may render outside CallProvider. */
export function useCallOptional(): CallContextValue | null {
  return useContext(CallContext);
}
