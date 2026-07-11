/**
 * prepare-client-models.mjs — Stage every self-hosted on-device model runtime
 * the AAC client needs into client-aac/public/, so nothing is fetched from a
 * CDN at runtime. Wired into all client build/dev paths (dev, client-aac:dev,
 * build:client-aac, electron:build); supersedes copy-ort-wasm.mjs.
 *
 * 1. onnxruntime-web WASM (node_modules copy) -> public/ort/
 *    The .wasm binary AND its .mjs loader glue — the runtime fetches BOTH
 *    from env.wasm.wasmPaths. Vite can't emit them itself (the /wasm bundle
 *    constructs the filenames dynamically), so sileroVad.ts pins wasmPaths to
 *    <base>/ort/ and this stages it. Missing => Silero VAD silently degrades
 *    to energy detection (this exact gap shipped in the first staging build).
 *
 * 2. MediaPipe tasks-vision WASM (node_modules copy) -> public/mediapipe/wasm/
 *    Used by visionTasks.ts (FaceMirror, pose, hand/gesture) instead of
 *    cdn.jsdelivr.net. The copy is version-locked to the installed package,
 *    which matches the CDN fallback pin in visionTasks.ts.
 *
 * 3. MediaPipe .task models (downloaded, pinned URLs) -> public/models/mediapipe/
 *    face/pose/gesture models, ~17 MB total. Downloaded once and kept (the
 *    URLs are version-pinned and immutable); offline builds keep whatever is
 *    already staged.
 *
 * Idempotent, and never fails the build: every asset here has a graceful
 * runtime degradation (CDN fallback or energy VAD), so a broken staging step
 * should degrade the app, not brick the pipeline. It logs loudly instead.
 * Larger optional models (wavlm ~102 MB, whisper ~250 MB) stay in their own
 * scripts: voice:model / whisper:model.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const publicDir = path.join(root, "client-aac", "public");

let problems = 0;

function stageCopy(label, srcDir, destDir, files) {
  for (const file of files) {
    try {
      const src = path.join(srcDir, file);
      const dest = path.join(destDir, file);
      const srcStat = fs.statSync(src);
      const destStat = fs.existsSync(dest) ? fs.statSync(dest) : null;
      if (destStat && destStat.size === srcStat.size) {
        console.log(`[client-models] ${label}: ${file} up to date (${(srcStat.size / 1e6).toFixed(1)} MB)`);
      } else {
        fs.mkdirSync(destDir, { recursive: true });
        fs.copyFileSync(src, dest);
        console.log(`[client-models] ${label}: copied ${file} (${(srcStat.size / 1e6).toFixed(1)} MB)`);
      }
    } catch (err) {
      problems++;
      console.warn(`[client-models] ${label}: ${file} SKIPPED (${err.message})`);
    }
  }
}

async function stageDownload(label, url, dest) {
  try {
    if (fs.existsSync(dest) && fs.statSync(dest).size > 100_000) {
      console.log(`[client-models] ${label}: present (${(fs.statSync(dest).size / 1e6).toFixed(1)} MB)`);
      return;
    }
    console.log(`[client-models] ${label}: downloading ${url}`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, buf);
    console.log(`[client-models] ${label}: wrote ${path.basename(dest)} (${(buf.length / 1e6).toFixed(1)} MB)`);
  } catch (err) {
    problems++;
    console.warn(`[client-models] ${label}: download FAILED (${err.message}) — runtime will fall back to the CDN`);
  }
}

// --- 1. onnxruntime-web WASM (Silero VAD) ------------------------------------
stageCopy(
  "ort",
  path.join(root, "node_modules", "onnxruntime-web", "dist"),
  path.join(publicDir, "ort"),
  ["ort-wasm-simd-threaded.wasm", "ort-wasm-simd-threaded.mjs"],
);

// --- 2. MediaPipe tasks-vision WASM ------------------------------------------
stageCopy(
  "mediapipe-wasm",
  path.join(root, "node_modules", "@mediapipe", "tasks-vision", "wasm"),
  path.join(publicDir, "mediapipe", "wasm"),
  [
    "vision_wasm_internal.js",
    "vision_wasm_internal.wasm",
    "vision_wasm_nosimd_internal.js",
    "vision_wasm_nosimd_internal.wasm",
  ],
);

// --- 3. MediaPipe .task models (pinned, immutable URLs) -----------------------
// Keep in lockstep with CDN_MODEL_URLS in client-aac/src/lib/visionTasks.ts.
const MEDIAPIPE_MODELS = {
  "face_landmarker.task":
    "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
  "pose_landmarker_lite.task":
    "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task",
  "gesture_recognizer.task":
    "https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task",
};
for (const [file, url] of Object.entries(MEDIAPIPE_MODELS)) {
  await stageDownload(`mediapipe-model ${file}`, url, path.join(publicDir, "models", "mediapipe", file));
}

if (problems > 0) {
  console.warn(`[client-models] finished with ${problems} problem(s) — see warnings above (build continues)`);
} else {
  console.log("[client-models] all client model assets staged");
}
