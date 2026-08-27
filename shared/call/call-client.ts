// shared/call/call-client.ts
// Framework-agnostic WebRTC call client, shared by the clinician and AAC clients.
//
// Responsibilities:
//   - Maintain the /ws/call WebSocket (reconnecting), speak the signaling
//     protocol (invite/accept/decline/cancel/signal/media-state/leave).
//   - Manage one RTCPeerConnection per remote peer using *perfect negotiation*
//     (politeness decided by personId ordering), so simultaneous offers resolve
//     without a custom lock.
//   - Capture local media, surface remote streams, and expose an optional
//     data channel for AAC extras (sent sentence text, glyph, pose).
//
// The server never sees media — it only relays SDP/ICE. This class is the only
// place that touches RTCPeerConnection; React hooks wrap it per app.

import type { CallGame, CallMediaFlags, CallSignal } from "../realtime-events";
import type { WorldPresence } from "../social-world/world-presence";
import { PeerMesh } from "../rtc/peer-mesh";
import { createCallAudioMixer, type CallAudioMixer } from "./audio-mixer";

export type CallState =
  | "idle"
  | "ringing-out" // we invited, waiting for accept
  | "ringing-in"  // we're being rung
  | "connecting"  // accepted, establishing peer connection
  | "active"      // media flowing
  | "ended";

export interface IncomingCall {
  callId: string;
  roomId: string;
  fromPersonId: string;
  fromName?: string;
  media: CallMediaFlags;
  /** The inviter marked this invite "automatic" — the AAC opens it without ringing. */
  autoAccept?: boolean;
  /** The caller's stored-face photo (data URL), when available — shown on the ring. */
  photo?: string;
}

/** Events the client emits to its host (React hook, etc.). */
export type CallClientEvent =
  | { type: "ready"; selfPersonId: string }
  | { type: "incoming"; call: IncomingCall }
  | { type: "state"; state: CallState }
  | { type: "localStream"; stream: MediaStream }
  | { type: "remoteStream"; personId: string; stream: MediaStream }
  | { type: "mediaState"; personId: string; media: CallMediaFlags }
  | { type: "peerLeft"; personId: string }
  // A social game was attached to (or detached from, game=null) the call. The
  // host turns the call panel into the game surface.
  | { type: "game"; game: CallGame | null }
  | { type: "data"; personId: string; message: unknown }
  | { type: "worldData"; personId: string; message: unknown }
  // An NPC-conversation message relayed by `fromPersonId` over the reliable
  // server channel (reaches every participant, unlike the proximity-pruned mesh).
  | { type: "npcData"; fromPersonId: string; message: unknown }
  // A peer's relayed avatar position (world-wide position channel, NOT the mesh).
  | { type: "presence"; personId: string; presence: WorldPresence }
  | { type: "ended"; callId: string; reason: string }
  | { type: "error"; code: string; message: string }
  // Conversation-room membership (clinician): current participants for the
  // addressee picker, and a notice that someone is now addressing us.
  | { type: "roster"; participants: Array<{ personId: string; name: string; photo?: string }> }
  | { type: "addressedBy"; fromPersonId: string; fromName: string }
  // Live STT transcript of our own speech (server-side recognition), for a
  // self-caption / debugging.
  | { type: "transcript"; text: string; isFinal: boolean };

interface ActiveCall {
  callId: string;
  roomId?: string;
  media: CallMediaFlags;
  /** Remote person we expect to connect to (the other side, 1:1). */
  remotePersonId?: string;
}

const RING_TIMEOUT_MS = 35_000; // caller-side fallback (server's is 30s; Lambda may not fire it)

export interface CallClientOptions {
  wsUrl: string;
  getIceServers: () => Promise<RTCIceServer[]>;
  emit: (event: CallClientEvent) => void;
  /** AAC only: act as the student being fronted, rather than the logged-in user. */
  actAsStudentId?: string;
  /** AAC only: the student's "voice" is synthesized (TTS), not a microphone.
   *  Return an audio track carrying that synthesized voice and it is MIXED with
   *  the microphone into the single outgoing audio track (see audio-mixer.ts) —
   *  never added as a second track, which receivers silently drop. Pulled lazily
   *  when local media is acquired. Return null when there's nothing to mix. */
  getAppAudioTrack?: () => MediaStreamTrack | null;
}

export class CallClient {
  private ws: WebSocket | null = null;
  private closed = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private backoffMs = 1000;

  private selfPersonId: string | null = null;
  private iceServers: RTCIceServer[] = [];

  private state: CallState = "idle";
  private call: ActiveCall | null = null;
  private incoming: IncomingCall | null = null;
  private mesh: PeerMesh;
  private localStream: MediaStream | null = null;
  /** The raw getUserMedia capture. When a mixer is in play `localStream` is a
   *  COMPOSED stream (camera + one mixed audio track), so the capture is kept
   *  separately — it is what teardown has to stop. */
  private capturedStream: MediaStream | null = null;
  private audioMixer: CallAudioMixer | null = null;
  private screenStream: MediaStream | null = null;
  private currentGame: CallGame | null = null;
  private ringTimer: ReturnType<typeof setTimeout> | null = null;
  // Clinician (non-student) conversation-room membership for the call.
  private conversationJoined = false;

  constructor(private opts: CallClientOptions) {
    this.mesh = new PeerMesh({
      getSelfId: () => this.selfPersonId,
      sendSignal: (to: string, signal: CallSignal) => {
        if (this.call) this.send({ type: "call:signal", callId: this.call.callId, to, signal });
      },
      onRemoteStream: (personId, stream) => this.opts.emit({ type: "remoteStream", personId, stream }),
      onData: (personId, message) => this.opts.emit({ type: "data", personId, message }),
      onWorldData: (personId, message) => this.opts.emit({ type: "worldData", personId, message }),
      onPeerConnected: () => this.setState("active"),
      onPeerFailed: () => this.opts.emit({ type: "error", code: "connection", message: "Peer connection failed" }),
    });
  }

  // ---------- Connection ----------

  connect(): void {
    this.closed = false;
    this.openSocket();
  }

  disconnect(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.teardownCall("disconnected");
    try { this.ws?.close(); } catch { /* ignore */ }
    this.ws = null;
  }

  private openSocket(): void {
    if (this.closed) return;
    const ws = new WebSocket(this.opts.wsUrl);
    this.ws = ws;
    ws.onopen = () => {
      this.backoffMs = 1000;
      // AAC: declare the student we're acting as before doing anything else.
      if (this.opts.actAsStudentId) {
        ws.send(JSON.stringify({ type: "call:act-as", studentId: this.opts.actAsStudentId }));
      }
    };
    ws.onmessage = (e) => {
      let msg: any;
      try { msg = JSON.parse(e.data); } catch { return; }
      this.handleServerMessage(msg).catch((err) => console.error("[call-client] handle error:", err));
    };
    ws.onclose = () => {
      if (this.closed) return;
      this.reconnectTimer = setTimeout(() => this.openSocket(), this.backoffMs);
      this.backoffMs = Math.min(this.backoffMs * 2, 30000);
    };
    ws.onerror = () => { try { ws.close(); } catch { /* ignore */ } };
  }

  private send(payload: Record<string, unknown>): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    }
  }

  private setState(state: CallState): void {
    this.state = state;
    this.opts.emit({ type: "state", state });
    // A non-student (clinician) caller joins the conversation room for the call
    // on the first live state, so they appear in AAC students' rosters and
    // receive roster + addressee updates. AAC students join via dual-agent.
    if (
      !this.opts.actAsStudentId &&
      !this.conversationJoined &&
      this.call &&
      state !== "idle" &&
      state !== "ended"
    ) {
      this.conversationJoined = true;
      this.send({ type: "call:conversation", join: true, callId: this.call.callId });
    }
  }

  getState(): CallState { return this.state; }
  getSelfPersonId(): string | null { return this.selfPersonId; }
  /** Shared id of the active call (same value for every participant). Used as
   *  the group-chat conversation-room key. */
  getCallId(): string | null { return this.call?.callId ?? null; }

  // ---------- Outgoing actions ----------

  /** Start a call to everyone in a room. */
  async startCall(roomId: string, media: CallMediaFlags, remotePersonId?: string, autoAccept?: boolean): Promise<void> {
    await this.ensureIceServers();
    const callId = crypto.randomUUID();
    this.call = { callId, roomId, media, remotePersonId };
    await this.acquireLocalMedia(media);
    this.send({ type: "call:invite", callId, roomId, media, autoAccept });
    this.setState("ringing-out");
    this.armRingTimeout(callId);
  }

  /** Start a call to one of the student's callable contacts (server resolves the room). */
  async startCallToContact(contactId: string, media: CallMediaFlags, remotePersonId?: string, autoAccept?: boolean): Promise<void> {
    await this.ensureIceServers();
    const callId = crypto.randomUUID();
    this.call = { callId, media, remotePersonId };
    await this.acquireLocalMedia(media);
    this.send({ type: "call:invite-contact", callId, contactId, media, autoAccept });
    this.setState("ringing-out");
    this.armRingTimeout(callId);
  }

  /** Accept the current incoming call. */
  async accept(): Promise<void> {
    if (!this.incoming) return;
    await this.ensureIceServers();
    const inc = this.incoming;
    this.call = { callId: inc.callId, roomId: inc.roomId, media: inc.media, remotePersonId: inc.fromPersonId };
    await this.acquireLocalMedia(inc.media);
    this.send({ type: "call:accept", callId: inc.callId });
    this.setState("connecting");
    // The caller is already present — establish the peer connection now and let
    // perfect negotiation drive the offer/answer.
    this.mesh.connect(inc.fromPersonId);
    this.incoming = null;
  }

  declineIncoming(reason?: string): void {
    if (!this.incoming) return;
    this.send({ type: "call:decline", callId: this.incoming.callId, reason });
    this.incoming = null;
    this.setState("idle");
  }

  cancel(): void {
    if (this.call && this.state === "ringing-out") {
      this.send({ type: "call:cancel", callId: this.call.callId });
    }
    this.teardownCall("cancelled");
  }

  hangUp(): void {
    if (this.call) this.send({ type: "call:leave", callId: this.call.callId });
    this.teardownCall("ended");
  }

  /** The call MICROPHONE — the room this participant is in. Never touches the
   *  student's synthesized voice: a child whose only channel is TTS must not be
   *  silenceable by a control labelled "mic" (the mixer keeps the two on
   *  separate gains precisely so this stays true). */
  toggleAudio(enabled: boolean): void { this.setTrackEnabled("audio", enabled); }
  toggleVideo(enabled: boolean): void { this.setTrackEnabled("video", enabled); }

  /** Declare who in the call this caller is addressing (a remote personId), or
   *  null to address everyone. Relayed into the conversation room so the
   *  addressed AAC student's AI can prepare to respond. */
  setAddressee(toPersonId: string | null): void {
    if (this.call) this.send({ type: "call:focus", callId: this.call.callId, to: toPersonId });
  }

  /** Stream this caller's mic PCM (base64 LINEAR16 mono @ sampleRate) to the
   *  server, which transcribes it with in-region Google Cloud STT and publishes
   *  each phrase into the conversation room.
   *
   *  THE ONLY transcription path for a non-student caller. The browser's Web
   *  Speech API used to be preferred and was removed: it routes clinical audio
   *  through Google's consumer service (a PHI/data-residency regression) and it
   *  recognises its OWN raw capture, so it hears the far end through the
   *  speakers — which is what the unwinnable "echo guard" existed to paper over.
   *  What we send here is the AEC-processed call track. */
  sendAudioChunk(chunk: string, sampleRate: number, lang?: string): void {
    // `t` is OUR clock at the moment the chunk was produced. The server compares
    // successive t's (deltas only, so clock skew is irrelevant) against its own
    // arrival times, which is the only way to tell "the client stopped producing
    // audio" apart from "the audio was produced but reached us late". Without
    // it a stalled stream is indistinguishable from a silent one.
    if (this.call && chunk) {
      this.send({
        type: "call:audio",
        callId: this.call.callId,
        chunk,
        sampleRate,
        t: Date.now(),
        ...(lang ? { lang } : {}),
      });
    }
  }

  private setTrackEnabled(kind: "audio" | "video", enabled: boolean): void {
    if (!this.localStream || !this.call) return;
    if (kind === "audio" && this.audioMixer) {
      // Mixed path: mute the MIC SOURCE, not the outgoing track. Disabling the
      // outgoing track here would silence the student's voice along with the
      // room — the exact conflation this rework removes.
      this.audioMixer.setMicEnabled(enabled);
    } else {
      const tracks = kind === "audio" ? this.localStream.getAudioTracks() : this.localStream.getVideoTracks();
      for (const t of tracks) t.enabled = enabled;
    }
    const media = this.call.media;
    const next: CallMediaFlags = {
      audio: kind === "audio" ? enabled : media.audio,
      video: kind === "video" ? enabled : media.video,
      pose: media.pose,
    };
    this.call.media = next;
    this.send({ type: "call:media-state", callId: this.call.callId, ...next });
  }

  /** Send an AAC extra (utterance text/glyph, pose) over the reliable channel. */
  sendData(message: unknown): void {
    this.mesh.sendData(message);
  }

  // ---------- Screen share (getDisplayMedia) ----------
  // The screen is added as an EXTRA outgoing video track (its own MediaStream)
  // alongside the camera, so it arrives at peers as a SEPARATE `ontrack` stream.
  // We announce its stream id over the reliable channel so the receiver can tell
  // the screen apart from the camera (both share the same personId).

  /** True while this client is capturing+sending its screen. */
  isScreenSharing(): boolean { return !!this.screenStream; }

  /** Begin capturing this device's screen and send it into the call. No-op
   *  outside a call or if already sharing. Throws if the user denies capture. */
  async startScreenShare(): Promise<void> {
    if (!this.call || this.screenStream) return;
    const stream = await (navigator.mediaDevices as any).getDisplayMedia({ video: true, audio: false });
    this.screenStream = stream;
    const track = stream.getVideoTracks()[0];
    if (!track) { this.stopScreenShare(); return; }
    // The user can stop sharing from the browser's own UI — mirror that here.
    track.addEventListener("ended", () => this.stopScreenShare());
    this.mesh.addTrack(track, stream);
    this.sendData({ k: "screen-share", on: true, streamId: stream.id, at: Date.now() });
  }

  /** Stop capturing/sending the screen. */
  stopScreenShare(): void {
    if (!this.screenStream) return;
    const stream = this.screenStream;
    this.screenStream = null;
    for (const t of stream.getVideoTracks()) this.mesh.removeTrack(t);
    for (const t of stream.getTracks()) t.stop();
    this.sendData({ k: "screen-share", on: false, streamId: stream.id, at: Date.now() });
  }

  /** Ask the OTHER side to start/stop sharing their screen (clinician → AAC). */
  requestScreenShare(on: boolean): void {
    this.sendData({ k: "screen-request", on, at: Date.now() });
  }

  /** Broadcast high-frequency world state over the unreliable channel. Dropped
   *  packets are never retransmitted — a fresher position supersedes them. */
  sendWorldData(message: unknown): void {
    this.mesh.sendWorldData(message);
  }

  /** Relay this client's avatar position over the world-wide position channel
   *  (server-fanned to every call participant, independent of the media mesh).
   *  Cheap + lossy; a fresher position supersedes. No-op outside a call. */
  publishPresence(presence: WorldPresence): void {
    if (this.call) this.send({ type: "call:world", callId: this.call.callId, presence });
  }

  /** Broadcast an NPC-conversation message (NpcNetMessage) over the reliable server
   *  relay — reaches every call participant regardless of mesh proximity pruning.
   *  Used to share AI-NPC speech/state/audio/positions. No-op outside a call. */
  sendNpc(msg: unknown): void {
    if (this.call) this.send({ type: "call:npc", callId: this.call.callId, msg });
  }

  // ---------- Proximity-gated media (Phase 2 conversation circles) ----------
  // The baseline mesh connects every participant on join; in a conversation-circle
  // world a controller (CallContext) prunes peers who wander out of range and
  // re-opens them when they return, using these to drive the existing PeerMesh.

  /** Person ids of peers with a live (open or connecting) mesh connection. */
  connectedPeerIds(): string[] {
    return this.mesh.peerIds();
  }

  /** Open (or reuse) a connection to a specific participant. No-op outside a call. */
  connectPeer(personId: string): void {
    if (this.call && personId !== this.selfPersonId) this.mesh.connect(personId);
  }

  /** Close the connection to a participant who has left our circle. They remain
   *  in the call — proximity may reconnect them later. */
  disconnectPeer(personId: string): void {
    this.mesh.removePeer(personId);
  }

  /** Attach (or, with null, detach) a social game on the current call. The
   *  server broadcasts call:game to every participant, turning the call panel
   *  into the game surface. No-op outside a call. */
  setGame(game: CallGame | null): void {
    if (this.call) this.send({ type: "call:set-game", callId: this.call.callId, game });
  }

  /** The game currently attached to the call (null = plain video chat). Lets a
   *  late-mounting UI read state instead of waiting for the next event. */
  getGame(): CallGame | null {
    return this.currentGame;
  }

  /** Open a SOLO game: a joinable one-person room with a game, no ring. We go
   *  straight to "active" (no peer yet); friends can be invited in later. No
   *  local media is acquired up front — inviteIntoCall acquires it on demand. */
  async startSoloGameCall(game: CallGame): Promise<void> {
    await this.ensureIceServers();
    const callId = crypto.randomUUID();
    this.call = { callId, media: { audio: false, video: false, pose: false } };
    this.currentGame = game;
    this.send({ type: "call:start-solo-game", callId, game });
    this.setState("active");
    this.opts.emit({ type: "game", game });
  }

  /** Ring a contact INTO the current call (grow a solo game into multiplayer).
   *  Acquires audio/video first so joiners get media. No-op outside a call. */
  async inviteIntoCall(contactId: string, autoAccept?: boolean): Promise<void> {
    if (!this.call) return;
    const media: CallMediaFlags = { audio: true, video: true, pose: false };
    await this.acquireLocalMedia(media);
    this.call.media = media;
    this.send({ type: "call:invite-into-call", callId: this.call.callId, contactId, media, autoAccept });
  }

  /** Ring a specific PERSON into the current call (clinician multi-party invite —
   *  works for any institute person, not just callable contacts). `autoAccept`
   *  asks an AAC client to open the call without ringing. No-op outside a call. */
  async inviteIntoCallPerson(personId: string, autoAccept?: boolean): Promise<void> {
    if (!this.call) return;
    const media: CallMediaFlags = { audio: true, video: true, pose: false };
    await this.acquireLocalMedia(media);
    this.call.media = media;
    this.send({ type: "call:invite-person", callId: this.call.callId, personId, media, autoAccept });
  }

  // ---------- Media ----------

  private async ensureIceServers(): Promise<void> {
    if (this.iceServers.length === 0) {
      try { this.iceServers = await this.opts.getIceServers(); }
      catch { this.iceServers = [{ urls: "stun:stun.l.google.com:19302" }]; }
    }
    this.mesh.setIceServers(this.iceServers);
  }

  private async acquireLocalMedia(media: CallMediaFlags): Promise<void> {
    if (this.localStream) return;
    if (!media.audio && !media.video) return;
    // Echo cancellation stated explicitly rather than left to the browser
    // default: the far end's audio coming back out of these speakers is the
    // single biggest source of noise on an AAC call.
    // NOTE: noiseSuppression is deliberately NOT set here. For this population
    // the non-speech vocalisations it strips are clinically meaningful signal —
    // it belongs in per-student settings, not a hardcoded default.
    const constraints: MediaStreamConstraints = {
      audio: media.audio ? { echoCancellation: true } : false,
      video: media.video,
    };
    try {
      const captured = await navigator.mediaDevices.getUserMedia(constraints);
      this.capturedStream = captured;

      const micTrack = captured.getAudioTracks()[0] ?? null;
      // The AAC's synthesized voice — how the student actually speaks.
      const voiceTrack = this.opts.getAppAudioTrack?.() ?? null;

      let outgoingAudio: MediaStreamTrack | null = micTrack;
      if (!voiceTrack && this.opts.getAppAudioTrack) {
        // This client declared it HAS a synthesized voice (only the AAC does)
        // and then produced no track for it. Silently sending mic-only here is
        // precisely the reported bug — the student presses buttons and the far
        // end hears nothing — so it must never be silent again.
        console.error("[call-client] AAC has NO voice track for this call — button presses will NOT be heard by the other side");
        this.opts.emit({
          type: "error",
          code: "no_voice_track",
          message: "The student's voice is not being sent on this call",
        });
      }
      if (voiceTrack) {
        // Two sources → ONE track. Adding the voice as a second track means the
        // receiver renders only one of them, picked by random track id.
        this.audioMixer = createCallAudioMixer({ micTrack, voiceTrack });
        if (this.audioMixer) {
          outgoingAudio = this.audioMixer.track;
        } else {
          // Web Audio missing (should be unreachable anywhere WebRTC runs).
          // Degrade to the VOICE, not the mic: a student who cannot be heard
          // speaking has lost the point of the device. Never fall back to
          // sending both as separate tracks — that is the original defect.
          console.warn("[call-client] audio mixer unavailable — sending the student's voice only");
          outgoingAudio = voiceTrack;
        }
      }

      this.localStream = new MediaStream([
        ...captured.getVideoTracks(),
        ...(outgoingAudio ? [outgoingAudio] : []),
      ]);
      this.mesh.setLocalStream(this.localStream);
      this.opts.emit({ type: "localStream", stream: this.localStream });
    } catch (err: any) {
      this.opts.emit({ type: "error", code: "media_denied", message: err?.message ?? "Camera/mic unavailable" });
      throw err;
    }
  }

  // Peer connections (perfect negotiation, both data channels) live in PeerMesh.
  // CallClient drives it via this.mesh and relays call:signal into
  // mesh.handleSignal. The "world" data channel carries social-game state when a
  // call has a game attached.

  // ---------- Server message handling ----------

  private async handleServerMessage(msg: any): Promise<void> {
    switch (msg?.type) {
      case "call:ready":
        this.selfPersonId = msg.selfPersonId;
        this.opts.emit({ type: "ready", selfPersonId: msg.selfPersonId });
        break;

      case "call:ringing": {
        // Ignore a ring for a call we're already in.
        if (this.call) break;
        const p = msg.payload as IncomingCall & { fromPhoto?: string };
        // The wire carries the caller photo as `fromPhoto`; expose it as `photo`.
        this.incoming = { ...p, photo: p.fromPhoto ?? p.photo };
        this.opts.emit({ type: "incoming", call: this.incoming });
        this.setState("ringing-in");
        break;
      }

      case "call:accepted":
        // Promote the caller ringing-out → connecting. NEVER regress: this
        // broadcast can arrive AFTER signaling has already connected (offer/ICE
        // race ahead of the accept fan-out through the concurrent WS handlers),
        // and resetting to "connecting" here was wedging the caller's UI even
        // though the peer connection was fully established.
        if (this.call && msg.payload.byPersonId !== this.selfPersonId && this.state === "ringing-out") {
          this.setState("connecting");
        }
        break;

      case "call:peer-joined": {
        const pid = msg.payload.personId as string;
        if (this.call && pid !== this.selfPersonId) this.mesh.connect(pid);
        break;
      }

      case "call:signal": {
        const { fromPersonId, toPersonId, signal } = msg.payload;
        if (toPersonId !== this.selfPersonId) break; // not addressed to us
        await this.mesh.handleSignal(fromPersonId, signal);
        break;
      }

      case "call:media-state": {
        const { personId, audio, video, pose } = msg.payload;
        if (personId !== this.selfPersonId) {
          this.opts.emit({ type: "mediaState", personId, media: { audio, video, pose } });
        }
        break;
      }

      case "call:peer-left":
        this.opts.emit({ type: "peerLeft", personId: msg.payload.personId });
        this.mesh.removePeer(msg.payload.personId);
        break;

      case "call:game": {
        const game = (msg.payload?.game ?? null) as CallGame | null;
        this.currentGame = game;
        this.opts.emit({ type: "game", game });
        break;
      }

      case "call:world": {
        const { personId, presence } = msg.payload as { personId: string; presence: WorldPresence };
        // The server echoes to the whole call topic, including us — skip our own.
        if (personId !== this.selfPersonId) this.opts.emit({ type: "presence", personId, presence });
        break;
      }

      case "call:npc": {
        const { fromPersonId, msg: npcMsg } = msg.payload as { fromPersonId: string; msg: unknown };
        // Echoed to the whole topic including us — skip our own (the sender already
        // applied it locally; this avoids double-processing our own broadcasts).
        if (fromPersonId !== this.selfPersonId) this.opts.emit({ type: "npcData", fromPersonId, message: npcMsg });
        break;
      }

      case "call:declined":
        this.teardownCall("declined");
        break;

      case "call:cancelled":
        this.incoming = null;
        this.teardownCall("cancelled");
        break;

      case "call:ended":
        this.teardownCall(msg.payload?.reason ?? "ended");
        break;

      case "call:error":
        this.opts.emit({ type: "error", code: msg.payload?.code ?? "error", message: msg.payload?.message ?? "Call error" });
        break;

      case "call:roster":
        this.opts.emit({ type: "roster", participants: Array.isArray(msg.participants) ? msg.participants : [] });
        break;

      case "call:addressed":
        this.opts.emit({ type: "addressedBy", fromPersonId: msg.fromPersonId, fromName: msg.fromName });
        break;

      case "call:transcript":
        this.opts.emit({ type: "transcript", text: msg.text ?? "", isFinal: !!msg.isFinal });
        break;
    }
  }

  // ---------- Teardown ----------

  private armRingTimeout(callId: string): void {
    this.clearRingTimeout();
    this.ringTimer = setTimeout(() => {
      if (this.call?.callId === callId && this.state === "ringing-out") this.cancel();
    }, RING_TIMEOUT_MS);
  }

  private clearRingTimeout(): void {
    if (this.ringTimer) { clearTimeout(this.ringTimer); this.ringTimer = null; }
  }

  private teardownCall(reason: string): void {
    this.clearRingTimeout();
    const callId = this.call?.callId;
    // Leave the conversation room (clinician) before dropping the call.
    if (this.conversationJoined && callId) {
      this.send({ type: "call:conversation", join: false, callId });
    }
    this.conversationJoined = false;
    this.mesh.closeAll();
    if (this.screenStream) {
      for (const t of this.screenStream.getTracks()) t.stop();
      this.screenStream = null;
    }
    // Order matters: close the mixer first (it stops its own voice clone and the
    // mixed output track), then stop the raw capture. `localStream` may be a
    // COMPOSED stream whose audio track the mixer already owns, so stopping it
    // alone would leave the microphone running.
    this.audioMixer?.close();
    this.audioMixer = null;
    if (this.localStream) {
      for (const t of this.localStream.getTracks()) t.stop();
      this.localStream = null;
    }
    if (this.capturedStream) {
      for (const t of this.capturedStream.getTracks()) t.stop();
      this.capturedStream = null;
    }
    this.mesh.setLocalStream(null);
    this.call = null;
    this.incoming = null;
    this.currentGame = null;
    if (callId) this.opts.emit({ type: "ended", callId, reason });
    this.setState("idle");
  }
}
