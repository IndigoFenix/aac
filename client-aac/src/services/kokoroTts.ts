// client-aac/src/services/kokoroTts.ts
//
// LOCAL NEURAL TTS — the client's own voice, upgraded.
//
// The AAC's last-resort voice is `client_local_tts`: the server gives up on
// every cloud provider and tells the client "say this with whatever you have"
// (see AgentCoordinator.sendClientLocalTts — a press must never be silent).
// Until now "whatever you have" meant window.speechSynthesis, which in a
// packaged Electron kiosk resolves to the OS OneCore/SAPI voices, i.e. the old
// robotic generation. Kokoro-82M is a neural TTS small enough to run in
// onnxruntime-web at roughly real time on CPU, so that press now gets a natural
// voice instead of a mechanical one.
//
// THIS IS A DROP-IN UPGRADE TO AN EXISTING PATH, NOT A NEW VOICE OPTION.
// Nothing here changes which voice a student is configured to use — the child's
// chosen voice still comes from ElevenLabs/Google via the normal ladder, and
// this only ever runs where speechSynthesis would have run. Making Kokoro a
// SELECTABLE student voice is a separate piece of work: it needs a
// ClientCapabilities flag, server-side voice resolution, and an AACSettings
// choice, because silently swapping the voice a child has been hearing for
// months is not an installer's decision to make.
//
// ENGLISH ONLY, DELIBERATELY. Kokoro ships en-us/en-gb voices and nothing else,
// and Hebrew is not a "not yet wired up" gap — as of 2026-08-25 every open
// Hebrew acoustic model at usable quality (MMS-TTS-heb, OmniVoice) is CC-BY-NC
// and therefore unshippable. Hebrew presses keep using speechSynthesis. When a
// Hebrew model we can license lands, it plugs in behind `supportsLanguage`.
//
// FAILURE IS ALWAYS SOFT. Every entry point returns false / resolves rather
// than throwing, and the caller falls back to speechSynthesis. A missing model,
// a cold cache, a browser with no AudioContext — none of them may cost the
// child their utterance.

import { createModelLoader, type ModelLoader } from "@/lib/modelLoader";
import { localModelBase, hasLocalModel, withTransformersEnv } from "@/lib/transformersEnv";

const MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";

/** Version prefix on the CDN. MUST match MODEL_VERSION in
 *  scripts/publish-voice-models.mjs — the client builds its fetch URL from
 *  this, so a mismatch 404s every device and they all silently keep
 *  speechSynthesis. Published paths are immutable: new weights = new version. */
const MODEL_VERSION = "v1.0";

/** Where a DEVICE downloads weights from: our own CloudFront distribution, not
 *  HuggingFace. A school network may well block HF, and an upstream file that
 *  changes under us would alter a child's voice with no deploy on our side.
 *  See terraform/aac-updates.tf (`models/*` behavior: CORS + immutable cache).
 *
 *  transformers.js composes `remoteHost` + `remotePathTemplate` + the file
 *  path, so pointing remoteHost here makes the whole loader fetch from us. */
const MODEL_HOST =
  (import.meta as any).env?.VITE_VOICE_MODEL_HOST ?? "https://updates.aivota.ai";
const MODEL_REMOTE_PATH = `/models/kokoro/${MODEL_VERSION}`;

/** q8 → onnx/model_quantized.onnx (~92 MB).
 *
 *  Chosen for SIZE and portability, NOT speed — and it is worth knowing that it
 *  is the slowest of the four variants, not the fastest. Measured on an
 *  i5-8250U via onnxruntime-node, best-of-3 on a 2.35s utterance:
 *
 *      q8    92 MB   RTF 2.08      fp16  163 MB   RTF 0.71
 *      q4   305 MB   RTF 1.56      fp32  326 MB   RTF 0.78
 *
 *  uint8 weights get dequantized to fp32 for the matmuls, so quantization buys
 *  disk at the cost of compute. fp16 is both smaller than fp32 and fastest, but
 *  costs 71 MB more installer than q8 AND leans on fp16 kernels the WASM
 *  execution provider does not implement uniformly — so it is a real option to
 *  revisit with a browser measurement, not a free win.
 *
 *  Those numbers are onnxruntime-NODE (native). The client runs onnxruntime-WEB
 *  (WASM), which cannot be benchmarked from Node and is typically slower again.
 *  That unknown is exactly why the speed gate below exists: rather than betting
 *  the press latency on an unmeasured backend, the model proves it is fast
 *  enough on THIS device or takes itself out of the ladder.
 *
 *  KEEP IN SYNC with the file list in scripts/fetch-kokoro-model.mjs. */
const MODEL_DTYPE = "q8";

/** Steady-state real-time factor above which the neural voice is a downgrade.
 *  An AAC press is a turn in a conversation: a child who presses "more juice
 *  please" and waits three seconds for a natural voice is worse served than one
 *  who gets a robotic voice instantly. Above this ratio we hand the path back
 *  to speechSynthesis. 1.0 = synthesis takes as long as the audio it produces. */
const MAX_RTF = 1.0;

/** The warmup pass runs graph init as well as inference, so it is legitimately
 *  several times slower than steady state (measured 4-7x). Only a device that
 *  misses even this loose bound is rejected outright. */
const WARMUP_MAX_RTF = 6.0;

/** Consecutive real utterances over MAX_RTF before the voice disables itself.
 *  One slow synthesis is noise — a GC pause, a busy tab, another model loading.
 *  Two in a row is the device telling us it cannot do this. */
const SLOW_STRIKES = 2;

/** Kokoro emits 24 kHz mono float32. */
const SAMPLE_RATE = 24_000;

/** Voice per speaking role, mirroring the gender split the speechSynthesis
 *  picker already used (student = male hint, AI = female). Grades are the
 *  upstream quality ratings: af_heart is the only A, am_puck the best male
 *  short of it. KEEP IN SYNC with VOICES in scripts/fetch-kokoro-model.mjs —
 *  a name here that isn't staged there works online and goes quiet offline. */
const VOICE_BY_ROLE: Record<"ai" | "student", string> = {
  ai: "af_heart",     // grade A
  student: "am_puck", // grade C+, the brightest male
};

/** kokoro-js fetches style vectors from this hardcoded URL and has no override
 *  hook. It DOES check a CacheStorage bucket first, so seeding that bucket from
 *  our staged copies is the supported way to make voices work offline. */
const VOICE_CACHE = "kokoro-voices";
const VOICE_URL = (voice: string) =>
  `https://huggingface.co/${MODEL_ID}/resolve/main/voices/${voice}.bin`;

// -----------------------------------------------------------------------------
// Language gate
// -----------------------------------------------------------------------------

/** Whether Kokoro can speak this language at all. Anything else must stay on
 *  speechSynthesis — see the Hebrew note in the file header. */
export function supportsLanguage(lang: string | undefined): boolean {
  if (!lang) return false;
  return lang.split("-")[0].toLowerCase() === "en";
}

// -----------------------------------------------------------------------------
// Model loading
// -----------------------------------------------------------------------------

type KokoroModel = { generate: (text: string, opts: { voice: string; speed?: number }) => Promise<{ audio: Float32Array }> };

/** Seed the voice-style cache from locally staged files so a packaged/offline
 *  build never reaches for HuggingFace. Best-effort: CacheStorage is absent in
 *  insecure contexts and some test environments, and a miss just means kokoro-js
 *  fetches the vector itself (online) or the utterance falls back (offline). */
async function seedVoiceCache(voiceSource: (voice: string) => string): Promise<void> {
  if (typeof caches === "undefined") return;
  let cache: Cache;
  try {
    cache = await caches.open(VOICE_CACHE);
  } catch {
    return; // storage denied — kokoro-js handles the miss
  }
  for (const voice of Object.values(VOICE_BY_ROLE)) {
    const url = VOICE_URL(voice);
    try {
      if (await cache.match(url)) continue; // already seeded (or genuinely cached)
      const res = await fetch(voiceSource(voice), { cache: "no-store" });
      // A 200 of index.html is the SPA fallback, not a style vector — the
      // byte length check catches it (a real vector is ~510 KB).
      if (!res.ok) continue;
      const buf = await res.arrayBuffer();
      if (buf.byteLength < 100_000) continue;
      await cache.put(url, new Response(buf));
    } catch {
      // Any failure here is non-fatal by design; try the next voice.
    }
  }
}

async function instantiate(
  useLocal: boolean,
  base: string,
  onProgress?: (p: any) => void,
): Promise<KokoroModel> {
  const { KokoroTTS } = await import("kokoro-js");
  const tf: any = await import("@huggingface/transformers");
  const env = tf?.env;

  // Run inference off the main thread. Synthesis is CPU-heavy enough to stutter
  // the board mid-utterance otherwise — speechSynthesis was native and async, so
  // blocking here would be a visible regression against the path we're
  // replacing. Same proxy flag (and same spawn-failure retry) as the wavlm
  // loader in useVoiceIdentification.
  const setProxy = (on: boolean) => {
    try { if (env?.backends?.onnx?.wasm) env.backends.onnx.wasm.proxy = on; } catch { /* main thread it is */ }
  };
  setProxy(true);

  const load = () => withTransformersEnv(
    env,
    useLocal
      // Weights staged into the build (npm run kokoro:model before a build).
      // Not the normal path — it exists for a site that must install fully
      // offline and can't download anything at runtime.
      ? { allowLocal: true, allowRemote: false, localModelPath: base }
      // The normal path: fetch from OUR CloudFront and let transformers.js
      // persist the result in the browser Cache API, so this download happens
      // once per device rather than once per launch.
      : {
          allowLocal: false,
          allowRemote: true,
          remoteHost: MODEL_HOST,
          // A literal path with no {model}/{revision} placeholders — every
          // file request resolves under our versioned prefix.
          remotePathTemplate: MODEL_REMOTE_PATH,
          useBrowserCache: true,
        },
    () => KokoroTTS.from_pretrained(MODEL_ID, {
      dtype: MODEL_DTYPE,
      device: "wasm",
      progress_callback: onProgress,
    } as any) as Promise<any>,
  );

  try {
    return await load();
  } catch (err) {
    if (env?.backends?.onnx?.wasm?.proxy) {
      console.warn(`[KokoroTTS] proxy instantiate failed, retrying on main thread: ${(err as Error)?.message}`);
      setProxy(false);
      return await load();
    }
    throw err;
  }
}

// -----------------------------------------------------------------------------
// Speed gate
// -----------------------------------------------------------------------------

/** Set when this device has proven it cannot synthesize fast enough to be worth
 *  using. Sticky for the session: a device that is too slow now will still be
 *  too slow in a minute, and re-testing costs another slow utterance. */
let disabledReason: string | null = null;
let slowStreak = 0;

/** Records how long a synthesis took against how much audio it produced, and
 *  disables the voice if the device keeps missing MAX_RTF. Exported for tests. */
export function recordSynthesisTiming(ms: number, audioSeconds: number): void {
  if (audioSeconds <= 0) return;
  const rtf = ms / 1000 / audioSeconds;
  if (rtf <= MAX_RTF) {
    slowStreak = 0;
    return;
  }
  slowStreak++;
  console.warn(`[KokoroTTS] slow synthesis (RTF ${rtf.toFixed(2)} > ${MAX_RTF}) ${slowStreak}/${SLOW_STRIKES}`);
  if (slowStreak >= SLOW_STRIKES) {
    disabledReason = `too slow on this device (RTF ${rtf.toFixed(2)})`;
    console.warn(`[KokoroTTS] disabled for this session — ${disabledReason}; using speechSynthesis`);
  }
}

/** Why the neural voice took itself out of the ladder, or null if it is still
 *  eligible. Surfaced for tests and debug displays — a voice that silently
 *  stops being used is exactly the kind of thing we've been bitten by before. */
export function speedGateReason(): string | null {
  return disabledReason;
}

/** Test seam: forget any speed verdict so a case starts from a clean slate. */
export function resetSpeedGate(): void {
  disabledReason = null;
  slowStreak = 0;
}

/** Warm the graph and take the first measurement.
 *
 *  Two reasons this is not optional. The first generate() pays graph
 *  initialization on top of inference — measured at 4-7x steady state — so
 *  without a warmup the very first fallback press of a session is the slowest
 *  one the child will ever hear. And it is a free device benchmark: a machine
 *  that misses even the loose warmup bound is rejected before it can spoil a
 *  real utterance. */
async function warmup(model: KokoroModel): Promise<void> {
  const t0 = Date.now();
  try {
    const { audio } = await model.generate("Hello.", { voice: VOICE_BY_ROLE.student });
    const ms = Date.now() - t0;
    const secs = (audio?.length ?? 0) / SAMPLE_RATE;
    if (secs <= 0) return;
    const rtf = ms / 1000 / secs;
    console.log(`[KokoroTTS] warmup ${ms}ms for ${secs.toFixed(2)}s audio (RTF ${rtf.toFixed(2)})`);
    if (rtf > WARMUP_MAX_RTF) {
      disabledReason = `warmup RTF ${rtf.toFixed(2)} > ${WARMUP_MAX_RTF}`;
      console.warn(`[KokoroTTS] disabled — ${disabledReason}; using speechSynthesis`);
    }
  } catch (err) {
    // A warmup that throws is a broken install, not a slow device. Leave the
    // gate open: the loader will surface the real failure on first use, and
    // speak() degrades softly either way.
    console.warn("[KokoroTTS] warmup failed:", err);
  }
}

let loader: ModelLoader<KokoroModel> | null = null;

/** Download progress, 0..1, or null when no download is running. Rendered by
 *  the AAC so a ~94 MB fetch on a school connection isn't a silent stall. */
let downloadProgress: number | null = null;
const progressSubscribers = new Set<(p: number | null) => void>();

function setProgress(p: number | null): void {
  downloadProgress = p;
  for (const cb of progressSubscribers) {
    try { cb(p); } catch { /* subscriber's problem */ }
  }
}

/** Current download progress (0..1), or null when nothing is downloading. */
export function getDownloadProgress(): number | null {
  return downloadProgress;
}

/** Watch download progress. Fires immediately with the current value. */
export function subscribeDownloadProgress(cb: (p: number | null) => void): () => void {
  progressSubscribers.add(cb);
  cb(downloadProgress);
  return () => progressSubscribers.delete(cb);
}

/** transformers.js emits one progress event per file; the ONNX weights dwarf
 *  everything else, so tracking the largest active file is a good proxy for
 *  overall progress and avoids pretending to a precision we don't have. */
function handleLoadProgress(p: any): void {
  if (!p || p.status !== "progress" || typeof p.progress !== "number") return;
  if (typeof p.total === "number" && p.total < 10_000_000) return; // ignore the small config files
  setProgress(Math.max(0, Math.min(1, p.progress / 100)));
}

/** The retrying loader for the Kokoro model. Shared with the rest of the app's
 *  on-device models (lib/modelLoader.ts) so a transient failure retries on
 *  backoff instead of disabling the voice for the whole session. */
export function getKokoroLoader(): ModelLoader<KokoroModel> {
  if (!loader) {
    loader = createModelLoader("kokoro-tts", async () => {
      const base = localModelBase();
      // Staged-into-the-build weights win when present (offline installs);
      // otherwise the device downloads them from our CDN.
      const useLocal = await hasLocalModel(base, MODEL_ID);
      await seedVoiceCache(
        useLocal
          ? (v) => `${base}${MODEL_ID}/voices/${v}.bin`
          : (v) => `${MODEL_HOST}${MODEL_REMOTE_PATH}/voices/${v}.bin`,
      );
      setProgress(useLocal ? null : 0);
      try {
        const model = await instantiate(useLocal, base, handleLoadProgress);
        console.log(`[KokoroTTS] loaded from ${useLocal ? "bundle" : "CDN"}: ${MODEL_ID}`);
        await warmup(model);
        return model;
      } finally {
        setProgress(null);
      }
    });
  }
  return loader;
}

/**
 * Acquire the voice on THIS DEVICE.
 *
 * The enable switch is a per-STUDENT setting (aac_settings.localVoiceEnabled)
 * that lives on the server, but the weights are per-DEVICE — a clinician
 * flipping the toggle downloads nothing by itself. So the AAC calls this when
 * it sees the setting on, and every device the student uses acquires the model
 * once, on its own, into its own browser cache.
 *
 * Idempotent and safe to call on every session start: after the first success
 * the model is in memory, and after the first download the bytes are in the
 * Cache API, so subsequent calls cost nothing. Never throws — the loader
 * retries on backoff and `speak()` keeps declining until something lands.
 */
export function ensureVoiceDownloaded(): void {
  allowedForCurrentStudent = true;
  getKokoroLoader().preload();
}

/** Whether the student at the device RIGHT NOW is allowed the neural voice.
 *
 *  Downloading and using are separate permissions because the model is cached
 *  per device but the setting is per student. On a shared classroom tablet, one
 *  student enabling the voice loads it into memory for the whole app — without
 *  this flag the next student would inherit a voice their clinician never chose.
 *  Defaults to false, so a student is opted in only by their own setting. */
let allowedForCurrentStudent = false;

/** Called when the active student changes or their setting is off. The weights
 *  stay cached (re-downloading 94 MB per student switch would be absurd); only
 *  permission to speak with them is withdrawn. */
export function setVoiceAllowed(allowed: boolean): void {
  allowedForCurrentStudent = allowed;
}

/** Whether a Kokoro utterance can be produced RIGHT NOW. Callers use this to
 *  decide without waiting: the fallback voice is already the unhappy path, so
 *  blocking a press on a model download would make a bad moment worse. */
export function isReady(): boolean {
  if (disabledReason || !allowedForCurrentStudent) return false;
  return getKokoroLoader().tryGet() !== null;
}

// -----------------------------------------------------------------------------
// Playback
// -----------------------------------------------------------------------------

let audioCtx: AudioContext | null = null;
let current: AudioBufferSourceNode | null = null;

function getAudioContext(): AudioContext | null {
  try {
    if (!audioCtx) {
      const Ctor = window.AudioContext || (window as any).webkitAudioContext;
      if (!Ctor) return null;
      audioCtx = new Ctor();
    }
    // Autoplay policy can leave the context suspended until a gesture. Presses
    // are gestures, so this normally resolves immediately.
    if (audioCtx.state === "suspended") void audioCtx.resume().catch(() => {});
    return audioCtx;
  } catch {
    return null;
  }
}

/** Stop any Kokoro utterance in flight. Mirrors speechSynthesis.cancel() for
 *  the callers that supersede one utterance with the next. */
export function cancel(): void {
  try { current?.stop(); } catch { /* already ended */ }
  current = null;
}

function play(samples: Float32Array): Promise<void> {
  return new Promise((resolve) => {
    const ctx = getAudioContext();
    if (!ctx || samples.length === 0) { resolve(); return; }
    try {
      const buffer = ctx.createBuffer(1, samples.length, SAMPLE_RATE);
      buffer.copyToChannel(samples, 0);
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(ctx.destination);
      // Resolve on end OR on supersede — the caller's promise chain must not
      // stall behind an utterance that was cancelled mid-word.
      src.onended = () => {
        if (current === src) current = null;
        resolve();
      };
      cancel();
      current = src;
      src.start();
    } catch (err) {
      console.warn("[KokoroTTS] playback failed:", err);
      resolve();
    }
  });
}

// -----------------------------------------------------------------------------
// Entry point
// -----------------------------------------------------------------------------

/**
 * Speak `text` with the local neural voice.
 *
 * Returns TRUE if the utterance was synthesized and played, FALSE if this path
 * declined or failed — in which case the caller MUST fall back to
 * speechSynthesis. Never throws and never leaves the caller waiting on a voice
 * that isn't coming: every refusal is immediate and explicit.
 */
export async function speak(
  text: string,
  lang: string,
  role: "ai" | "student",
  opts?: {
    /** Fired the instant audio starts leaving the speaker (never on a refusal
     *  or a failure). The caller uses it to hold the mic gate for exactly the
     *  span this voice is audible — synthesis runs first and can take a second,
     *  and a gate raised for that dead time is a second of deafness per press. */
    onStart?: () => void;
  },
): Promise<boolean> {
  if (!text.trim()) return false;
  if (!supportsLanguage(lang)) return false;
  if (!allowedForCurrentStudent) return false;
  if (disabledReason) return false;

  // Deliberately tryGet, not get(): get() waits for a download that may be
  // minutes away (or never, if the model was never staged), and a press cannot
  // wait. An unready model means "speechSynthesis this time" — the next press
  // gets the good voice once the background load lands.
  const model = getKokoroLoader().tryGet();
  if (!model) return false;

  try {
    const t0 = Date.now();
    const { audio } = await model.generate(text, { voice: VOICE_BY_ROLE[role] });
    if (!audio?.length) return false;
    // Measure BEFORE playing — playback duration is the audio's own length and
    // would swamp the synthesis cost we're actually gating on.
    recordSynthesisTiming(Date.now() - t0, audio.length / SAMPLE_RATE);
    opts?.onStart?.();
    await play(audio);
    return true;
  } catch (err) {
    console.warn("[KokoroTTS] synthesis failed, falling back to speechSynthesis:", err);
    return false;
  }
}

// -----------------------------------------------------------------------------
// Debug helpers
// -----------------------------------------------------------------------------
//
// The path this service sits on only fires when EVERY cloud TTS provider has
// already failed, which is not a state anyone can conjure on demand. Without a
// way in, "does the neural voice work" is untestable short of breaking the
// providers on purpose. So, matching the window-hook convention used elsewhere
// in the client (see SocialBotContext), in the browser console:
//
//   await window.__kokoroSay("I want to go outside")   // hear it; true = neural
//   window.__kokoroStatus()                            // loader + speed verdict
//
// __kokoroSay reports FALSE when the service declined — the reason is in
// __kokoroStatus() and in the console warnings above it.

export function installKokoroDebugHooks(): void {
  if (typeof window === "undefined") return;
  (window as any).__kokoroSay = async (text: string, role: "ai" | "student" = "student") => {
    const t0 = Date.now();
    const spoke = await speak(text, "en-US", role);
    console.log(
      spoke
        ? `[KokoroTTS] __kokoroSay spoke "${text}" as ${role} in ${Date.now() - t0}ms (incl. playback)`
        : `[KokoroTTS] __kokoroSay DECLINED — see __kokoroStatus()`,
    );
    return spoke;
  };
  (window as any).__kokoroStatus = () => {
    const status = {
      loader: getKokoroLoader().status(),
      ready: isReady(),
      disabled: speedGateReason(),
      voices: VOICE_BY_ROLE,
      dtype: MODEL_DTYPE,
    };
    console.log("[KokoroTTS] status:", status);
    return status;
  };
}
