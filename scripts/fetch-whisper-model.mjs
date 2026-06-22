/**
 * fetch-whisper-model.mjs — Download the on-device speech-to-text model used by
 * the AAC cost-saving system (client-aac useSpeechTranscription) into the Vite
 * public dir so it ships INSIDE the Electron app and works offline.
 *
 * Why bundle (not just CDN):
 *  1. Offline / instant load on kiosks.
 *  2. transformers.js uses a single GLOBAL `env`. The voice model is bundled
 *     (loads local), so it sets env.allowLocalModels=true. If Whisper isn't also
 *     local, the shared global can make Whisper try to resolve from the (absent)
 *     local path — and SPA hosting returns index.html with a 200 for the missing
 *     file, so transformers.js JSON.parses HTML ("Unexpected token '<'"). Having
 *     BOTH models local removes that divergence.
 *
 * Files land at client-aac/public/models/Xenova/whisper-base/ — the layout
 * transformers.js expects under env.localModelPath="/models". Vite copies
 * public/ into the build output, so electron-builder packages them.
 *
 * We ship the q8-quantized ONNX (dtype "q8" in the hook). Idempotent: skips
 * files already present at the expected size. In a CDN-only deploy (web) this
 * isn't needed — the hook falls back to the HF CDN.
 *
 * Override the source with WHISPER_MODEL_BASE_URL (e.g. an internal mirror).
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const MODEL_ID = "Xenova/whisper-small";
const BASE_URL =
  process.env.WHISPER_MODEL_BASE_URL ||
  `https://huggingface.co/${MODEL_ID}/resolve/main`;

const destDir = path.join(root, "client-aac", "public", "models", "Xenova", "whisper-small");

// Every file the ASR pipeline may request. transformers.js only requests files
// that exist in the repo, so a 404 here means "not in the repo" → it won't be
// requested at runtime either → safe to skip (non-fatal). The two ONNX graphs
// (q8 encoder + merged decoder) and config.json are the hard requirements.
const FILES = [
  { rel: "config.json", required: true },
  { rel: "generation_config.json" },
  { rel: "preprocessor_config.json", required: true },
  { rel: "tokenizer.json", required: true },
  { rel: "tokenizer_config.json" },
  { rel: "special_tokens_map.json" },
  { rel: "added_tokens.json" },
  { rel: "normalizer.json" },
  { rel: "merges.txt" },
  { rel: "vocab.json" },
  { rel: "onnx/encoder_model_quantized.onnx", required: true, onnx: true },
  { rel: "onnx/decoder_model_merged_quantized.onnx", required: true, onnx: true },
];

// Below this an existing ONNX is treated as a truncated/failed prior download.
const MIN_ONNX_BYTES = 5_000_000;

async function download({ rel, required, onnx }) {
  const url = `${BASE_URL}/${rel}`;
  const target = path.join(destDir, rel);

  if (fs.existsSync(target)) {
    const size = fs.statSync(target).size;
    if (!onnx || size >= MIN_ONNX_BYTES) {
      console.log(`[whisper-model] present: ${rel} (${(size / 1e6).toFixed(2)} MB)`);
      return true;
    }
    console.log(`[whisper-model] re-downloading truncated ${rel} (${size} bytes)`);
  }

  console.log(`[whisper-model] downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) {
    if (required) {
      throw new Error(`Download failed (${res.status} ${res.statusText}) for required ${url}`);
    }
    console.log(`[whisper-model] skip (not in repo): ${rel} (${res.status})`);
    return false;
  }
  const buf = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, buf);
  console.log(`[whisper-model] wrote ${rel} (${(buf.length / 1e6).toFixed(2)} MB)`);
  return true;
}

async function main() {
  for (const f of FILES) await download(f);
  console.log(`[whisper-model] model ready at ${destDir}`);
}

main().catch((e) => {
  console.error("[whisper-model] ERROR:", e.message);
  process.exit(1);
});
