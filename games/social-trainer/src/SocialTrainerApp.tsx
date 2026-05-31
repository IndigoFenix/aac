// Standalone social-training game UI.
//
// Talks directly to /ws/social-bot — does NOT use games-bridge. The bridge
// is for iframe-embedded games inside the AAC client; this game's verbal
// mode is the standalone test entrypoint, and the non-verbal AAC-integrated
// mode will be wired separately as a deeper integration.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  NEUTRAL_FACE,
  ProceduralFace,
  type FaceAppearance,
  type FaceTarget,
} from "@shared/social-bot/ProceduralFace";

type TranscriptLine = { who: "bot" | "user"; text: string };

interface SessionEnd {
  reason: string;
  feedback_summary: string;
  report?: SessionReport;
}

interface CompetencySnapshot {
  competency: string;
  value: number;
  samples: number;
}
interface SharedMomentSummary { kind: string; summary: string; weight: number }
interface SessionReport {
  characterName: string;
  durationMs: number;
  turnIndex: number;
  finalMode: string;
  finalRapport: number;
  competencies: CompetencySnapshot[];
  moments: SharedMomentSummary[];
  feedbackSummary: string;
}

// Generator presets we expose to the UI. Mirrors the Archetype type on
// the server; "random" leaves the trait centers unspecified.
const ARCHETYPES = [
  { id: "random", label: "Random" },
  { id: "sunny_extrovert", label: "Sunny extrovert" },
  { id: "anxious_pleaser", label: "Anxious pleaser" },
  { id: "gruff_softie", label: "Gruff softie" },
  { id: "aloof_intellectual", label: "Aloof intellectual" },
  { id: "even_keel", label: "Even keel" },
] as const;
type ArchetypeId = (typeof ARCHETYPES)[number]["id"];
type GenderPick = "random" | "male" | "female";

// Language codes mirror shared/language-names.ts. We expose them
// explicitly in standalone because the browser SpeechRecognition's
// implicit `navigator.language` was locking the user's actual STT to
// whatever locale their OS reported — not what they want to test.
const LANGUAGES: ReadonlyArray<{ code: string; label: string; bcp47: string }> = [
  { code: "en", label: "English", bcp47: "en-US" },
  { code: "he", label: "Hebrew", bcp47: "he-IL" },
  { code: "es", label: "Spanish", bcp47: "es-ES" },
  { code: "pt", label: "Portuguese", bcp47: "pt-PT" },
  { code: "fr", label: "French", bcp47: "fr-FR" },
  { code: "ru", label: "Russian", bcp47: "ru-RU" },
  { code: "de", label: "German", bcp47: "de-DE" },
  { code: "ar", label: "Arabic", bcp47: "ar-SA" },
  { code: "zh", label: "Mandarin", bcp47: "zh-CN" },
  { code: "yue", label: "Cantonese", bcp47: "zh-HK" },
  { code: "ko", label: "Korean", bcp47: "ko-KR" },
];

const COMPETENCY_LABEL: Record<string, string> = {
  responsiveness: "responding to what they said",
  reciprocity: "asking about them",
  attunement: "reading their mood",
  repair: "recovering from missteps",
  assertiveness: "speaking your mind",
  complimentCalibration: "giving compliments well",
  initiation: "starting conversations",
  interestEngagement: "engaging with their interests",
};

// Optional studentId via /?studentId=... (persisted in localStorage). When
// absent, the server skips the AAC student lookup and runs in "standalone"
// mode: the bot will mirror whatever language the user uses, and voice
// selection has no exclusion list.
function getStudentId(): string | null {
  const url = new URL(window.location.href);
  const fromQuery = url.searchParams.get("studentId");
  if (fromQuery) {
    localStorage.setItem("social_trainer_studentId", fromQuery);
    return fromQuery;
  }
  return localStorage.getItem("social_trainer_studentId");
}

function wsUrlFor(path: string): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}${path}`;
}

export default function SocialTrainerApp() {
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [faceTarget, setFaceTarget] = useState<FaceTarget>(NEUTRAL_FACE);
  const [appearance, setAppearance] = useState<FaceAppearance | null>(null);
  const [expressiveness, setExpressiveness] = useState(0.85);
  const [legibility, setLegibility] = useState(1);
  const [characterName, setCharacterName] = useState<string | null>(null);
  const [mode, setMode] = useState<string>("NEUTRAL");
  const [transcript, setTranscript] = useState<TranscriptLine[]>([]);
  const [voiceName, setVoiceName] = useState<string | null>(null);
  const [micActive, setMicActive] = useState(false);
  const [sessionEnd, setSessionEnd] = useState<SessionEnd | null>(null);

  // Generator params (UI controls — persisted in localStorage so the
  // developer doesn't have to re-pick every reload).
  const [archetype, setArchetype] = useState<ArchetypeId>(() =>
    (localStorage.getItem("social_trainer_archetype") as ArchetypeId) || "random",
  );
  const [genderPick, setGenderPick] = useState<GenderPick>(() =>
    (localStorage.getItem("social_trainer_gender") as GenderPick) || "random",
  );
  const [difficulty, setDifficulty] = useState<number>(() => {
    const stored = localStorage.getItem("social_trainer_difficulty");
    const parsed = stored ? parseFloat(stored) : NaN;
    return Number.isFinite(parsed) ? parsed : 0.4;
  });
  const [languageCode, setLanguageCode] = useState<string>(() => {
    const stored = localStorage.getItem("social_trainer_language");
    if (stored && LANGUAGES.some((l) => l.code === stored)) return stored;
    // First-launch default: try to match the browser locale to one of
    // our known codes, otherwise English.
    const navCode = (navigator.language || "en").split("-")[0];
    return LANGUAGES.find((l) => l.code === navCode) ? navCode : "en";
  });
  useEffect(() => { localStorage.setItem("social_trainer_archetype", archetype); }, [archetype]);
  useEffect(() => { localStorage.setItem("social_trainer_gender", genderPick); }, [genderPick]);
  useEffect(() => { localStorage.setItem("social_trainer_difficulty", String(difficulty)); }, [difficulty]);
  useEffect(() => { localStorage.setItem("social_trainer_language", languageCode); }, [languageCode]);

  const wsRef = useRef<WebSocket | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const sourcesPlayingRef = useRef(0);
  const [speakingActive, setSpeakingActive] = useState(false);
  const [speakingLevel, setSpeakingLevel] = useState(0);
  const volumeRafRef = useRef<number | null>(null);
  /** Browser SpeechRecognition session. Live transcripts get shown
   *  as `interim` and committed transcripts get sent as text_message. */
  const recognitionRef = useRef<any | null>(null);
  const [interimTranscript, setInterimTranscript] = useState("");
  const playbackTimeRef = useRef<number>(0);

  const studentId = useMemo(() => getStudentId(), []);

  const transcriptRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (transcriptRef.current) {
      transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight;
    }
  }, [transcript]);

  // ── Audio playback (queued WAV blobs from the bot) ──────────────────────
  const ensureAudioCtx = useCallback((): AudioContext => {
    if (!audioCtxRef.current) {
      const ctx = new AudioContext();
      audioCtxRef.current = ctx;
      playbackTimeRef.current = ctx.currentTime;
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
      try {
        await ctx.resume();
      } catch {
        /* ignore */
      }
    }
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    let audioBuf: AudioBuffer;
    try {
      audioBuf = await ctx.decodeAudioData(bytes.buffer);
    } catch (e) {
      console.warn("[SocialTrainer] decodeAudioData failed", e);
      return;
    }
    const src = ctx.createBufferSource();
    src.buffer = audioBuf;
    const analyser = analyserRef.current;
    if (analyser) src.connect(analyser);
    else src.connect(ctx.destination);

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

  // Same RMS poll as useSocialBotSession — drives the mouth flap.
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
      setSpeakingLevel(sum / dataArray.length / 255);
      volumeRafRef.current = requestAnimationFrame(poll);
    };
    volumeRafRef.current = requestAnimationFrame(poll);
    return () => {
      if (volumeRafRef.current) cancelAnimationFrame(volumeRafRef.current);
      setSpeakingLevel(0);
    };
  }, [speakingActive]);

  const interruptPlayback = useCallback(() => {
    // Cheapest interrupt: rewind the scheduled-playback cursor. Already-started
    // sources will still play out, but no new chunks will queue behind them.
    if (audioCtxRef.current) {
      playbackTimeRef.current = audioCtxRef.current.currentTime;
    }
  }, []);

  // ── Mic capture (browser SpeechRecognition) ─────────────────────────────
  //
  // We dropped the server-side PCM path when the bot moved off Gemini
  // Live's native audio (which did STT in-stream). For the standalone
  // verbal-mode test, we use the browser's SpeechRecognition API:
  //   - Continuous mode so we don't have to keep restarting it
  //   - interimResults so we can show the user they're being heard
  //   - On each FINAL result, ship the transcript as text_message
  //
  // Works in Chrome/Edge today. Firefox / Safari support is limited —
  // when SpeechRecognition is unavailable, the mic button surfaces an
  // error and we'd need a server-STT fallback (Whisper) — not done yet.
  const sendUtterance = useCallback((text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "text_message", data: trimmed }));
    setTranscript((t) => appendOrExtend(t, "user", trimmed));
  }, []);

  const startMic = useCallback(async () => {
    if (micActive) return;
    const SR: any = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) {
      setError("Speech recognition isn't available in this browser. Try Chrome or Edge.");
      return;
    }
    try {
      const rec = new SR();
      rec.continuous = true;
      rec.interimResults = true;
      // Explicit BCP-47 from the language picker. Implicit navigator.language
      // here was the original "stuck in Hebrew" bug — the user's OS locale
      // was silently dictating STT regardless of what they actually wanted
      // to speak.
      const lang = LANGUAGES.find((l) => l.code === languageCode);
      rec.lang = lang?.bcp47 || "en-US";

      rec.onresult = (event: any) => {
        let interim = "";
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const result = event.results[i];
          const text = result[0]?.transcript ?? "";
          if (result.isFinal) {
            sendUtterance(text);
          } else {
            interim += text;
          }
        }
        setInterimTranscript(interim);
      };

      rec.onerror = (event: any) => {
        console.warn("[SocialTrainer] SpeechRecognition error", event.error);
        if (event.error === "not-allowed" || event.error === "service-not-allowed") {
          setError("Mic permission denied.");
          setMicActive(false);
        }
      };

      rec.onend = () => {
        // Some browsers stop the session after a long pause. Restart if
        // the user hasn't pressed Mute mic.
        if (micActive && recognitionRef.current === rec) {
          try { rec.start(); } catch { /* ignore */ }
        }
      };

      rec.start();
      recognitionRef.current = rec;
      setMicActive(true);
      setError(null);
    } catch (err: any) {
      setError(`SpeechRecognition failed: ${err.message || err}`);
    }
  }, [micActive, sendUtterance, languageCode]);

  const stopMic = useCallback(() => {
    const rec = recognitionRef.current;
    if (rec) {
      try { rec.stop(); } catch { /* ignore */ }
      recognitionRef.current = null;
    }
    setMicActive(false);
    setInterimTranscript("");
  }, []);

  // ── WS lifecycle ────────────────────────────────────────────────────────
  const connect = useCallback(() => {
    setError(null);
    setSessionEnd(null);
    setTranscript([]);
    setFaceTarget(NEUTRAL_FACE);

    const ws = new WebSocket(wsUrlFor("/ws/social-bot"));
    wsRef.current = ws;

    ws.onopen = () => {
      // studentId is optional — server drops AAC-specific bits and runs
      // in standalone mode (mirror-the-user language) when it's missing.
      const params: { archetype?: string; gender?: "male" | "female"; difficulty?: number; language?: string } = {};
      if (archetype !== "random") params.archetype = archetype;
      if (genderPick !== "random") params.gender = genderPick;
      params.difficulty = difficulty;
      params.language = languageCode;
      const init: { type: "initialize"; studentId?: string; params?: typeof params } = {
        type: "initialize",
        params,
      };
      if (studentId) init.studentId = studentId;
      ws.send(JSON.stringify(init));
    };

    ws.onmessage = (event) => {
      let msg: any;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      switch (msg.type) {
        case "initialized":
          setConnected(true);
          setVoiceName(msg.voiceName || null);
          setCharacterName(msg.characterName || null);
          setAppearance(msg.appearance || null);
          if (typeof msg.expressiveness === "number") setExpressiveness(msg.expressiveness);
          if (typeof msg.legibility === "number") setLegibility(msg.legibility);
          break;
        case "bot_text":
          setTranscript((t) => appendOrExtend(t, "bot", msg.data));
          break;
        case "user_text":
          setTranscript((t) => appendOrExtend(t, "user", msg.data));
          break;
        case "bot_audio":
          playWavBase64(msg.data);
          break;
        case "audio_interrupt":
          interruptPlayback();
          break;
        case "bot_state":
          if (msg.data?.target) setFaceTarget(msg.data.target);
          if (msg.data?.mode) setMode(msg.data.mode);
          break;
        case "turn_complete":
          // Standalone game just shows transcript — nothing to do.
          break;
        case "session_report":
          setSessionEnd({
            reason: msg.data?.report?.finalMode || "ended",
            feedback_summary: msg.data?.feedback_summary || "",
            report: msg.data?.report,
          });
          stopMic();
          ws.close();
          break;
        case "error":
          setError(msg.data || "Unknown error");
          break;
      }
    };

    ws.onclose = () => {
      setConnected(false);
      stopMic();
    };
    ws.onerror = () => {
      setError("WebSocket error");
    };
  }, [studentId, archetype, genderPick, difficulty, languageCode, playWavBase64, interruptPlayback, stopMic]);

  const disconnect = useCallback(() => {
    stopMic();
    wsRef.current?.close();
    wsRef.current = null;
  }, [stopMic]);

  useEffect(() => () => disconnect(), [disconnect]);

  // ── Render ──────────────────────────────────────────────────────────────
  return (
    <div className="app">
      <div className="stage">
        {appearance ? (
          <ProceduralFace
            target={faceTarget}
            appearance={appearance}
            expressiveness={expressiveness}
            legibility={legibility}
            speakingLevel={speakingLevel}
            className="face-svg"
          />
        ) : (
          <div className="face-svg" style={{ display: "flex", alignItems: "center", justifyContent: "center", color: "#888" }}>
            {connected ? "…" : "(not connected)"}
          </div>
        )}
        <div className="emotion-tag">
          {characterName || "peer"} · {mode.toLowerCase()}
          {voiceName ? <> · voice: {voiceName}</> : null}
        </div>
      </div>

      <div className="transcript" ref={transcriptRef}>
        {transcript.length === 0 && (
          <div className="line" style={{ opacity: 0.5 }}>
            {connected ? "Say something to begin." : "Not connected."}
          </div>
        )}
        {transcript.map((line, i) => (
          <div className="line" key={i}>
            <span className="who">{line.who === "bot" ? "Bot:" : "You:"}</span>
            {line.text}
          </div>
        ))}
        {interimTranscript && (
          <div className="line" style={{ opacity: 0.6, fontStyle: "italic" }}>
            <span className="who">You:</span>
            {interimTranscript}
          </div>
        )}
      </div>

      {sessionEnd && (
        <SessionReadout end={sessionEnd} />
      )}

      {/* Generator parameters — visible whenever we're between sessions
          so the dev can re-roll with different settings. */}
      {!connected && (
        <div className="params">
          <label>
            <span>Archetype</span>
            <select
              value={archetype}
              onChange={(e) => setArchetype(e.target.value as ArchetypeId)}
            >
              {ARCHETYPES.map((a) => (
                <option key={a.id} value={a.id}>{a.label}</option>
              ))}
            </select>
          </label>
          <label>
            <span>Gender</span>
            <select
              value={genderPick}
              onChange={(e) => setGenderPick(e.target.value as GenderPick)}
            >
              <option value="random">Random</option>
              <option value="male">Male</option>
              <option value="female">Female</option>
            </select>
          </label>
          <label>
            <span>Language</span>
            <select
              value={languageCode}
              onChange={(e) => setLanguageCode(e.target.value)}
            >
              {LANGUAGES.map((l) => (
                <option key={l.code} value={l.code}>{l.label}</option>
              ))}
            </select>
          </label>
          <label className="slider">
            <span>Difficulty: {difficulty.toFixed(2)}</span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={difficulty}
              onChange={(e) => setDifficulty(parseFloat(e.target.value))}
            />
          </label>
        </div>
      )}

      <div className="controls">
        {!connected && !sessionEnd && (
          <button className="primary" onClick={connect}>
            Start session
          </button>
        )}
        {connected && !micActive && (
          <button className="primary" onClick={startMic}>
            Enable mic
          </button>
        )}
        {connected && micActive && (
          <button onClick={stopMic}>Mute mic</button>
        )}
        {connected && (
          <button className="danger" onClick={disconnect}>
            End
          </button>
        )}
        {sessionEnd && (
          <button className="primary" onClick={connect}>
            New session
          </button>
        )}
      </div>

      {error && <div className="status" style={{ color: "#f87171" }}>{error}</div>}
    </div>
  );
}

// ── End-of-session readout ──────────────────────────────────────────────

function SessionReadout({ end }: { end: SessionEnd }) {
  const report = end.report;
  const durationSec = report ? Math.round(report.durationMs / 1000) : 0;
  // Show competencies that got at least 3 observations — weakest first
  // so the dev sees where the user (or the prompt) struggled.
  const competencies = (report?.competencies ?? [])
    .filter((c) => c.samples >= 3)
    .sort((a, b) => a.value - b.value);

  return (
    <div className="report">
      <h3>
        Session ended
        {report?.characterName ? <> — talking with {report.characterName}</> : null}
      </h3>
      {report ? (
        <div className="meta">
          {durationSec}s · {report.turnIndex} turns · finished {report.finalMode.toLowerCase()} (rapport {report.finalRapport.toFixed(2)})
        </div>
      ) : (
        <div className="meta">Ended early ({end.reason})</div>
      )}

      {end.feedback_summary && (
        <div style={{ fontStyle: "italic", opacity: 0.85, marginBottom: 8 }}>
          "{end.feedback_summary}"
        </div>
      )}

      {competencies.length > 0 && (
        <div>
          {competencies.map((c) => {
            const pct = Math.round(c.value * 100);
            const label = COMPETENCY_LABEL[c.competency] || c.competency;
            return (
              <div key={c.competency}>
                <div className="skill-row">
                  <span>{label}</span>
                  <span>{pct}% · {c.samples} obs</span>
                </div>
                <div className="bar"><div style={{ width: `${pct}%` }} /></div>
              </div>
            );
          })}
        </div>
      )}

      {report && report.moments.length > 0 && (
        <div className="moments">
          <strong>Moments worth referencing:</strong>
          <ul>
            {report.moments.slice(-5).map((m, i) => (
              <li key={i}>({m.kind}) {m.summary}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// Gemini's outputTranscription arrives in many small fragments. Coalesce
// consecutive same-speaker fragments into one line so the transcript stays
// readable.
function appendOrExtend(lines: TranscriptLine[], who: "bot" | "user", text: string): TranscriptLine[] {
  if (!text) return lines;
  const last = lines[lines.length - 1];
  if (last && last.who === who) {
    const merged = [...lines];
    merged[merged.length - 1] = { who, text: last.text + text };
    return merged;
  }
  return [...lines, { who, text }];
}
