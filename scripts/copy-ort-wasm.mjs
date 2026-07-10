/**
 * copy-ort-wasm.mjs — Stage the onnxruntime-web WASM runtime (the .wasm
 * binary AND its .mjs loader glue — the runtime fetches BOTH from
 * env.wasm.wasmPaths) into the AAC client's public dir so the Silero VAD
 * (client-aac/src/lib/sileroVad.ts) can load it from a deterministic
 * self-hosted URL.
 *
 * Why not let Vite resolve it: the `onnxruntime-web/wasm` bundle constructs
 * these filenames dynamically in minified code, so Vite's static analysis
 * never emits the assets — the runtime would 404 and the VAD would silently
 * fall back to energy detection. sileroVad.ts instead pins
 * `env.wasm.wasmPaths` to `<base>/ort/`, which this script populates straight
 * from node_modules (no download).
 *
 * Wired into the client-aac build scripts; run manually after an
 * onnxruntime-web upgrade in dev (`node scripts/copy-ort-wasm.mjs`).
 * Idempotent (skips when sizes match) and never fails the build — a missing
 * runtime only degrades speech detection, it doesn't break the app.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const FILES = ["ort-wasm-simd-threaded.wasm", "ort-wasm-simd-threaded.mjs"];
const SRC_DIR = path.join(root, "node_modules", "onnxruntime-web", "dist");
const DEST_DIR = path.join(root, "client-aac", "public", "ort");

for (const file of FILES) {
  try {
    const src = path.join(SRC_DIR, file);
    const dest = path.join(DEST_DIR, file);
    const srcStat = fs.statSync(src);
    const destStat = fs.existsSync(dest) ? fs.statSync(dest) : null;
    if (destStat && destStat.size === srcStat.size) {
      console.log(`[copy-ort-wasm] ${file} up to date (${(srcStat.size / 1024 / 1024).toFixed(1)} MB)`);
    } else {
      fs.mkdirSync(DEST_DIR, { recursive: true });
      fs.copyFileSync(src, dest);
      console.log(`[copy-ort-wasm] copied ${file} (${(srcStat.size / 1024 / 1024).toFixed(1)} MB) -> client-aac/public/ort/`);
    }
  } catch (err) {
    console.warn(`[copy-ort-wasm] ${file} skipped (${err.message}) — Silero VAD will fall back to energy detection`);
  }
}
