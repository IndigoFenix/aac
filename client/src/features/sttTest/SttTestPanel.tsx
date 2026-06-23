// Standalone server-side STT sandbox (route: /stt-test). Captures fresh mic
// audio (NOT the processed WebRTC call stream), streams native-rate PCM to the
// server's Google Cloud STT over /ws/stt-test, and shows interim + final
// transcripts. Lets us compare server-side STT to the browser's Web Speech API
// and tune capture constraints / recognizer model in isolation.

import { useCallback, useRef, useState } from "react";
import { Mic, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useLanguage } from "@/contexts/LanguageContext";
import { streamMicPcm } from "@/features/call/micPcm";

function wsUrl(path: string): string {
  const base = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/+$/, "") ?? "";
  if (base) {
    const u = new URL(base);
    u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
    u.pathname = path;
    return u.toString();
  }
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}${path}`;
}

// Google STT recognition models worth comparing for short conversational speech.
const MODELS = ["latest_short", "latest_long", "default", "command_and_search", "phone_call"];

export default function SttTestPanel() {
  const { language } = useLanguage();
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState("idle");
  const [error, setError] = useState<string | null>(null);
  const [interim, setInterim] = useState("");
  const [finals, setFinals] = useState<string[]>([]);

  const [model, setModel] = useState("latest_short");
  const [echoCancellation, setEchoCancellation] = useState(true);
  const [noiseSuppression, setNoiseSuppression] = useState(true);
  const [autoGainControl, setAutoGainControl] = useState(true);

  const wsRef = useRef<WebSocket | null>(null);
  const stopCaptureRef = useRef<(() => void) | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const stop = useCallback(() => {
    stopCaptureRef.current?.();
    stopCaptureRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    try { wsRef.current?.send(JSON.stringify({ type: "stt:stop" })); } catch { /* ignore */ }
    try { wsRef.current?.close(); } catch { /* ignore */ }
    wsRef.current = null;
    setRunning(false);
    setStatus("stopped");
    setInterim("");
  }, []);

  const start = useCallback(async () => {
    setError(null);
    setFinals([]);
    setInterim("");
    setStatus("requesting mic…");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation, noiseSuppression, autoGainControl },
      });
      streamRef.current = stream;
      setStatus("connecting…");
      const ws = new WebSocket(wsUrl("/ws/stt-test"));
      wsRef.current = ws;

      ws.onopen = () => {
        setStatus("listening");
        setRunning(true);
        let started = false;
        stopCaptureRef.current = streamMicPcm(stream, (chunk, sampleRate) => {
          if (ws.readyState !== WebSocket.OPEN) return;
          if (!started) {
            started = true;
            ws.send(JSON.stringify({ type: "stt:start", sampleRate, lang: language, model }));
          }
          ws.send(JSON.stringify({ type: "stt:audio", chunk }));
        });
      };
      ws.onmessage = (e) => {
        let msg: any;
        try { msg = JSON.parse(e.data); } catch { return; }
        if (msg.type === "stt:interim") setInterim(msg.text ?? "");
        else if (msg.type === "stt:final") { setFinals((f) => [...f, msg.text ?? ""]); setInterim(""); }
        else if (msg.type === "stt:error") setError(msg.error ?? "STT error");
        else if (msg.type === "stt:started") setStatus(`listening (model=${msg.model}, ${msg.sampleRate ?? "?"}Hz)`);
      };
      ws.onclose = () => setStatus((s) => (s === "listening" ? "closed" : s));
      ws.onerror = () => setError("WebSocket error");
    } catch (err: any) {
      setError(err?.message ?? "Failed to start");
      setStatus("error");
      stop();
    }
  }, [echoCancellation, noiseSuppression, autoGainControl, language, model, stop]);

  return (
    <div className="mx-auto max-w-2xl p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Server-side STT test</h1>
        <p className="text-sm text-muted-foreground">
          Streams fresh mic audio to the server's Google Cloud Speech-to-Text and shows the result.
          Compare against the browser's Web Speech API; toggle the capture constraints to see their effect.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-4 rounded-lg border p-4">
        <Button onClick={running ? stop : start} variant={running ? "destructive" : "default"} className="gap-2">
          {running ? <Square className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
          {running ? "Stop" : "Start"}
        </Button>

        <label className="flex items-center gap-1 text-sm">
          Model
          <select
            className="rounded border bg-background px-2 py-1"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            disabled={running}
          >
            {MODELS.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </label>

        <label className="flex items-center gap-1 text-sm">
          <input type="checkbox" checked={echoCancellation} onChange={(e) => setEchoCancellation(e.target.checked)} disabled={running} />
          echoCancellation
        </label>
        <label className="flex items-center gap-1 text-sm">
          <input type="checkbox" checked={noiseSuppression} onChange={(e) => setNoiseSuppression(e.target.checked)} disabled={running} />
          noiseSuppression
        </label>
        <label className="flex items-center gap-1 text-sm">
          <input type="checkbox" checked={autoGainControl} onChange={(e) => setAutoGainControl(e.target.checked)} disabled={running} />
          autoGainControl
        </label>

        <span className="ml-auto text-sm text-muted-foreground">{status}</span>
      </div>

      {error && <div className="rounded-lg border border-destructive bg-destructive/10 p-3 text-sm text-destructive">{error}</div>}

      <div className="space-y-2">
        <div className="min-h-[2rem] rounded-lg border bg-muted/40 p-3 text-base italic text-muted-foreground">
          {interim || (running ? "…listening…" : "")}
        </div>
        <ul className="space-y-1">
          {finals.map((t, i) => (
            <li key={i} className="rounded bg-background px-3 py-1.5 text-base">{t}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}
