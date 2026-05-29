// client-aac/src/hooks/useSocialBotSession.ts
//
// AAC-integrated client for the Social Training Game bot.
//
// Differs from the standalone game (games/social-trainer/src/SocialTrainerApp.tsx)
// in two ways:
//   1. NO mic capture — the student is non-verbal here. The student "talks"
//      to the bot via AAC button presses, which the AAC AI turns into an
//      utterance, which we forward as `text_message` to the bot.
//   2. Lifecycle is controlled by the caller (SocialBotContext) via the
//      `active` flag, not by user-facing Start/End buttons.
//
// Bot audio playback uses its own AudioContext so it doesn't conflict with
// the AAC AI's existing audio queue.
//
// Wire protocol (post-rewrite):
//   server → client:
//     initialized       — { sessionId, characterName, voiceName, language,
//                            appearance, expressiveness, legibility }
//     bot_state         — { target: FaceTarget, mode, rapport } (per turn)
//     bot_text          — full reply line (server already coalesced)
//     bot_audio         — base64 WAV chunks from streaming TTS
//     turn_complete     — marker after TTS stream drains
//     session_report    — { report: SessionReport, feedback_summary }
//     error             — string code

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  BotStatePayload,
  InitializedPayload,
  SessionReport,
} from "@shared/social-bot/state";
import { NEUTRAL_FACE, type FaceTarget, type FaceAppearance } from "@shared/social-bot/ProceduralFace";

export interface SocialBotSessionEnd {
  reason: string;
  feedback_summary: string;
  report?: SessionReport;
}

export interface SocialBotSessionHandle {
  connected: boolean;
  /** Current target the face should be heading toward. */
  faceTarget: FaceTarget;
  /** Set on `initialized` and stays put for the session. */
  appearance: FaceAppearance | null;
  expressiveness: number;
  legibility: number;
  /** Most recent thing the bot said (replaced each turn). */
  botText: string;
  voiceName: string | null;
  characterName: string | null;
  /** Latest mode label (debug / SLP trace). */
  mode: BotStatePayload["mode"];
  /** Instantaneous mouth amplitude (0..1), polled from the audio analyser
   *  while a chunk is playing. Drives lip-sync on the procedural face. */
  speakingLevel: number;
  /** Set once the bot or the user ends the session. */
  sessionEnd: SocialBotSessionEnd | null;
  error: string | null;
  /** Forward an utterance the AAC AI produced to the bot. */
  sendUtterance: (text: string) => void;
  /** Cancel the session (cave click). */
  cancel: () => void;
}

interface Options {
  studentId: string | null;
  active: boolean;
  /**
   * Fired once per completed bot turn with the full text the bot just said.
   * The AAC integration uses this to feed the bot's words back to the AAC AI
   * as conversational context so it can generate response buttons.
   */
  onBotTurnComplete?: (text: string) => void;
}

function wsUrlFor(path: string): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}${path}`;
}

export function useSocialBotSession({ studentId, active, onBotTurnComplete }: Options): SocialBotSessionHandle {
  const onBotTurnCompleteRef = useRef(onBotTurnComplete);
  onBotTurnCompleteRef.current = onBotTurnComplete;

  const [connected, setConnected] = useState(false);
  const [faceTarget, setFaceTarget] = useState<FaceTarget>(NEUTRAL_FACE);
  const [appearance, setAppearance] = useState<FaceAppearance | null>(null);
  const [expressiveness, setExpressiveness] = useState(0.85);
  const [legibility, setLegibility] = useState(1);
  const [botText, setBotText] = useState("");
  const [voiceName, setVoiceName] = useState<string | null>(null);
  const [characterName, setCharacterName] = useState<string | null>(null);
  const [mode, setMode] = useState<BotStatePayload["mode"]>("NEUTRAL");
  const [sessionEnd, setSessionEnd] = useState<SocialBotSessionEnd | null>(null);
  const [error, setError] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const playbackTimeRef = useRef(0);
  /** Track the bot's last line so we can fire onBotTurnComplete at turn_complete. */
  const lastBotLineRef = useRef("");

  // Speech amplitude → mouth animation. Each BufferSourceNode flows
  // through this analyser so we can measure the playing audio's RMS in
  // real time and feed it to the face. Same pattern as the AAC's
  // useStreamingAudioPlayer / AvatarSpriteContext.
  const analyserRef = useRef<AnalyserNode | null>(null);
  const sourcesPlayingRef = useRef(0);
  const [speakingActive, setSpeakingActive] = useState(false);
  /** 0..1, instantaneous mouth amplitude. Polled per frame while speaking. */
  const [speakingLevel, setSpeakingLevel] = useState(0);
  const volumeRafRef = useRef<number | null>(null);

  // ── Audio playback ──────────────────────────────────────────────────────
  const ensureAudioCtx = useCallback((): AudioContext => {
    if (!audioCtxRef.current) {
      const ctx = new AudioContext();
      audioCtxRef.current = ctx;
      playbackTimeRef.current = ctx.currentTime;
      // One analyser per session, sitting in front of destination. All
      // buffer-source nodes connect through it so the RMS poll reads
      // whichever chunk is currently playing.
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.3;
      analyser.connect(ctx.destination);
      analyserRef.current = analyser;
    }
    return audioCtxRef.current;
  }, []);

  const playWavBase64 = useCallback(async (b64: string) => {
    const ctx = ensureAudioCtx();
    if (ctx.state === "suspended") {
      try { await ctx.resume(); } catch { /* ignore */ }
    }
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    let audioBuf: AudioBuffer;
    try {
      audioBuf = await ctx.decodeAudioData(bytes.buffer);
    } catch {
      return;
    }
    const src = ctx.createBufferSource();
    src.buffer = audioBuf;
    // Route through the analyser so we can read amplitude per frame.
    const analyser = analyserRef.current;
    if (analyser) src.connect(analyser);
    else src.connect(ctx.destination);

    // Track "is any chunk currently playing" by counting outstanding
    // sources — onended fires regardless of how the source completed.
    sourcesPlayingRef.current += 1;
    setSpeakingActive(true);
    src.onended = () => {
      sourcesPlayingRef.current = Math.max(0, sourcesPlayingRef.current - 1);
      if (sourcesPlayingRef.current === 0) setSpeakingActive(false);
    };

    const startAt = Math.max(ctx.currentTime, playbackTimeRef.current);
    src.start(startAt);
    playbackTimeRef.current = startAt + audioBuf.duration;
  }, [ensureAudioCtx]);

  // RMS poll loop — runs while any chunk is playing.
  useEffect(() => {
    if (!speakingActive || !analyserRef.current) {
      setSpeakingLevel(0);
      return;
    }
    const analyser = analyserRef.current;
    const dataArray = new Uint8Array(analyser.frequencyBinCount);
    const poll = () => {
      analyser.getByteFrequencyData(dataArray);
      let sum = 0;
      for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
      const avg = sum / dataArray.length / 255; // 0..1
      setSpeakingLevel(avg);
      volumeRafRef.current = requestAnimationFrame(poll);
    };
    volumeRafRef.current = requestAnimationFrame(poll);
    return () => {
      if (volumeRafRef.current) cancelAnimationFrame(volumeRafRef.current);
      setSpeakingLevel(0);
    };
  }, [speakingActive]);

  const interruptPlayback = useCallback(() => {
    if (audioCtxRef.current) {
      playbackTimeRef.current = audioCtxRef.current.currentTime;
    }
  }, []);

  // ── WS lifecycle ────────────────────────────────────────────────────────
  useEffect(() => {
    if (!active) return;
    if (!studentId) {
      console.warn("[SocialBot] active without studentId — refusing to connect");
      setError("No studentId");
      return;
    }

    setError(null);
    setSessionEnd(null);
    setFaceTarget(NEUTRAL_FACE);
    setBotText("");
    setMode("NEUTRAL");
    lastBotLineRef.current = "";

    const url = wsUrlFor("/ws/social-bot");
    console.log("[SocialBot] opening WS", { url, studentId });
    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      console.log("[SocialBot] WS open — sending initialize");
      ws.send(JSON.stringify({ type: "initialize", studentId }));
    };

    ws.onmessage = (event) => {
      let msg: any;
      try { msg = JSON.parse(event.data); }
      catch (err) {
        console.warn("[SocialBot] WS message parse error", err);
        return;
      }
      if (msg.type !== "bot_audio") {
        const summary: any = { type: msg.type };
        if (msg.data !== undefined && typeof msg.data !== "string") summary.data = msg.data;
        if (typeof msg.data === "string" && msg.data.length <= 120) summary.data = msg.data;
        console.log("[SocialBot] WS message", summary);
      }
      switch (msg.type) {
        case "initialized": {
          const init = msg as InitializedPayload & { type: "initialized" };
          setConnected(true);
          setVoiceName(init.voiceName || null);
          setCharacterName(init.characterName || null);
          setAppearance(init.appearance);
          setExpressiveness(init.expressiveness);
          setLegibility(init.legibility);
          break;
        }
        case "bot_state": {
          const data = msg.data as BotStatePayload | undefined;
          if (!data) break;
          setFaceTarget(data.target);
          setMode(data.mode);
          break;
        }
        case "bot_text":
          if (typeof msg.data === "string") {
            lastBotLineRef.current = msg.data;
            setBotText(msg.data);
          }
          break;
        case "bot_audio":
          playWavBase64(msg.data);
          break;
        case "audio_interrupt":
          interruptPlayback();
          break;
        case "turn_complete": {
          const completed = lastBotLineRef.current.trim();
          if (completed) onBotTurnCompleteRef.current?.(completed);
          break;
        }
        case "session_report":
          setSessionEnd({
            reason: msg.data?.report?.finalMode || "ended",
            feedback_summary: msg.data?.feedback_summary || "",
            report: msg.data?.report,
          });
          break;
        case "error":
          setError(msg.data || "Unknown error");
          break;
      }
    };

    ws.onclose = (ev) => {
      console.log("[SocialBot] WS close", { code: ev.code, reason: ev.reason, wasClean: ev.wasClean });
      setConnected(false);
    };
    ws.onerror = (ev) => {
      console.warn("[SocialBot] WS error", ev);
      setError("WebSocket error");
    };

    return () => {
      console.log("[SocialBot] effect teardown — closing WS");
      try { ws.close(); } catch { /* ignore */ }
      wsRef.current = null;
      setConnected(false);
    };
  }, [active, studentId, playWavBase64, interruptPlayback]);

  useEffect(() => {
    return () => {
      if (audioCtxRef.current) {
        try { audioCtxRef.current.close(); } catch { /* ignore */ }
        audioCtxRef.current = null;
      }
    };
  }, []);

  const sendUtterance = useCallback((text: string) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "text_message", data: text }));
  }, []);

  const cancel = useCallback(() => {
    setSessionEnd((prev) =>
      prev || { reason: "cancelled by user", feedback_summary: "The user ended the session early." },
    );
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify({ type: "cancel" })); } catch { /* ignore */ }
      try { ws.close(); } catch { /* ignore */ }
    }
  }, []);

  return {
    connected,
    faceTarget,
    appearance,
    expressiveness,
    legibility,
    botText,
    voiceName,
    characterName,
    mode,
    speakingLevel,
    sessionEnd,
    error,
    sendUtterance,
    cancel,
  };
}
