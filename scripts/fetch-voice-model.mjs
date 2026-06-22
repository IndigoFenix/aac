/**
 * fetch-voice-model.mjs — Download the speaker-embedding model used by the AAC
 * voice-recognition system (client-aac useVoiceIdentification) into the Vite
 * public dir so it ships INSIDE the Electron app and works offline.
 *
 * We bundle the INT8-quantized ONNX (~102 MB) rather than the fp32 export
 * (~402 MB): speaker-verification embeddings are coarse "who is this" vectors
 * and tolerate int8 quantization with no meaningful loss, at a quarter the size.
 *
 * The files land at client-aac/public/models/Xenova/wavlm-base-plus-sv/ — the
 * exact layout transformers.js expects under env.localModelPath="/models". Vite
 * copies public/ into the build output, so electron-builder packages them.
 *
 * Idempotent: skips files already present at the expected size. In dev (no
 * packaged build) this isn't run, and the hook falls back to the HF CDN.
 *
 * Override the source with VOICE_MODEL_BASE_URL (e.g. an internal mirror).
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const MODEL_ID = "Xenova/wavlm-base-plus-sv";
const BASE_URL =
  process.env.VOICE_MODEL_BASE_URL ||
  `https://huggingface.co/${MODEL_ID}/resolve/main`;

const destDir = path.join(root, "client-aac", "public", "models", "Xenova", "wavlm-base-plus-sv");

// Paths are relative to the model repo root. Only the quantized ONNX is large;
// the configs are a few KB each and are required by the processor/model loader.
const FILES = [
  "config.json",
  "preprocessor_config.json",
  "quantize_config.json",
  "onnx/model_quantized.onnx",
];

// Below this, an existing file is treated as a truncated/failed prior download
// and re-fetched. The quantized ONNX is ~102 MB; configs are tiny.
const MIN_ONNX_BYTES = 50_000_000;

async function download(relPath) {
  const url = `${BASE_URL}/${relPath}`;
  const target = path.join(destDir, relPath);
  const isOnnx = relPath.endsWith(".onnx");

  if (fs.existsSync(target)) {
    const size = fs.statSync(target).size;
    if (!isOnnx || size >= MIN_ONNX_BYTES) {
      console.log(`[voice-model] present: ${relPath} (${(size / 1e6).toFixed(1)} MB)`);
      return;
    }
    console.log(`[voice-model] re-downloading truncated ${relPath} (${size} bytes)`);
  }

  fs.mkdirSync(path.dirname(target), { recursive: true });
  console.log(`[voice-model] downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Download failed (${res.status} ${res.statusText}) for ${url}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(target, buf);
  console.log(`[voice-model] wrote ${relPath} (${(buf.length / 1e6).toFixed(1)} MB)`);
}

async function main() {
  for (const f of FILES) await download(f);
  console.log(`[voice-model] model ready at ${destDir}`);
}

main().catch((e) => {
  console.error("[voice-model] ERROR:", e.message);
  process.exit(1);
});
