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
async function seedVoiceCache(base: string): Promise<void> {
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
      const res = await fetch(`${base}${MODEL_ID}/voices/${voice}.bin`, { cache: "no-store" });
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

async function instantiate(useLocal: boolean, base: string): Promise<KokoroModel> {
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
      ? { allowLocal: true, allowRemote: false, localModelPath: base }
      : { allowLocal: false, allowRemote: true },
    () => KokoroTTS.from_pretrained(MODEL_ID, { dtype: MODEL_DTYPE, device: "wasm" } as any) as Promise<any>,
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

/** The retrying loader for the Kokoro model. Shared with the rest of the app's
 *  on-device models (lib/modelLoader.ts) so a transient failure retries on
 *  backoff instead of disabling the voice for the whole session. */
export function getKokoroLoader(): ModelLoader<KokoroModel> {
  if (!loader) {
    loader = createModelLoader("kokoro-tts", async () => {
      const base = localModelBase();
      const useLocal = await hasLocalModel(base, MODEL_ID);
      if (useLocal) await seedVoiceCache(base);
      const model = await instantiate(useLocal, base);
      console.log(`[KokoroTTS] loaded from ${useLocal ? "bundle" : "CDN"}: ${MODEL_ID}`);
      await warmup(model);
      return model;
    });
  }
  return loader;
}

/**
 * Start loading in the background — but ONLY if the weights are actually staged
 * on this device.
 *
 * The gate matters: the quantized model is ~92 MB, and an ungated preload would
 * pull that from HuggingFace on every dev session and every unstaged
 * deployment, to improve a voice that is only ever reached when the cloud
 * providers are already down. So local presence is the switch — stage the model
 * (`npm run kokoro:model`) and the neural voice turns itself on; don't, and the
 * client behaves exactly as it did before, on speechSynthesis.
 *
 * `speak()` only ever calls tryGet(), so nothing else can trigger a load: this
 * function is the single place the model is allowed to start downloading.
 */
export function preloadKokoroTts(): void {
  void (async () => {
    const base = localModelBase();
    if (!(await hasLocalModel(base, MODEL_ID))) {
      console.log("[KokoroTTS] weights not staged — local voice stays on speechSynthesis");
      return;
    }
    getKokoroLoader().preload();
  })();
}

/** Whether a Kokoro utterance can be produced RIGHT NOW. Callers use this to
 *  decide without waiting: the fallback voice is already the unhappy path, so
 *  blocking a press on a model download would make a bad moment worse. */
export function isReady(): boolean {
  if (disabledReason) return false;
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
): Promise<boolean> {
  if (!text.trim()) return false;
  if (!supportsLanguage(lang)) return false;
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
    await play(audio);
    return true;
  } catch (err) {
    console.warn("[KokoroTTS] synthesis failed, falling back to speechSynthesis:", err);
    return false;
  }
}
