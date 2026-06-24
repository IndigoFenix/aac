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
import type { CallGame, CallMediaFlags } from "@shared/realtime-events";
import type { WorldNetMessage } from "@shared/world-engine/index";
import { CallWorldHub } from "@shared/social-world/call-game-net";
import { WorldPresenceChannel, type WorldPresence } from "@shared/social-world/world-presence";
import { proximityRule, solveAudibleFor, audibleRecvIds } from "@shared/social-world/circle-solver";
import { audibleGains } from "@shared/social-world/media-gate";
import { DEFAULT_SOCIAL_GAME } from "@shared/social-world/default-game";
import { useAuth } from "@/hooks/useAuth";
import { useInstitute } from "@/hooks/useInstitute";
import { useLanguage } from "@/contexts/LanguageContext";
import { fetchIceServers, type CallParticipantInfo } from "./api";
import { streamMicPcm } from "./micPcm";
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

/** App language code → BCP-47 tag for the Web Speech API (mirrors the
 *  regular-chat dictation hook, useSpeechToText). */
const SPEECH_LANG: Record<string, string> = {
  en: "en-US", he: "he-IL", ar: "ar-SA", es: "es-ES", fr: "fr-FR", de: "de-DE",
  ru: "ru-RU", zh: "zh-CN", ko: "ko-KR", yue: "zh-HK", pt: "pt-BR",
};


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

  /** Social game attached to the active call (null = plain video chat). */
  game: CallGame | null;
  /** Attach a game to the active call (defaults to the built-in social world). */
  startGame: (game?: CallGame) => void;
  /** Detach the game (back to plain video chat). */
  stopGame: () => void;
  /** Broadcast world state over the call's unreliable "world" channel. */
  sendWorld: (msgs: WorldNetMessage[]) => void;
  /** Fan-out of inbound peer world messages (fed by the CallClient). */
  worldHub: CallWorldHub;
  /** Phase 1 position relay: publish the local avatar's position world-wide. */
  publishPresence: (p: WorldPresence) => void;
  /** Phase 1 position relay: inbound positions of everyone in the world. */
  presenceChannel: WorldPresenceChannel;
  /** Circle solver: who the local user can currently hear (proximity rule).
   *  Computed on demand. */
  getAudibleIds: () => Set<string>;
  /** Per-peer audio gain 0..1 from the proximity media gate (Phase 2). */
  peerGains: Map<string, number>;

  startCallWithContact: (contact: PersonChatContact) => Promise<void>;
  /** Call a student who listed this user as a callable contact (via the contact link). */
  startCallToStudent: (contactId: string, studentName: string, personId: string) => Promise<void>;
  accept: () => Promise<void>;
  decline: () => void;
  cancel: () => void;
  hangUp: () => void;
  toggleAudio: (enabled: boolean) => void;
  toggleVideo: (enabled: boolean) => void;
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
  const [game, setGameState] = useState<CallGame | null>(null);
  const [peerGains, setPeerGains] = useState<Map<string, number>>(new Map());
  // One world-message fan-out per provider; the active CallGameSurface subscribes.
  const worldHubRef = useRef(new CallWorldHub());
  // Phase 1 position relay: world-wide avatar positions, fed by `presence` events.
  const presenceChannelRef = useRef(new WorldPresenceChannel());
  // Mirror remoteStreams in a ref so the proximity A/V gate reads it without
  // restarting its interval on every connect.
  const remoteStreamsRef = useRef(remoteStreams);
  remoteStreamsRef.current = remoteStreams;

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
    worldHubRef.current.clear();
    presenceChannelRef.current.clear();
  }, []);

  const handleEvent = useCallback((event: CallClientEvent) => {
    switch (event.type) {
      case "ready":
        setSelfPersonId(event.selfPersonId);
        break;
      case "incoming":
        setIncoming(event.call);
        setActiveContactName(event.call.fromName ?? null);
        setError(null);
        break;
      case "state":
        setCallState(event.state);
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
        setRemoteStreams((prev) => {
          const next = new Map(prev);
          next.set(event.personId, event.stream);
          return next;
        });
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
        // Live STT of our own speech — rolling self-caption.
        setSelfTranscript(event.text);
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
      case "data":
        // Reserved for AAC extras; the clinician UI ignores data-channel messages.
        break;
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

  const startCallToStudent = useCallback(async (contactId: string, studentName: string, personId: string) => {
    const client = clientRef.current;
    if (!client) return;
    setError(null);
    setActiveContactName(studentName);
    setAudioEnabled(true);
    setVideoEnabled(true);
    try {
      // Contact-authorized call (server resolves the room); same path the AAC uses.
      await client.startCallToContact(contactId, { audio: true, video: true, pose: false }, personId);
    } catch (err: any) {
      setError({ code: "start_failed", message: err?.message ?? "Could not start the call" });
      setActiveContactName(null);
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

  const startGame = useCallback((g: CallGame = DEFAULT_SOCIAL_GAME) => {
    clientRef.current?.setGame(g);
  }, []);

  const stopGame = useCallback(() => {
    clientRef.current?.setGame(null);
  }, []);

  const sendWorld = useCallback((msgs: WorldNetMessage[]) => {
    clientRef.current?.sendWorldData(msgs);
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

  // Remote-audio activity: while any remote stream is making sound (the student
  // talking / button-press TTS), mark a short "active" window. The Web Speech
  // echo guard reads this to drop self-transcripts that are really our mic
  // hearing the call audio through the speakers.
  const remoteActiveUntilRef = useRef(0);
  useEffect(() => {
    if (callState !== "active" || remoteStreams.size === 0) return;
    const AudioCtx: any = (window as any).AudioContext || (window as any).webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    const sources: any[] = [];
    for (const stream of remoteStreams.values()) {
      if (stream.getAudioTracks().length === 0) continue;
      try { const src = ctx.createMediaStreamSource(stream); src.connect(analyser); sources.push(src); } catch { /* ignore */ }
    }
    const data = new Uint8Array(analyser.fftSize);
    const id = setInterval(() => {
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) { const v = (data[i] - 128) / 128; sum += v * v; }
      const rms = Math.sqrt(sum / data.length);
      if (rms > 0.02) remoteActiveUntilRef.current = Date.now() + 1500; // decay past the silence-stop window
    }, 100);
    return () => {
      clearInterval(id);
      sources.forEach((s) => { try { s.disconnect(); } catch { /* ignore */ } });
      try { void ctx.close(); } catch { /* ignore */ }
    };
  }, [callState, remoteStreams]);

  // While the call is active, transcribe the clinician's OWN speech and publish
  // it into the conversation room — so AAC students' Observers + Board Managers
  // perceive what's said (the student hears the raw audio, but the AI can't
  // transcribe a remote stream). PRIMARY: the browser Web Speech API — the same
  // recognizer the regular-chat mic uses; it captures the mic CLEANLY itself
  // (far better than raw PCM off the WebRTC call stream). FALLBACK (no Web
  // Speech, e.g. Firefox): stream PCM to the server's Google Cloud STT.
  const { language } = useLanguage();
  useEffect(() => {
    if (callState !== "active" || !audioEnabled) return;

    const SR: any = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (SR) {
      const recognition = new SR();
      recognition.lang = SPEECH_LANG[language] ?? "en-US";
      recognition.continuous = true;
      recognition.interimResults = true;
      let stopped = false;
      // In continuous mode Chrome often never emits a `final` on its own — it
      // just keeps streaming interims. So we detect a speech PAUSE (~1.2s with
      // no new interim) and call stop(), which forces the recognizer to finalize
      // the phrase → a `final` result fires → we send it → onend restarts us.
      const SILENCE_MS = 1200;
      let silenceTimer: ReturnType<typeof setTimeout> | null = null;
      const clearSilence = () => { if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null; } };
      recognition.onresult = (event: any) => {
        let interim = "";
        let final = "";
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const r = event.results[i];
          if (r.isFinal) final += r[0].transcript;
          else interim += r[0].transcript;
        }
        if (final.trim()) {
          clearSilence();
          setSelfTranscript(final.trim());
          // Echo guard: if remote call audio was just playing (e.g. the AAC
          // student's button-press TTS), this "phrase" is most likely our mic
          // hearing the speakers, not the clinician — don't publish it.
          if (Date.now() >= remoteActiveUntilRef.current) {
            clientRef.current?.sendUtterance(final.trim());
          } else {
            console.log("[CallContext] suppressed likely echo of remote audio:", final.trim());
          }
        } else if (interim) {
          setSelfTranscript(interim);
          clearSilence();
          silenceTimer = setTimeout(() => {
            silenceTimer = null;
            try { recognition.stop(); } catch { /* will restart via onend */ }
          }, SILENCE_MS);
        }
      };
      // Web Speech stops itself periodically (and on our pause-stop); restart
      // while the call is up so the next phrase is captured.
      recognition.onend = () => { if (!stopped) { try { recognition.start(); } catch { /* already running */ } } };
      recognition.onerror = (e: any) => {
        if (e?.error && e.error !== "no-speech" && e.error !== "aborted") {
          console.warn("[CallContext] speech recognition error:", e.error);
        }
      };
      try { recognition.start(); } catch { /* ignore */ }
      console.log("[CallContext] clinician speech via Web Speech API (lang=" + recognition.lang + ")");
      return () => { stopped = true; clearSilence(); try { recognition.stop(); } catch { /* ignore */ } };
    }

    // Fallback: server-side STT over streamed PCM.
    if (!localStream) return;
    console.log("[CallContext] Web Speech unavailable — falling back to server STT (call:audio)");
    const stop = streamMicPcm(localStream, (chunk, sampleRate) => {
      clientRef.current?.sendAudioChunk(chunk, sampleRate, language);
    });
    return stop;
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
    audioEnabled,
    videoEnabled,
    participants,
    addressee,
    setAddressee,
    addressedBy,
    selfTranscript,
    game,
    startGame,
    stopGame,
    sendWorld,
    worldHub: worldHubRef.current,
    publishPresence,
    presenceChannel: presenceChannelRef.current,
    getAudibleIds,
    peerGains,
    startCallWithContact,
    startCallToStudent,
    accept,
    decline,
    cancel,
    hangUp,
    toggleAudio,
    toggleVideo,
  }), [
    callState, incoming, selfPersonId, localStream, remoteStreams, remoteMedia,
    error, activeContactName, audioEnabled, videoEnabled, participants, addressee, setAddressee, addressedBy, selfTranscript,
    game, startGame, stopGame, sendWorld, publishPresence, getAudibleIds, peerGains,
    startCallWithContact, startCallToStudent, accept, decline, cancel, hangUp, toggleAudio, toggleVideo,
  ]);

  return <CallContext.Provider value={value}>{children}</CallContext.Provider>;
}

export function useCall(): CallContextValue {
  const ctx = useContext(CallContext);
  if (!ctx) throw new Error("useCall must be used within CallProvider");
  return ctx;
}
