// scripts/lib/face-embed.ts
//
// Node-side face detection + 128-D descriptor extraction that mirrors the
// CLIENT pipelines, so a descriptor recomputed here is directly comparable
// (euclidean distance) with everything already stored in biometric_data.
//
// WHY THIS EXISTS
// ---------------
// The live system has NO server-side embedding path: the clinician client
// computes the 128-D descriptor with @vladmandic/face-api in the browser and
// POSTs it alongside the photo (client/src/lib/biometricImage.ts →
// server/services/biometric/photo-upload.ts, which just stores what it is
// given). When an anchor is lost, the only way to recover it from the stored
// photo is to re-run that same computation somewhere. This module is that
// "somewhere" — offline tooling only, never imported by server/ or client/.
//
// COMPATIBILITY
// -------------
// Descriptor values come from `faceRecognitionNet`, and both clients load its
// weights from https://cdn.jsdelivr.net/npm/@vladmandic/face-api/model — the
// `model/` directory shipped inside the npm package. We load the very same
// files off disk from node_modules, so the weights are bit-identical.
//
// The two clients differ only in how they FIND and ALIGN the face:
//   enrollment (client/src/lib/biometricImage.ts) — ssdMobilenetv1 + full
//     faceLandmark68Net. This is what produced every stored `face_embedding`
//     anchor, so it is the default here.
//   aac (client-aac/src/hooks/usePersonIdentification.ts) — tinyFaceDetector
//     (inputSize 224, scoreThreshold 0.5) + faceLandmark68TinyNet. This is
//     what produces the live probes and the `face_embeddings` gallery.
// Alignment shifts the descriptor slightly, so callers can compute both and
// compare.
//
// RUNTIME
// -------
// @vladmandic/face-api's `node-wasm` build on @tensorflow/tfjs's pure-JS CPU
// backend. No native modules (no tfjs-node, no node-canvas) — this has to run
// on a Windows dev box without a build toolchain. Images are decoded with
// `sharp` (already a project dependency) straight into a tf.Tensor3D; face-api
// takes the tensor path (extractFaceTensors) instead of the canvas path, so no
// DOM shim is needed.
//
// Note: the node-wasm bundle `require`s @tensorflow/tfjs-backend-wasm at load
// time even though we run on 'cpu', so that package must stay installed. It is
// only registering a backend we never select — no .wasm file is ever fetched.
// All three packages are root devDependencies; nothing under server/ or
// client/ imports them.

import { createRequire } from "module";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import sharp from "sharp";

const require = createRequire(import.meta.url);

/* eslint-disable @typescript-eslint/no-explicit-any */
// Lazily required: pulling in tfjs costs seconds, and callers that only want
// euclideanDistance() (scripts/evict-gallery-pose.ts) should not pay it.
let faceapi: any;
let tf: any;
function runtime(): { faceapi: any; tf: any } {
  if (!faceapi) {
    faceapi = require("@vladmandic/face-api/dist/face-api.node-wasm.js");
    tf = faceapi.tf;
  }
  return { faceapi, tf };
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");

/** Weights shipped inside the npm package — identical to what the CDN serves. */
const PACKAGED_MODEL_DIR = path.join(REPO_ROOT, "node_modules", "@vladmandic", "face-api", "model");
/** Download cache, used only if the packaged copy is missing. */
const CACHE_MODEL_DIR = path.join(REPO_ROOT, "scripts", "face-models");
const GITHUB_MODEL_BASE = "https://raw.githubusercontent.com/vladmandic/face-api/master/model";

export type FacePipeline = "enrollment" | "aac";

/** Weight files each pipeline needs (manifest + its single shard). */
const MODEL_FILES: Record<FacePipeline, string[]> = {
  enrollment: [
    "ssd_mobilenetv1_model-weights_manifest.json",
    "ssd_mobilenetv1_model.bin",
    "face_landmark_68_model-weights_manifest.json",
    "face_landmark_68_model.bin",
    "face_recognition_model-weights_manifest.json",
    "face_recognition_model.bin",
  ],
  aac: [
    "tiny_face_detector_model-weights_manifest.json",
    "tiny_face_detector_model.bin",
    "face_landmark_68_tiny_model-weights_manifest.json",
    "face_landmark_68_tiny_model.bin",
    "face_recognition_model-weights_manifest.json",
    "face_recognition_model.bin",
  ],
};

/** Mirrors client/src/lib/biometricImage.ts MAX_DETECT_SIZE. */
const MAX_DETECT_SIZE = 800;
/** Mirrors client-aac/src/hooks/usePersonIdentification.ts detector options. */
const AAC_INPUT_SIZE = 224;
const AAC_SCORE_THRESHOLD = 0.5;

let backendReady: Promise<string> | null = null;
const loadedPipelines = new Set<FacePipeline>();
let resolvedModelDir: string | null = null;

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Locate the weight files. Prefers the copy inside node_modules (guaranteed to
 * match what the clients pull from the CDN); otherwise downloads the needed
 * files once into scripts/face-models/ and caches them there.
 */
async function ensureModelDir(pipeline: FacePipeline, log: (s: string) => void): Promise<string> {
  if (resolvedModelDir) return resolvedModelDir;

  const needed = MODEL_FILES[pipeline];
  const packagedOk = await Promise.all(needed.map((f) => exists(path.join(PACKAGED_MODEL_DIR, f))));
  if (packagedOk.every(Boolean)) {
    resolvedModelDir = PACKAGED_MODEL_DIR;
    log(`[face-embed] models: ${PACKAGED_MODEL_DIR} (shipped with @vladmandic/face-api)`);
    return resolvedModelDir;
  }

  await fs.mkdir(CACHE_MODEL_DIR, { recursive: true });
  for (const file of needed) {
    const dest = path.join(CACHE_MODEL_DIR, file);
    if (await exists(dest)) continue;
    const url = `${GITHUB_MODEL_BASE}/${file}`;
    log(`[face-embed] downloading ${file} …`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to download ${url}: HTTP ${res.status}`);
    await fs.writeFile(dest, Buffer.from(await res.arrayBuffer()));
  }
  resolvedModelDir = CACHE_MODEL_DIR;
  log(`[face-embed] models: ${CACHE_MODEL_DIR} (downloaded cache)`);
  return resolvedModelDir;
}

async function ensureBackend(log: (s: string) => void): Promise<string> {
  if (!backendReady) {
    backendReady = (async () => {
      const { tf } = runtime();
      // Pure-JS CPU kernels. Slow but dependency-free, and we run one image.
      await tf.setBackend("cpu");
      await tf.ready();
      const backend = tf.getBackend();
      log(`[face-embed] tfjs ${tf.version.tfjs ?? "?"} backend=${backend}`);
      return backend;
    })();
  }
  return backendReady;
}

/** Load the nets for a pipeline (idempotent). */
export async function loadFaceModels(
  pipeline: FacePipeline,
  log: (s: string) => void = console.log,
): Promise<void> {
  await ensureBackend(log);
  if (loadedPipelines.has(pipeline)) return;
  const { faceapi } = runtime();
  const dir = await ensureModelDir(pipeline, log);

  if (pipeline === "enrollment") {
    await faceapi.nets.ssdMobilenetv1.loadFromDisk(dir);
    await faceapi.nets.faceLandmark68Net.loadFromDisk(dir);
  } else {
    await faceapi.nets.tinyFaceDetector.loadFromDisk(dir);
    await faceapi.nets.faceLandmark68TinyNet.loadFromDisk(dir);
  }
  if (!faceapi.nets.faceRecognitionNet.isLoaded) {
    await faceapi.nets.faceRecognitionNet.loadFromDisk(dir);
  }
  loadedPipelines.add(pipeline);
  log(`[face-embed] loaded '${pipeline}' nets`);
}

export interface FaceExtraction {
  pipeline: FacePipeline;
  /** 128-D face descriptor — directly comparable with stored embeddings. */
  descriptor: number[];
  /** Raw detector confidence. The clinician upload stores this as faceImageQuality. */
  detectionScore: number;
  /** assessFaceQuality() equivalent — what the AAC gallery records as `quality`. */
  quality: number;
  box: { x: number; y: number; width: number; height: number };
  imageWidth: number;
  imageHeight: number;
  /** Scale applied before detection (1 when the source was already small). */
  detectScale: number;
}

/**
 * Port of assessFaceQuality() from client-aac/src/hooks/usePersonIdentification.ts
 * (symmetry of the nose between the jaw edges × relative face size × detector
 * score). Kept numerically identical so the number means the same thing as the
 * `quality` already stored on gallery entries.
 */
function assessFaceQuality(detection: any, elementWidth: number, elementHeight: number): number {
  const box = detection.detection.box;
  const score = detection.detection.score || 0.5;
  const landmarks = detection.landmarks;

  let symmetry = 0.5;
  if (landmarks) {
    const positions = landmarks.positions;
    const noseTip = positions[30];
    const leftEdge = positions[0];
    const rightEdge = positions[16];
    if (noseTip && leftEdge && rightEdge) {
      const leftDist = Math.abs(noseTip.x - leftEdge.x);
      const rightDist = Math.abs(rightEdge.x - noseTip.x);
      const total = leftDist + rightDist;
      if (total > 0) symmetry = 1 - Math.abs(leftDist - rightDist) / total;
    }
  }

  const sizeRatio = (box.width * box.height) / (elementWidth * elementHeight);
  return symmetry * Math.min(1, sizeRatio * 15) * score;
}

/** Decode an image buffer to an int32 HWC tensor (RGB, no alpha). */
async function bufferToTensor(buffer: Buffer, maxSide: number): Promise<{ tensor: any; width: number; height: number; scale: number; sourceWidth: number; sourceHeight: number }> {
  const meta = await sharp(buffer).metadata();
  const sourceWidth = meta.width ?? 0;
  const sourceHeight = meta.height ?? 0;
  if (!sourceWidth || !sourceHeight) throw new Error("Image has no dimensions");

  // Mirrors the client's downscale-before-detect step. Stored biometric photos
  // are already 512×512, so this is normally a no-op (scale = 1).
  const scale = Math.min(1, maxSide / Math.max(sourceWidth, sourceHeight));
  const width = Math.max(1, Math.round(sourceWidth * scale));
  const height = Math.max(1, Math.round(sourceHeight * scale));

  let pipe = sharp(buffer).rotate(); // honor EXIF, as the upload path does
  if (scale < 1) pipe = pipe.resize(width, height, { fit: "fill" });
  const { data, info } = await pipe.removeAlpha().raw().toBuffer({ resolveWithObject: true });

  const { tf } = runtime();
  const tensor = tf.tensor3d(new Uint8Array(data), [info.height, info.width, info.channels], "int32");
  return { tensor, width: info.width, height: info.height, scale, sourceWidth, sourceHeight };
}

/**
 * Detect the single most prominent face in `buffer` and return its 128-D
 * descriptor plus quality metrics. Returns null when no face is found.
 */
export async function extractFace(
  buffer: Buffer,
  pipeline: FacePipeline = "enrollment",
  log: (s: string) => void = console.log,
): Promise<FaceExtraction | null> {
  await loadFaceModels(pipeline, log);
  const { faceapi } = runtime();

  const { tensor, width, height, scale, sourceWidth, sourceHeight } = await bufferToTensor(
    buffer,
    MAX_DETECT_SIZE,
  );
  try {
    let task: any;
    if (pipeline === "enrollment") {
      // No detector options → SsdMobilenetv1Options defaults, and
      // .withFaceLandmarks() with no arg → the FULL 68-point net. Exactly what
      // client/src/lib/biometricImage.ts does.
      task = faceapi.detectSingleFace(tensor).withFaceLandmarks();
    } else {
      task = faceapi
        .detectSingleFace(
          tensor,
          new faceapi.TinyFaceDetectorOptions({
            inputSize: AAC_INPUT_SIZE,
            scoreThreshold: AAC_SCORE_THRESHOLD,
          }),
        )
        .withFaceLandmarks(true); // tiny landmarks
    }
    const detection = await task.withFaceDescriptor();
    if (!detection) return null;

    const box = detection.detection.box;
    return {
      pipeline,
      descriptor: Array.from(detection.descriptor as Float32Array),
      detectionScore: detection.detection.score,
      quality: assessFaceQuality(detection, width, height),
      box: { x: box.x, y: box.y, width: box.width, height: box.height },
      imageWidth: sourceWidth,
      imageHeight: sourceHeight,
      detectScale: scale,
    };
  } finally {
    tensor.dispose();
  }
}

/** The distance metric the recognition service uses (server/services/biometric/recognition-service.ts). */
export function euclideanDistance(a: number[], b: number[]): number {
  if (a.length !== b.length) return Infinity;
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += (a[i] - b[i]) ** 2;
  return Math.sqrt(sum);
}
