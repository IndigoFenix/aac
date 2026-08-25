/**
 * fetch-kokoro-model.mjs — Download the Kokoro-82M neural TTS voice used by the
 * AAC client's local-speech path (client-aac/src/services/kokoroTts.ts) into
 * the Vite public dir so it ships INSIDE the Electron app and works offline.
 *
 * WHY THIS EXISTS
 * The client's last-resort voice used to be the browser's own speechSynthesis,
 * which on a packaged Electron kiosk means the OS OneCore/SAPI voices — the old
 * robotic generation. Kokoro is an 82M-parameter neural TTS that runs in
 * onnxruntime-web at roughly real time on CPU, so a fallback press now gets a
 * natural voice instead of a mechanical one.
 *
 * ENGLISH ONLY, DELIBERATELY. Kokoro ships en-us/en-gb voices and nothing else.
 * Hebrew stays on speechSynthesis until we have a Hebrew acoustic model we can
 * actually ship — every good open Hebrew voice audited so far (MMS-TTS-heb,
 * OmniVoice) is CC-BY-NC, i.e. unusable in a product. kokoroTts.ts enforces the
 * language gate; this script only stages the weights.
 *
 * LICENSING (all permissive — checked 2026-08-25):
 *   weights  onnx-community/Kokoro-82M-v1.0-ONNX  Apache-2.0
 *   runtime  kokoro-js 1.2.1                      Apache-2.0
 *   G2P      phonemizer 1.2.1 (eSpeak NG rules)   Apache-2.0
 *
 * We bundle the q8-quantized ONNX (~92 MB) rather than fp32 (~326 MB). The
 * fp16 variants are smaller still but rely on fp16 kernels that the WASM
 * execution provider does not implement uniformly; q8 is the safe CPU choice.
 *
 * Files land at client-aac/public/models/onnx-community/Kokoro-82M-v1.0-ONNX/ —
 * the exact layout transformers.js expects under env.localModelPath="/models",
 * matching fetch-voice-model.mjs. Vite copies public/ into the build output, so
 * electron-builder packages them.
 *
 * Idempotent: skips files already present at a plausible size. Not wired into
 * the default build — like voice:model and whisper:model this is opt-in
 * (`npm run kokoro:model`), because it is a ~94 MB installer-size decision.
 * When it hasn't run, kokoroTts.ts finds no local model and the client falls
 * back to speechSynthesis exactly as before.
 *
 * Override the source with KOKORO_MODEL_BASE_URL (e.g. an internal mirror).
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";
const BASE_URL =
  process.env.KOKORO_MODEL_BASE_URL ||
  `https://huggingface.co/${MODEL_ID}/resolve/main`;

const destDir = path.join(root, "client-aac", "public", "models", ...MODEL_ID.split("/"));

/** Style vectors, one per voice, ~510 KB each. Only the voices kokoroTts.ts can
 *  actually select are staged — the upstream repo has 55 and we'd be shipping
 *  27 MB of unreachable ones. KEEP IN SYNC with VOICE_BY_ROLE in kokoroTts.ts;
 *  a voice named there but missing here silently falls back to the CDN fetch
 *  (and offline, to speechSynthesis). */
const VOICES = ["af_heart", "af_bella", "am_puck", "am_michael"];

// Relative to the model repo root. dtype "q8" in transformers.js resolves to
// onnx/model_quantized.onnx — changing one without the other breaks the load.
const FILES = [
  "config.json",
  "tokenizer.json",
  "tokenizer_config.json",
  "onnx/model_quantized.onnx",
  ...VOICES.map((v) => `voices/${v}.bin`),
];

// Below these, an existing file is treated as a truncated/failed prior download
// and re-fetched. The quantized ONNX is ~92 MB; a style vector is ~510 KB.
const MIN_ONNX_BYTES = 50_000_000;
const MIN_VOICE_BYTES = 100_000;

function minBytesFor(relPath) {
  if (relPath.endsWith(".onnx")) return MIN_ONNX_BYTES;
  if (relPath.endsWith(".bin")) return MIN_VOICE_BYTES;
  return 0;
}

async function download(relPath) {
  const url = `${BASE_URL}/${relPath}`;
  const target = path.join(destDir, relPath);
  const min = minBytesFor(relPath);

  if (fs.existsSync(target)) {
    const size = fs.statSync(target).size;
    if (size >= min) {
      console.log(`[kokoro-model] present: ${relPath} (${(size / 1e6).toFixed(1)} MB)`);
      return;
    }
    console.log(`[kokoro-model] re-downloading truncated ${relPath} (${size} bytes)`);
  }

  fs.mkdirSync(path.dirname(target), { recursive: true });
  console.log(`[kokoro-model] downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Download failed (${res.status} ${res.statusText}) for ${url}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(target, buf);
  console.log(`[kokoro-model] wrote ${relPath} (${(buf.length / 1e6).toFixed(1)} MB)`);
}

async function main() {
  for (const f of FILES) await download(f);
  console.log(`[kokoro-model] model ready at ${destDir}`);
}

main().catch((e) => {
  console.error("[kokoro-model] ERROR:", e.message);
  process.exit(1);
});
