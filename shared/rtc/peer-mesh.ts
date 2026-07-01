// shared/rtc/peer-mesh.ts
//
// The reusable WebRTC peer-mesh core, shared by live calls and game rooms.
// Owns one RTCPeerConnection per remote peer with *perfect negotiation*
// (politeness decided by personId ordering), the reliable "aac" data channel,
// and the unreliable "world" data channel. It is transport-agnostic: the host
// supplies how to SEND a signal to a peer and is notified of streams / data /
// connection state via callbacks. The host decides WHEN to connect (calls
// `connect(peerId)` on ring-accept / peer-joined) and feeds inbound signals to
// `handleSignal`.
//
// Extracted from call-client.ts; CallClient drives this mesh over the call
// signaling. The same mesh also carries social-game world state (the unreliable
// "world" data channel) when a call has a game attached.

import type { CallSignal } from "../realtime-events";

export interface PeerMeshOptions {
  /** This client's stable person id — perfect-negotiation politeness. */
  getSelfId: () => string | null;
  /** Send an opaque WebRTC signal to one peer over the app's transport. */
  sendSignal: (toPersonId: string, signal: CallSignal) => void;
  onRemoteStream?: (personId: string, stream: MediaStream) => void;
  /** Reliable channel message (utterance text/glyph, pose). */
  onData?: (personId: string, message: unknown) => void;
  /** Unreliable channel message (high-frequency world state). */
  onWorldData?: (personId: string, message: unknown) => void;
  onPeerConnected?: (personId: string) => void;
  onPeerFailed?: (personId: string) => void;
}

interface PeerState {
  pc: RTCPeerConnection;
  polite: boolean;
  makingOffer: boolean;
  ignoreOffer: boolean;
  dataChannel?: RTCDataChannel;
  worldChannel?: RTCDataChannel;
}

export class PeerMesh {
  private peers = new Map<string, PeerState>();
  private iceServers: RTCIceServer[] = [];
  private localStream: MediaStream | null = null;
  // Extra outgoing tracks beyond the camera/mic stream (e.g. a screen-share),
  // kept so peers that connect LATER also receive them. Keyed by track.
  private extraTracks = new Map<MediaStreamTrack, MediaStream>();

  constructor(private opts: PeerMeshOptions) {}

  setIceServers(servers: RTCIceServer[]): void {
    this.iceServers = servers;
  }

  /** Set/replace the local media stream. New peers get the tracks at creation;
   *  existing peers get them added now (renegotiation follows). Pass null to
   *  detach (teardown). */
  setLocalStream(stream: MediaStream | null): void {
    this.localStream = stream;
    if (!stream) return;
    for (const peer of this.peers.values()) {
      const senders = peer.pc.getSenders();
      for (const track of stream.getTracks()) {
        if (!senders.some((s) => s.track === track)) peer.pc.addTrack(track, stream);
      }
    }
  }

  peerIds(): string[] {
    return Array.from(this.peers.keys());
  }

  /** Add an extra outgoing track (in its own stream) to every peer — used for a
   *  screen-share alongside the camera. Renegotiation follows automatically.
   *  Remembered so peers that join later also get it. */
  addTrack(track: MediaStreamTrack, stream: MediaStream): void {
    this.extraTracks.set(track, stream);
    for (const peer of this.peers.values()) {
      if (!peer.pc.getSenders().some((s) => s.track === track)) {
        try { peer.pc.addTrack(track, stream); } catch { /* ignore */ }
      }
    }
  }

  /** Remove a previously-added extra track from every peer. */
  removeTrack(track: MediaStreamTrack): void {
    this.extraTracks.delete(track);
    for (const peer of this.peers.values()) {
      const sender = peer.pc.getSenders().find((s) => s.track === track);
      if (sender) { try { peer.pc.removeTrack(sender); } catch { /* ignore */ } }
    }
  }

  /** Open (or reuse) a connection to a remote peer. */
  connect(remotePersonId: string): void {
    this.ensurePeer(remotePersonId);
  }

  private ensurePeer(remotePersonId: string): PeerState {
    let peer = this.peers.get(remotePersonId);
    if (peer) return peer;

    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    // Politeness: deterministic by personId so exactly one side is impolite.
    const polite = (this.opts.getSelfId() ?? "") < remotePersonId;
    peer = { pc, polite, makingOffer: false, ignoreOffer: false };
    this.peers.set(remotePersonId, peer);

    if (this.localStream) {
      for (const track of this.localStream.getTracks()) pc.addTrack(track, this.localStream);
    }
    // Extra tracks (e.g. an in-progress screen-share) so late joiners get them.
    for (const [track, stream] of this.extraTracks) {
      try { pc.addTrack(track, stream); } catch { /* ignore */ }
    }

    // Impolite peer owns both channels; polite peer receives them. Creating
    // them before the first offer folds both into one negotiation.
    if (!polite) {
      peer.dataChannel = pc.createDataChannel("aac");
      this.wireData(peer.dataChannel, remotePersonId);
      peer.worldChannel = pc.createDataChannel("world", { ordered: false, maxRetransmits: 0 });
      this.wireWorld(peer.worldChannel, remotePersonId);
    }
    pc.ondatachannel = (ev) => {
      if (ev.channel.label === "world") {
        peer!.worldChannel = ev.channel;
        this.wireWorld(ev.channel, remotePersonId);
      } else {
        peer!.dataChannel = ev.channel;
        this.wireData(ev.channel, remotePersonId);
      }
    };

    pc.onnegotiationneeded = async () => {
      try {
        peer!.makingOffer = true;
        await pc.setLocalDescription();
        this.opts.sendSignal(remotePersonId, { description: pc.localDescription } as CallSignal);
      } catch (err) {
        console.error("[peer-mesh] negotiation error:", err);
      } finally {
        peer!.makingOffer = false;
      }
    };

    pc.onicecandidate = ({ candidate }) => {
      if (candidate) this.opts.sendSignal(remotePersonId, { candidate } as CallSignal);
    };

    pc.ontrack = ({ streams }) => {
      if (streams[0]) this.opts.onRemoteStream?.(remotePersonId, streams[0]);
    };

    // "Connected" can be signalled two ways. connectionState is the precise
    // aggregate, but some Chromium/Electron builds (the AAC ships as Electron)
    // don't fire `connectionstatechange` reliably — so the call would establish
    // media yet stay stuck on "connecting". iceConnectionState IS universally
    // fired, so we treat its connected/completed as connected too. onPeerConnected
    // is idempotent (just flips the UI to "active"), so double-firing is harmless.
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "connected") this.opts.onPeerConnected?.(remotePersonId);
      if (pc.connectionState === "failed") this.opts.onPeerFailed?.(remotePersonId);
    };
    pc.oniceconnectionstatechange = () => {
      const s = pc.iceConnectionState;
      if (s === "connected" || s === "completed") this.opts.onPeerConnected?.(remotePersonId);
      if (s === "failed") this.opts.onPeerFailed?.(remotePersonId);
    };

    return peer;
  }

  async handleSignal(fromPersonId: string, signal: CallSignal): Promise<void> {
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
          this.opts.sendSignal(fromPersonId, { description: pc.localDescription } as CallSignal);
        }
      } else if (candidate) {
        try { await pc.addIceCandidate(candidate); }
        catch (err) { if (!peer.ignoreOffer) throw err; }
      }
    } catch (err) {
      console.error("[peer-mesh] signal handling error:", err);
    }
  }

  removePeer(personId: string): void {
    const peer = this.peers.get(personId);
    if (peer) {
      try { peer.dataChannel?.close(); } catch { /* ignore */ }
      try { peer.worldChannel?.close(); } catch { /* ignore */ }
      try { peer.pc.close(); } catch { /* ignore */ }
      this.peers.delete(personId);
    }
  }

  closeAll(): void {
    for (const id of Array.from(this.peers.keys())) this.removePeer(id);
  }

  /** Send over the reliable channel to all peers. */
  sendData(message: unknown): void {
    for (const peer of this.peers.values()) {
      if (peer.dataChannel?.readyState === "open") {
        try { peer.dataChannel.send(JSON.stringify(message)); } catch { /* ignore */ }
      }
    }
  }

  /** Send over the unreliable channel to all peers (dropped, never retransmitted). */
  sendWorldData(message: unknown): void {
    const payload = JSON.stringify(message);
    for (const peer of this.peers.values()) {
      if (peer.worldChannel?.readyState === "open") {
        try { peer.worldChannel.send(payload); } catch { /* ignore */ }
      }
    }
  }

  private wireData(channel: RTCDataChannel, remotePersonId: string): void {
    channel.onmessage = (ev) => {
      let parsed: unknown;
      try { parsed = JSON.parse(ev.data); } catch { parsed = ev.data; }
      this.opts.onData?.(remotePersonId, parsed);
    };
  }

  private wireWorld(channel: RTCDataChannel, remotePersonId: string): void {
    channel.onmessage = (ev) => {
      let parsed: unknown;
      try { parsed = JSON.parse(ev.data); } catch { parsed = ev.data; }
      this.opts.onWorldData?.(remotePersonId, parsed);
    };
  }
}
