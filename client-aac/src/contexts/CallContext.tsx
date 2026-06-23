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
import type { CallMediaFlags } from "@shared/realtime-events";
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
}

const CallContext = createContext<CallContextValue | null>(null);

export function CallProvider({ children }: { children: ReactNode }) {
  // studentId comes from the live-session context (the fronted student). The
  // CallClient only connects once it's known.
  const dual = useDualAgentContextOptional();
  const studentId = dual?.studentId ?? null;

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
        if (event.state === "active") everConnectedRef.current = true;
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
  }), [
    callState, incoming, selfPersonId, localStream, remoteStreams, activeContact,
    error, audioEnabled, videoEnabled, contacts, contactsLoading, refreshContacts,
    startCallToContact, accept, decline, cancel, hangUp, toggleAudio, toggleVideo,
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
