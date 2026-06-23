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

import type { CallMediaFlags, CallSignal } from "../realtime-events";

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
  | { type: "data"; personId: string; message: unknown }
  | { type: "ended"; callId: string; reason: string }
  | { type: "error"; code: string; message: string }
  // Conversation-room membership (clinician): current participants for the
  // addressee picker, and a notice that someone is now addressing us.
  | { type: "roster"; participants: Array<{ personId: string; name: string }> }
  | { type: "addressedBy"; fromPersonId: string; fromName: string }
  // Live STT transcript of our own speech (server-side recognition), for a
  // self-caption / debugging.
  | { type: "transcript"; text: string; isFinal: boolean };

interface PeerState {
  pc: RTCPeerConnection;
  polite: boolean;
  makingOffer: boolean;
  ignoreOffer: boolean;
  dataChannel?: RTCDataChannel;
}

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
  private peers = new Map<string, PeerState>();
  private localStream: MediaStream | null = null;
  private ringTimer: ReturnType<typeof setTimeout> | null = null;
  // Clinician (non-student) conversation-room membership for the call.
  private conversationJoined = false;

  constructor(private opts: CallClientOptions) {}

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
  async startCall(roomId: string, media: CallMediaFlags, remotePersonId?: string): Promise<void> {
    await this.ensureIceServers();
    const callId = crypto.randomUUID();
    this.call = { callId, roomId, media, remotePersonId };
    await this.acquireLocalMedia(media);
    this.send({ type: "call:invite", callId, roomId, media });
    this.setState("ringing-out");
    this.armRingTimeout(callId);
  }

  /** Start a call to one of the student's callable contacts (server resolves the room). */
  async startCallToContact(contactId: string, media: CallMediaFlags, remotePersonId?: string): Promise<void> {
    await this.ensureIceServers();
    const callId = crypto.randomUUID();
    this.call = { callId, media, remotePersonId };
    await this.acquireLocalMedia(media);
    this.send({ type: "call:invite-contact", callId, contactId, media });
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
    this.ensurePeer(inc.fromPersonId);
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

  toggleAudio(enabled: boolean): void { this.setTrackEnabled("audio", enabled); }
  toggleVideo(enabled: boolean): void { this.setTrackEnabled("video", enabled); }

  /** Declare who in the call this caller is addressing (a remote personId), or
   *  null to address everyone. Relayed into the conversation room so the
   *  addressed AAC student's AI can prepare to respond. */
  setAddressee(toPersonId: string | null): void {
    if (this.call) this.send({ type: "call:focus", callId: this.call.callId, to: toPersonId });
  }

  /** Publish this caller's transcribed speech (from the browser's Web Speech
   *  API) into the conversation room so AAC students' AIs perceive it. The
   *  primary path — the browser recognizer captures the mic cleanly itself.
   *  Non-student callers only. */
  sendUtterance(text: string): void {
    const t = text.trim();
    if (this.call && t) this.send({ type: "call:utterance", callId: this.call.callId, text: t });
  }

  /** FALLBACK (browsers without Web Speech, e.g. Firefox): stream this caller's
   *  mic PCM (base64 LINEAR16 mono @ sampleRate) to the server, which
   *  transcribes it via in-region Google Cloud STT and publishes the result. */
  sendAudioChunk(chunk: string, sampleRate: number, lang?: string): void {
    if (this.call && chunk) this.send({ type: "call:audio", callId: this.call.callId, chunk, sampleRate, ...(lang ? { lang } : {}) });
  }

  private setTrackEnabled(kind: "audio" | "video", enabled: boolean): void {
    if (!this.localStream || !this.call) return;
    const tracks = kind === "audio" ? this.localStream.getAudioTracks() : this.localStream.getVideoTracks();
    for (const t of tracks) t.enabled = enabled;
    const media = this.call.media;
    const next: CallMediaFlags = {
      audio: kind === "audio" ? enabled : media.audio,
      video: kind === "video" ? enabled : media.video,
      pose: media.pose,
    };
    this.call.media = next;
    this.send({ type: "call:media-state", callId: this.call.callId, ...next });
  }

  /** Send an AAC extra (utterance text/glyph, pose) over the data channel. */
  sendData(message: unknown): void {
    for (const peer of this.peers.values()) {
      if (peer.dataChannel?.readyState === "open") {
        try { peer.dataChannel.send(JSON.stringify(message)); } catch { /* ignore */ }
      }
    }
  }

  // ---------- Media ----------

  private async ensureIceServers(): Promise<void> {
    if (this.iceServers.length === 0) {
      try { this.iceServers = await this.opts.getIceServers(); }
      catch { this.iceServers = [{ urls: "stun:stun.l.google.com:19302" }]; }
    }
  }

  private async acquireLocalMedia(media: CallMediaFlags): Promise<void> {
    if (this.localStream) return;
    const constraints: MediaStreamConstraints = { audio: media.audio, video: media.video };
    if (!media.audio && !media.video) return;
    try {
      this.localStream = await navigator.mediaDevices.getUserMedia(constraints);
      this.opts.emit({ type: "localStream", stream: this.localStream });
    } catch (err: any) {
      this.opts.emit({ type: "error", code: "media_denied", message: err?.message ?? "Camera/mic unavailable" });
      throw err;
    }
  }

  // ---------- Peer connections (perfect negotiation) ----------

  private ensurePeer(remotePersonId: string): PeerState {
    let peer = this.peers.get(remotePersonId);
    if (peer) return peer;

    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    // Politeness: deterministic by personId so exactly one side is impolite.
    const polite = (this.selfPersonId ?? "") < remotePersonId;
    peer = { pc, polite, makingOffer: false, ignoreOffer: false };
    this.peers.set(remotePersonId, peer);

    if (this.localStream) {
      for (const track of this.localStream.getTracks()) pc.addTrack(track, this.localStream);
    }

    // Impolite peer owns the data channel; polite peer receives it.
    if (!polite) {
      peer.dataChannel = pc.createDataChannel("aac");
      this.wireDataChannel(peer.dataChannel, remotePersonId);
    }
    pc.ondatachannel = (ev) => {
      peer!.dataChannel = ev.channel;
      this.wireDataChannel(ev.channel, remotePersonId);
    };

    pc.onnegotiationneeded = async () => {
      try {
        peer!.makingOffer = true;
        await pc.setLocalDescription();
        this.send({ type: "call:signal", callId: this.call!.callId, to: remotePersonId, signal: { description: pc.localDescription } as CallSignal });
      } catch (err) {
        console.error("[call-client] negotiation error:", err);
      } finally {
        peer!.makingOffer = false;
      }
    };

    pc.onicecandidate = ({ candidate }) => {
      if (candidate) {
        this.send({ type: "call:signal", callId: this.call!.callId, to: remotePersonId, signal: { candidate } as CallSignal });
      }
    };

    pc.ontrack = ({ streams }) => {
      if (streams[0]) this.opts.emit({ type: "remoteStream", personId: remotePersonId, stream: streams[0] });
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "connected") this.setState("active");
      if (pc.connectionState === "failed") {
        this.opts.emit({ type: "error", code: "connection", message: "Peer connection failed" });
      }
    };

    return peer;
  }

  private wireDataChannel(channel: RTCDataChannel, remotePersonId: string): void {
    channel.onmessage = (ev) => {
      let parsed: unknown;
      try { parsed = JSON.parse(ev.data); } catch { parsed = ev.data; }
      this.opts.emit({ type: "data", personId: remotePersonId, message: parsed });
    };
  }

  private async handleSignal(fromPersonId: string, signal: CallSignal): Promise<void> {
    const peer = this.ensurePeer(fromPersonId);
    const { pc } = peer;
    const description = (signal as any).description as RTCSessionDescriptionInit | undefined;
    const candidate = (signal as any).candidate as RTCIceCandidateInit | undefined;

    try {
      if (description) {
        const offerCollision = description.type === "offer" && (peer.makingOffer || pc.signalingState !== "stable");
        peer.ignoreOffer = !peer.polite && offerCollision;
        if (peer.ignoreOffer) return;

        await pc.setRemoteDescription(description);
        if (description.type === "offer") {
          await pc.setLocalDescription();
          this.send({ type: "call:signal", callId: this.call!.callId, to: fromPersonId, signal: { description: pc.localDescription } as CallSignal });
        }
      } else if (candidate) {
        try { await pc.addIceCandidate(candidate); }
        catch (err) { if (!peer.ignoreOffer) throw err; }
      }
    } catch (err) {
      console.error("[call-client] signal handling error:", err);
    }
  }

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
        this.incoming = msg.payload as IncomingCall;
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
        if (this.call && pid !== this.selfPersonId) this.ensurePeer(pid);
        break;
      }

      case "call:signal": {
        const { fromPersonId, toPersonId, signal } = msg.payload;
        if (toPersonId !== this.selfPersonId) break; // not addressed to us
        await this.handleSignal(fromPersonId, signal);
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
        this.closePeer(msg.payload.personId);
        break;

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

  private closePeer(personId: string): void {
    const peer = this.peers.get(personId);
    if (peer) {
      try { peer.dataChannel?.close(); } catch { /* ignore */ }
      try { peer.pc.close(); } catch { /* ignore */ }
      this.peers.delete(personId);
    }
  }

  private teardownCall(reason: string): void {
    this.clearRingTimeout();
    const callId = this.call?.callId;
    // Leave the conversation room (clinician) before dropping the call.
    if (this.conversationJoined && callId) {
      this.send({ type: "call:conversation", join: false, callId });
    }
    this.conversationJoined = false;
    for (const personId of Array.from(this.peers.keys())) this.closePeer(personId);
    if (this.localStream) {
      for (const t of this.localStream.getTracks()) t.stop();
      this.localStream = null;
    }
    this.call = null;
    this.incoming = null;
    if (callId) this.opts.emit({ type: "ended", callId, reason });
    this.setState("idle");
  }
}
