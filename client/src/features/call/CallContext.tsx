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
import { CallClient, type CallClientEvent, type CallState, type IncomingCall } from "@shared/call/call-client";
import {
  parseCallDataMessage,
  type CallDataMessage,
  type MirrorHudSections,
  type MirrorQuickButton,
  type MirrorStripItem,
  type MirrorSurface,
  type WorldCommandMessage,
} from "@shared/call/call-data-messages";
import type { BuilderTarget } from "@shared/call/builder-mirror";
import type { CallGame, CallMediaFlags } from "@shared/realtime-events";
import type { BoardButton, ParsedBoardData } from "@shared/schema";
import type { WorldNetMessage } from "@shared/world-engine/index";
import { CallWorldHub, CallNpcHub } from "@shared/social-world/call-game-net";
import { WorldPresenceChannel, type WorldPresence } from "@shared/social-world/world-presence";
import { proximityRule, solveAudibleFor, audibleRecvIds } from "@shared/social-world/circle-solver";
import { audibleGains } from "@shared/social-world/media-gate";
import { createActiveSpeakerDetector } from "@shared/call/active-speaker";
import { DEFAULT_SOCIAL_GAME } from "@shared/social-world/default-game";
import { useAuth } from "@/hooks/useAuth";
import { useInstitute } from "@/hooks/useInstitute";
import { useLanguage } from "@/contexts/LanguageContext";
import { fetchIceServers, type CallParticipantInfo, type InviteSelection } from "./api";
import { streamMicPcm } from "./micPcm";
import CallAudioSinks from "@shared/call/CallAudioSinks";
import { createRoom, type PersonChatContact } from "@/features/personChat/api";

/** Build the ws(s):// URL for a server path, mirroring usePersonChatSocket. */
function resolveWsUrl(path: string): string {
  const base = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/+$/, "") ?? "";
  if (base) {
    const url = new URL(base);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = path;
    return url.toString();
  }
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}${path}`;
}

function contactDisplayName(c: PersonChatContact): string {
  const full = [c.firstName, c.lastName].filter(Boolean).join(" ").trim();
  return full || c.email;
}

/** How often the proximity media gate re-evaluates (ms). ~1s re-form is fine. */
const MEDIA_GATE_INTERVAL_MS = 700;

/** Cheap equality so the gate only triggers a re-render when gains actually change. */
function sameGains(a: Map<string, number>, b: Map<string, number>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}

interface CallContextValue {
  callState: CallState;
  incoming: IncomingCall | null;
  selfPersonId: string | null;
  localStream: MediaStream | null;
  remoteStreams: Map<string, MediaStream>;
  remoteMedia: Map<string, CallMediaFlags>;
  error: { code: string; message: string } | null;
  /** Display name of the contact for the currently active/outgoing call. */
  activeContactName: string | null;
  audioEnabled: boolean;
  videoEnabled: boolean;
  /** Other room participants (personId + name) — for the in-call addressee picker. */
  participants: CallParticipantInfo[];
  /** Local output mute — silences every remote participant for this listener.
   *  Lives at call scope, not in a view: CallAudioSinks owns the audio for the
   *  whole call, so the control over it has to outlive any one panel. */
  outputMuted: boolean;
  setOutputMuted: (muted: boolean) => void;
  /** personId the clinician has marked they're addressing, or null (everyone). */
  addressee: string | null;
  /** Declare who the clinician is speaking to (or null to clear). */
  setAddressee: (personId: string | null) => void;
  /** A participant who is currently addressing the clinician (from a peer's
   *  focus), or null. Lets the UI surface "Sara is talking to you". */
  addressedBy: { fromPersonId: string; fromName: string } | null;
  /** Live STT transcript of the clinician's OWN speech (server recognition) —
   *  a self-caption that also shows whether the recognizer is hearing them. */
  selfTranscript: string;
  /** The clinician's most recent FINAL utterance, for the in-game speech bubble
   *  over their avatar. `at` changes per utterance (re-passing it is a no-op). */
  lastSelfSpeech: { text: string; at: number } | null;

  /** Social game attached to the active call (null = plain video chat). */
  game: CallGame | null;
  /** Attach a game to the active call (defaults to the built-in social world).
   *  This client is stamped as the game's HOST (it runs the simulation). */
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
  /** Fan-out of inbound RELIABLE `world-cmd` data messages for an iframe world
   *  game (engine "iframe-quest"). The mounted IframeQuestSurface subscribes and
   *  ferries each command into the game iframe. Handler args: (fromPersonId,
   *  parsed WorldCommandMessage). */
  worldCmdHub: CallWorldCmdHub;
  /** Phase 1 position relay: publish the local avatar's position world-wide. */
  publishPresence: (p: WorldPresence) => void;
  /** Phase 1 position relay: inbound positions of everyone in the world. */
  presenceChannel: WorldPresenceChannel;
  /** Circle solver: who the local user can currently hear (proximity rule).
   *  Computed on demand. */
  getAudibleIds: () => Set<string>;
  /** Per-peer audio gain 0..1 from the proximity media gate (Phase 2). */
  peerGains: Map<string, number>;
  /** The participant currently speaking (loudest remote stream), or null —
   *  drives the "auto" video layout. */
  activeSpeakerId: string | null;

  /** The board the AAC student is currently looking at, mirrored over the call's
   *  reliable data channel so the clinician can SEE their screen (read-only). */
  mirroredBoard: MirroredBoardState | null;
  /** Button id the student is dwelling on right now (gaze hover), or null. */
  mirroredDwell: string | null;
  /** Button id of the student's most recent momentary press (for a flash). */
  mirroredSelection: { buttonId: string; at: number } | null;
  /** Send a typed message over the call's reliable data channel (e.g. a
   *  facilitator press on the mirrored board). */
  sendData: (message: CallDataMessage) => void;
  /** Facilitate a press on the mirrored SENTENCE BUILDER (consent-gated on the
   *  AAC side, like every other facilitator press). */
  sendBuilderPress: (target: BuilderTarget) => void;
  /** Inbound screen-share streams (getDisplayMedia), keyed by personId. */
  screenStreams: Map<string, MediaStream>;
  /** Whether a screen-share has been requested/active for this call. */
  screenRequested: boolean;
  /** Ask the AAC to start (true) / stop (false) sharing its screen. */
  requestScreenShare: (on: boolean) => void;

  startCallWithContact: (contact: PersonChatContact) => Promise<void>;
  /** Call a student who listed this user as a callable contact (via the contact link).
   *  `autoAccept` opens it automatically on the student's device instead of ringing. */
  startCallToStudent: (contactId: string, studentName: string, personId: string, autoAccept?: boolean) => Promise<void>;
  /** Start a group call with one or more people. `autoAccept` opens it automatically
   *  on AAC invitees instead of ringing. `game` is attached the moment the call
   *  goes active (a "game room": everyone lands straight in the world), with this
   *  client as its host. */
  startCallWithPeople: (selections: InviteSelection[], autoAccept?: boolean, game?: CallGame) => Promise<void>;
  /** Ring more people into the active call. */
  invitePeopleIntoCall: (selections: InviteSelection[], autoAccept?: boolean) => Promise<void>;
  accept: () => Promise<void>;
  decline: () => void;
  cancel: () => void;
  hangUp: () => void;
  toggleAudio: (enabled: boolean) => void;
  toggleVideo: (enabled: boolean) => void;
}

/** The mirrored AAC board, plus which peer it came from. */
export interface MirroredBoardState {
  fromPersonId: string;
  board: ParsedBoardData;
  pageId?: string;
  mode: "board" | "app";
  appKind?: string;
  /** Student device reading direction — render the mirror this way. */
  rtl?: boolean;
  /** Context-sidebar buttons the student sees beside the board. */
  contextButtons?: BoardButton[];
  /** Bottom quick-action row the student sees. */
  quickButtons?: MirrorQuickButton[];
  /** The SPECIFIC surface — absent from AAC builds older than the split view. */
  surface?: MirrorSurface;
  /** The app's or game's own localized title. */
  title?: string;
  /** The sentence builder's composed sentence + its controls. */
  strip?: MirrorStripItem[];
  /** The builder's mode-chip rail (distinct from `quickButtons`). */
  chips?: MirrorQuickButton[];
  /** An embedded world-engine game's ambient HUD. */
  hud?: MirrorHudSections;
  at: number;
}

type WorldCmdHandler = (fromPersonId: string, cmd: WorldCommandMessage) => void;

/** Minimal fan-out for inbound `world-cmd` reliable data messages — same shape
 *  as CallWorldHub/CallNpcHub, typed to the parsed envelope. One per provider;
 *  the active IframeQuestSurface subscribes. */
export class CallWorldCmdHub {
  private handlers = new Set<WorldCmdHandler>();

  emit(fromPersonId: string, cmd: WorldCommandMessage): void {
    for (const h of this.handlers) h(fromPersonId, cmd);
  }

  subscribe(handler: WorldCmdHandler): () => void {
    this.handlers.add(handler);
    return () => { this.handlers.delete(handler); };
  }

  clear(): void {
    this.handlers.clear();
  }
}

const CallContext = createContext<CallContextValue | null>(null);

export function CallProvider({ children }: { children: ReactNode }) {
  const { isAuthenticated } = useAuth();
  const { currentInstitute, institutes } = useInstitute();

  const clientRef = useRef<CallClient | null>(null);

  const [callState, setCallState] = useState<CallState>("idle");
  const [incoming, setIncoming] = useState<IncomingCall | null>(null);
  const [selfPersonId, setSelfPersonId] = useState<string | null>(null);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [outputMuted, setOutputMuted] = useState(false);
  const [remoteStreams, setRemoteStreams] = useState<Map<string, MediaStream>>(new Map());
  const [remoteMedia, setRemoteMedia] = useState<Map<string, CallMediaFlags>>(new Map());
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const [activeContactName, setActiveContactName] = useState<string | null>(null);
  const [audioEnabled, setAudioEnabled] = useState(true);
  const [videoEnabled, setVideoEnabled] = useState(true);
  const [participants, setParticipants] = useState<CallParticipantInfo[]>([]);
  const [addressee, setAddresseeState] = useState<string | null>(null);
  const [addressedBy, setAddressedBy] = useState<{ fromPersonId: string; fromName: string } | null>(null);
  const [selfTranscript, setSelfTranscript] = useState("");
  const [lastSelfSpeech, setLastSelfSpeech] = useState<{ text: string; at: number } | null>(null);
  const [game, setGameState] = useState<CallGame | null>(null);
  const [peerGains, setPeerGains] = useState<Map<string, number>>(new Map());
  const [mirroredBoard, setMirroredBoard] = useState<MirroredBoardState | null>(null);
  const [mirroredDwell, setMirroredDwell] = useState<string | null>(null);
  const [mirroredSelection, setMirroredSelection] = useState<{ buttonId: string; at: number } | null>(null);
  // Inbound screen-share streams (getDisplayMedia), kept separate from camera
  // streams. A peer's screen arrives as its own `ontrack` stream; we classify by
  // the stream id announced over the data channel.
  const [screenStreams, setScreenStreams] = useState<Map<string, MediaStream>>(new Map());
  const screenStreamIdsRef = useRef<Set<string>>(new Set());
  const [screenRequested, setScreenRequested] = useState(false);
  // One world-message fan-out per provider; the active CallGameSurface subscribes.
  const worldHubRef = useRef(new CallWorldHub());
  const npcHubRef = useRef(new CallNpcHub());
  // Reliable world-cmd fan-out for iframe world games (engine "iframe-quest").
  const worldCmdHubRef = useRef(new CallWorldCmdHub());
  // Phase 1 position relay: world-wide avatar positions, fed by `presence` events.
  const presenceChannelRef = useRef(new WorldPresenceChannel());
  // Mirror remoteStreams in a ref so the proximity A/V gate reads it without
  // restarting its interval on every connect.
  const remoteStreamsRef = useRef(remoteStreams);
  remoteStreamsRef.current = remoteStreams;
  // A game queued by "start a game room": the call is still ringing, so there is
  // no session to attach it to yet. Applied on the transition to "active"
  // (late joiners get it from accept()'s call:game catch-up).
  const pendingGameRef = useRef<CallGame | null>(null);
  // Our own personId, readable from callbacks that must not re-create per render.
  const selfPersonIdRef = useRef<string | null>(null);

  const clearStreams = useCallback(() => {
    setLocalStream(null);
    setRemoteStreams(new Map());
    setRemoteMedia(new Map());
    setParticipants([]);
    setAddresseeState(null);
    setAddressedBy(null);
    setSelfTranscript("");
    setGameState(null);
    setPeerGains(new Map());
    setMirroredBoard(null);
    setMirroredDwell(null);
    setMirroredSelection(null);
    setScreenStreams(new Map());
    setScreenRequested(false);
    screenStreamIdsRef.current.clear();
    worldHubRef.current.clear();
    npcHubRef.current.clear();
    worldCmdHubRef.current.clear();
    presenceChannelRef.current.clear();
    pendingGameRef.current = null;
  }, []);

  const handleEvent = useCallback((event: CallClientEvent) => {
    switch (event.type) {
      case "ready":
        setSelfPersonId(event.selfPersonId);
        selfPersonIdRef.current = event.selfPersonId;
        break;
      case "incoming":
        setIncoming(event.call);
        setActiveContactName(event.call.fromName ?? null);
        setError(null);
        break;
      case "state":
        setCallState(event.state);
        // Game room: the call we started with a game queued is now up — attach
        // it, so everyone lands in the world instead of a plain video call.
        if (event.state === "active" && pendingGameRef.current) {
          clientRef.current?.setGame(pendingGameRef.current);
          pendingGameRef.current = null;
        }
        if (event.state === "idle" || event.state === "ended") {
          clearStreams();
          setActiveContactName(null);
          setAudioEnabled(true);
          setVideoEnabled(true);
        }
        break;
      case "localStream":
        setLocalStream(event.stream);
        break;
      case "remoteStream":
        // A peer's screen-share arrives as its own stream; route it to
        // screenStreams (classified by the announced stream id) so it doesn't
        // overwrite their camera. Unknown streams default to the camera; a later
        // screen-share notice reclassifies if needed.
        if (screenStreamIdsRef.current.has(event.stream.id)) {
          setScreenStreams((prev) => new Map(prev).set(event.personId, event.stream));
        } else {
          setRemoteStreams((prev) => {
            const next = new Map(prev);
            next.set(event.personId, event.stream);
            return next;
          });
        }
        break;
      case "mediaState":
        setRemoteMedia((prev) => {
          const next = new Map(prev);
          next.set(event.personId, event.media);
          return next;
        });
        break;
      case "peerLeft":
        setRemoteStreams((prev) => {
          const next = new Map(prev);
          next.delete(event.personId);
          return next;
        });
        setScreenStreams((prev) => {
          const next = new Map(prev);
          next.delete(event.personId);
          return next;
        });
        setRemoteMedia((prev) => {
          const next = new Map(prev);
          next.delete(event.personId);
          return next;
        });
        // If the clinician was addressing the peer who left, clear it.
        setAddresseeState((cur) => (cur === event.personId ? null : cur));
        presenceChannelRef.current.leave(event.personId);
        break;
      case "ended":
        setIncoming(null);
        clearStreams();
        setActiveContactName(null);
        break;
      case "error":
        // Surface the error but do NOT tear down the call/game — a transient
        // peer-connection blip (onPeerFailed → "connection") must not wipe the
        // streams, presence channel and game out from under an active session.
        // Real teardown comes from "ended".
        setError({ code: event.code, message: event.message });
        break;
      case "roster":
        // Conversation-room roster (other participants) for the addressee picker.
        setParticipants(event.participants);
        break;
      case "addressedBy":
        // A participant turned to address the clinician.
        setAddressedBy({ fromPersonId: event.fromPersonId, fromName: event.fromName });
        break;
      case "transcript":
        // Live STT of our own speech — rolling self-caption. On a FINAL phrase
        // it also drives the in-game speech bubble over this caller's avatar.
        // (That used to be set by the Web Speech branch; when server STT became
        // the only path the bubble had to move with it.)
        setSelfTranscript(event.text);
        if (event.isFinal && event.text.trim()) {
          setLastSelfSpeech({ text: event.text.trim(), at: Date.now() });
        }
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
      case "data": {
        // The AAC mirrors its board over the reliable channel so the clinician
        // can see (and, with Interact on, drive) the student's screen.
        const m = parseCallDataMessage(event.message);
        if (!m) break;
        if (m.k === "board-mirror") {
          setMirroredBoard({
            fromPersonId: event.personId,
            board: m.board, pageId: m.pageId, mode: m.mode, appKind: m.appKind, rtl: m.rtl,
            contextButtons: m.contextButtons, quickButtons: m.quickButtons,
            surface: m.surface, title: m.title, strip: m.strip, chips: m.chips, hud: m.hud,
            at: m.at,
          });
        } else if (m.k === "board-dwell") {
          setMirroredDwell(m.buttonId);
        } else if (m.k === "board-selection") {
          setMirroredSelection({ buttonId: m.buttonId, at: m.at });
        } else if (m.k === "world-cmd") {
          // Reliable command for an iframe world game — fan out to the mounted
          // IframeQuestSurface, which ferries it into the game iframe.
          worldCmdHubRef.current.emit(event.personId, m);
        } else if (m.k === "screen-share") {
          if (m.on) {
            screenStreamIdsRef.current.add(m.streamId);
            setScreenRequested(true);
            // The stream may already have arrived (classified as camera) — move it.
            setRemoteStreams((prevCam) => {
              const cam = new Map(prevCam);
              for (const [pid, s] of cam) {
                if (s.id === m.streamId) {
                  cam.delete(pid);
                  setScreenStreams((prev) => new Map(prev).set(pid, s));
                  break;
                }
              }
              return cam;
            });
          } else {
            screenStreamIdsRef.current.delete(m.streamId);
            setScreenRequested(false);
            setScreenStreams((prev) => {
              const next = new Map(prev);
              for (const [pid, s] of next) { if (s.id === m.streamId) { next.delete(pid); break; } }
              return next;
            });
          }
        }
        break;
      }
    }
  }, [clearStreams]);

  const handleEventRef = useRef(handleEvent);
  handleEventRef.current = handleEvent;

  useEffect(() => {
    if (!isAuthenticated) return;
    const client = new CallClient({
      wsUrl: resolveWsUrl("/ws/call"),
      getIceServers: fetchIceServers,
      emit: (e) => handleEventRef.current(e),
    });
    clientRef.current = client;
    client.connect();
    return () => {
      client.disconnect();
      clientRef.current = null;
    };
  }, [isAuthenticated]);

  const startCallWithContact = useCallback(async (contact: PersonChatContact) => {
    const client = clientRef.current;
    if (!client) return;
    const instituteId =
      contact.instituteIds.find((id) => id === currentInstitute?.id) ??
      currentInstitute?.id ??
      contact.instituteIds[0] ??
      institutes[0]?.id ??
      null;
    if (!instituteId) {
      setError({ code: "no_institute", message: "No organization available for this call" });
      return;
    }
    setError(null);
    setActiveContactName(contactDisplayName(contact));
    setAudioEnabled(true);
    setVideoEnabled(true);
    try {
      const room = await createRoom({ instituteId, participantIds: [contact.id] });
      await client.startCall(room.id, { audio: true, video: true, pose: false }, contact.id);
    } catch (err: any) {
      setError({ code: "start_failed", message: err?.message ?? "Could not start the call" });
      setActiveContactName(null);
    }
  }, [currentInstitute?.id, institutes]);

  const startCallToStudent = useCallback(async (contactId: string, studentName: string, personId: string, autoAccept = false) => {
    const client = clientRef.current;
    if (!client) return;
    setError(null);
    setActiveContactName(studentName);
    setAudioEnabled(true);
    setVideoEnabled(true);
    try {
      // Contact-authorized call (server resolves the room); same path the AAC uses.
      await client.startCallToContact(contactId, { audio: true, video: true, pose: false }, personId, autoAccept);
    } catch (err: any) {
      setError({ code: "start_failed", message: err?.message ?? "Could not start the call" });
      setActiveContactName(null);
    }
  }, []);

  // Start a fresh group call. STUDENTS are rung through the callable-contact path
  // (they aren't institute members, so the room path 403s for them); institute
  // CONTACTS go in a person-chat room. `autoAccept` asks AAC invitees to open
  // without ringing.
  const startCallWithPeople = useCallback(async (selections: InviteSelection[], autoAccept = false, game?: CallGame) => {
    const client = clientRef.current;
    if (!client || selections.length === 0) return;
    const contacts = selections.filter((s) => !s.contactId);
    const students = selections.filter((s) => s.contactId);
    const media: CallMediaFlags = { audio: true, video: true, pose: false };
    // Queue the game room's world; the "active" transition attaches it. We host
    // it — this window isn't also running the AAC's on-device ML stack.
    pendingGameRef.current = game
      ? { ...game, hostPersonId: game.hostPersonId ?? selfPersonIdRef.current ?? undefined }
      : null;
    setError(null);
    setActiveContactName(selections.length === 1 ? null : `${selections.length} people`);
    setAudioEnabled(true);
    setVideoEnabled(true);
    try {
      let pendingStudents = students;
      if (contacts.length > 0) {
        // Institute room with the contacts (rung at start), students invited after.
        const instituteId = currentInstitute?.id ?? institutes[0]?.id ?? null;
        if (!instituteId) { setError({ code: "no_institute", message: "No organization available for this call" }); return; }
        const room = await createRoom({ instituteId, participantIds: contacts.map((c) => c.personId) });
        await client.startCall(room.id, media, contacts[0].personId, autoAccept);
      } else {
        // All students — start with the first via the callable-contact path.
        await client.startCallToContact(students[0].contactId!, media, students[0].personId, autoAccept);
        pendingStudents = students.slice(1);
      }
      // Ring the remaining students into the now-started call.
      for (const s of pendingStudents) {
        try { await client.inviteIntoCall(s.contactId!, autoAccept); }
        catch (err) { console.error("[call] startCallWithPeople invite:", err); }
      }
    } catch (err: any) {
      pendingGameRef.current = null;
      setError({ code: "start_failed", message: err?.message ?? "Could not start the call" });
      setActiveContactName(null);
    }
  }, [currentInstitute?.id, institutes]);

  // Ring more people INTO the active call. Students via the callable-contact path,
  // institute contacts by personId.
  const invitePeopleIntoCall = useCallback(async (selections: InviteSelection[], autoAccept = false) => {
    const client = clientRef.current;
    if (!client) return;
    for (const s of selections) {
      try {
        if (s.contactId) await client.inviteIntoCall(s.contactId, autoAccept);
        else await client.inviteIntoCallPerson(s.personId, autoAccept);
      } catch (err) { console.error("[call] invitePeopleIntoCall:", err); }
    }
  }, []);

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

  const toggleAudio = useCallback((enabled: boolean) => {
    clientRef.current?.toggleAudio(enabled);
    setAudioEnabled(enabled);
  }, []);

  const toggleVideo = useCallback((enabled: boolean) => {
    clientRef.current?.toggleVideo(enabled);
    setVideoEnabled(enabled);
  }, []);

  const setAddressee = useCallback((personId: string | null) => {
    clientRef.current?.setAddressee(personId);
    setAddresseeState(personId);
  }, []);

  // Attaching a game from THIS window also nominates it as the simulation host
  // (an owner-authoritative world runs its whole sim on the owner's device).
  const startGame = useCallback((g: CallGame = DEFAULT_SOCIAL_GAME) => {
    clientRef.current?.setGame({
      ...g,
      hostPersonId: g.hostPersonId ?? selfPersonIdRef.current ?? undefined,
    });
  }, []);

  const stopGame = useCallback(() => {
    pendingGameRef.current = null;
    clientRef.current?.setGame(null);
  }, []);

  const sendWorld = useCallback((msgs: WorldNetMessage[]) => {
    clientRef.current?.sendWorldData(msgs);
  }, []);

  const sendData = useCallback((message: CallDataMessage) => {
    clientRef.current?.sendData(message);
  }, []);

  // Facilitated press on the mirrored SENTENCE BUILDER. Separate from the board's
  // `facilitator-press` because the two are different acts: a board button is a
  // whole utterance, a builder press is one move in composing one.
  const sendBuilderPress = useCallback((target: BuilderTarget) => {
    clientRef.current?.sendData({ k: "facilitator-builder", target, at: Date.now() });
  }, []);

  const requestScreenShare = useCallback((on: boolean) => {
    setScreenRequested(on);
    clientRef.current?.requestScreenShare(on);
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

  // The circle solver: who can the local user currently hear? Proximity rule for
  // now; computed on demand (Phase 2 will subscribe to gate media).
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
  // render in the world); only the live AUDIO/VIDEO is constrained to the local
  // circle. Out-of-range peers are muted; in-range peers fade with distance.
  // Disabled for plain calls and non-circle games (full A/V to everyone).
  const circlesOn = !!game?.conversationCircles;
  useEffect(() => {
    if (!circlesOn || !selfPersonId) {
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

  // Per-peer audio activity (shared detector) — drives the active-speaker
  // spotlight in the "auto" video layout.
  //
  // It used to ALSO arm a 1500ms "remote audio was just heard" window that the
  // Web Speech echo guard used to discard self-transcripts. Both are gone: echo
  // is now handled where it belongs (AEC on the capture the server transcribes),
  // not by guessing which of our own transcripts were really the far end.
  const [activeSpeakerId, setActiveSpeakerId] = useState<string | null>(null);
  useEffect(() => {
    if (callState !== "active" || remoteStreams.size === 0) { setActiveSpeakerId(null); return; }
    const detector = createActiveSpeakerDetector({
      onActiveSpeaker: setActiveSpeakerId,
    });
    if (!detector) return;
    detector.setStreams(remoteStreams);
    return () => detector.stop();
  }, [callState, remoteStreams]);

  // While the call is active, transcribe the clinician's OWN speech and publish
  // it into the conversation room — so AAC students' Observers + Board Managers
  // perceive what is said (the student hears the raw audio, but their AI cannot
  // transcribe a remote stream).
  //
  // IN-REGION SERVER STT IS THE ONLY PATH. This used to PREFER the browser's Web
  // Speech API, which was wrong twice over:
  //
  //   • PHI. Web Speech routes audio through Google's CONSUMER service, outside
  //     the platform's GCP/BAA region — a data-residency regression against the
  //     locked decision that clinical audio stays in-region.
  //   • Echo, and this is why the reported bug existed. Web Speech opens its OWN
  //     capture of the raw microphone, so it hears the far end coming out of
  //     these speakers. An "echo guard" was bolted on to drop self-transcripts
  //     heard during remote audio — and it could not work: a Web Speech final
  //     only fires after 1200ms of silence, while the guard suppressed anything
  //     within 1500ms of remote audio. Any remote sound in the last 300ms of a
  //     sentence, or after it, discarded that sentence. The clinician could only
  //     be heard by staying quiet for 300ms AFTER the far end went quiet.
  //
  // streamMicPcm reads `localStream`, whose audio track is the getUserMedia
  // capture with echoCancellation ON (see call-client acquireLocalMedia). So the
  // echo is REMOVED from the signal before recognition rather than guessed at
  // afterwards, and no guard is needed.
  const { language } = useLanguage();
  useEffect(() => {
    if (callState !== "active" || !audioEnabled || !localStream) return;
    // NOTE: `language` is still the clinician's UI language, which is not
    // necessarily the language they SPEAK. Replaced by an explicit
    // per-participant spoken language in C1 — see the rework design §D6.
    return streamMicPcm(localStream, (chunk, sampleRate) => {
      clientRef.current?.sendAudioChunk(chunk, sampleRate, language);
    });
  }, [callState, audioEnabled, localStream, language]);

  const value: CallContextValue = useMemo(() => ({
    callState,
    incoming,
    selfPersonId,
    localStream,
    remoteStreams,
    remoteMedia,
    error,
    activeContactName,
    outputMuted,
    setOutputMuted,
    audioEnabled,
    videoEnabled,
    participants,
    addressee,
    setAddressee,
    addressedBy,
    selfTranscript,
    lastSelfSpeech,
    game,
    startGame,
    stopGame,
    sendWorld,
    worldHub: worldHubRef.current,
    sendNpc,
    npcHub: npcHubRef.current,
    worldCmdHub: worldCmdHubRef.current,
    publishPresence,
    presenceChannel: presenceChannelRef.current,
    getAudibleIds,
    peerGains,
    activeSpeakerId,
    mirroredBoard,
    mirroredDwell,
    mirroredSelection,
    sendData,
    sendBuilderPress,
    screenStreams,
    screenRequested,
    requestScreenShare,
    startCallWithContact,
    startCallToStudent,
    startCallWithPeople,
    invitePeopleIntoCall,
    accept,
    decline,
    cancel,
    hangUp,
    toggleAudio,
    toggleVideo,
  }), [
    callState, incoming, selfPersonId, localStream, remoteStreams, remoteMedia, outputMuted,
    error, activeContactName, audioEnabled, videoEnabled, participants, addressee, setAddressee, addressedBy, selfTranscript, lastSelfSpeech,
    game, startGame, stopGame, sendWorld, sendNpc, publishPresence, getAudibleIds, peerGains, activeSpeakerId,
    mirroredBoard, mirroredDwell, mirroredSelection, sendData, sendBuilderPress, screenStreams, screenRequested, requestScreenShare,
    startCallWithContact, startCallToStudent, startCallWithPeople, invitePeopleIntoCall, accept, decline, cancel, hangUp, toggleAudio, toggleVideo,
  ]);

  return (
    <CallContext.Provider value={value}>
      {children}
      {/* THE call's audio output. Mounted here, not in a view, so every
          participant stays audible regardless of which panel is showing and
          whether their camera is on. */}
      <CallAudioSinks streams={remoteStreams} gains={peerGains} muted={outputMuted} />
    </CallContext.Provider>
  );
}

export function useCall(): CallContextValue {
  const ctx = useContext(CallContext);
  if (!ctx) throw new Error("useCall must be used within CallProvider");
  return ctx;
}
