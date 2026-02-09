// client-aac/src/lib/signLanguageClassifier.ts
// Pure JS sign language classifier — no dependencies.
// Runs a lightweight MLP on MediaPipe hand landmarks to classify ASL/ISL signs.

import type { HandLandmark } from "./handGestureTypes";

// =============================================================================
// TYPES
// =============================================================================

export interface SignLanguageModelLayer {
  weights: number[][]; // [outputSize][inputSize]
  bias: number[];      // [outputSize]
}

export interface SignLanguageModel {
  locale: string;           // e.g. "asl", "isl"
  name: string;             // human-readable name
  labels: string[];         // class labels (e.g. ["A", "B", "C", ...])
  inputSize: number;        // expected input vector length (63 for 21 landmarks * 3)
  layers: SignLanguageModelLayer[];
}

export interface SignClassification {
  label: string;
  confidence: number;
}

// =============================================================================
// MODEL LOADING
// =============================================================================

const modelCache = new Map<string, SignLanguageModel>();

export async function loadSignLanguageModel(url: string): Promise<SignLanguageModel> {
  const cached = modelCache.get(url);
  if (cached) return cached;

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to load sign language model from ${url}: ${response.status}`);
  }

  const model: SignLanguageModel = await response.json();

  // Validate model structure
  if (!model.locale || !Array.isArray(model.labels) || !Array.isArray(model.layers)) {
    throw new Error(`Invalid sign language model format from ${url}`);
  }

  modelCache.set(url, model);
  console.log(`[SignLanguage] Loaded ${model.locale} model: ${model.name} (${model.labels.length} classes)`);
  return model;
}

// =============================================================================
// PREPROCESSING
// =============================================================================

/**
 * Convert 21 hand landmarks to a normalized 63-element feature vector.
 * - Subtracts wrist position (landmark 0) to make coordinates wrist-relative
 * - Normalizes by the maximum absolute value across all coordinates
 */
export function preprocessLandmarks(landmarks: HandLandmark[]): Float32Array | null {
  if (landmarks.length < 21) return null;

  const wrist = landmarks[0];
  const features = new Float32Array(63);

  // Wrist-relative coordinates
  for (let i = 0; i < 21; i++) {
    features[i * 3 + 0] = landmarks[i].x - wrist.x;
    features[i * 3 + 1] = landmarks[i].y - wrist.y;
    features[i * 3 + 2] = landmarks[i].z - wrist.z;
  }

  // Find max absolute value for normalization
  let maxAbs = 0;
  for (let i = 0; i < 63; i++) {
    const abs = Math.abs(features[i]);
    if (abs > maxAbs) maxAbs = abs;
  }

  // Normalize (avoid division by zero)
  if (maxAbs > 1e-8) {
    for (let i = 0; i < 63; i++) {
      features[i] /= maxAbs;
    }
  }

  return features;
}

// =============================================================================
// MLP INFERENCE
// =============================================================================

/** Dense layer: output = weights * input + bias */
function dense(input: Float32Array, layer: SignLanguageModelLayer): Float32Array {
  const outputSize = layer.bias.length;
  const output = new Float32Array(outputSize);

  for (let o = 0; o < outputSize; o++) {
    let sum = layer.bias[o];
    const w = layer.weights[o];
    for (let i = 0; i < input.length; i++) {
      sum += w[i] * input[i];
    }
    output[o] = sum;
  }

  return output;
}

/** ReLU activation: max(0, x) */
function relu(x: Float32Array): Float32Array {
  for (let i = 0; i < x.length; i++) {
    if (x[i] < 0) x[i] = 0;
  }
  return x;
}

/** Softmax activation: normalized exponentials */
function softmax(x: Float32Array): Float32Array {
  let maxVal = -Infinity;
  for (let i = 0; i < x.length; i++) {
    if (x[i] > maxVal) maxVal = x[i];
  }

  let sum = 0;
  for (let i = 0; i < x.length; i++) {
    x[i] = Math.exp(x[i] - maxVal);
    sum += x[i];
  }

  for (let i = 0; i < x.length; i++) {
    x[i] /= sum;
  }

  return x;
}

// =============================================================================
// CLASSIFICATION
// =============================================================================

/**
 * Classify a hand's sign language gesture using the loaded MLP model.
 * Returns null if below threshold or model has no labels.
 */
export function classifySign(
  model: SignLanguageModel,
  landmarks: HandLandmark[],
  threshold: number = 0.5
): SignClassification | null {
  if (model.labels.length === 0) return null;

  const features = preprocessLandmarks(landmarks);
  if (!features) return null;

  if (features.length !== model.inputSize) {
    console.warn(`[SignLanguage] Input size mismatch: expected ${model.inputSize}, got ${features.length}`);
    return null;
  }

  // Forward pass through MLP layers
  let activations: Float32Array = features;
  for (let i = 0; i < model.layers.length; i++) {
    activations = dense(activations, model.layers[i]);
    if (i < model.layers.length - 1) {
      // Hidden layers: ReLU
      activations = relu(activations);
    } else {
      // Output layer: softmax
      activations = softmax(activations);
    }
  }

  // Find argmax
  let bestIdx = 0;
  let bestConf = activations[0];
  for (let i = 1; i < activations.length; i++) {
    if (activations[i] > bestConf) {
      bestConf = activations[i];
      bestIdx = i;
    }
  }

  if (bestConf < threshold) return null;

  return {
    label: model.labels[bestIdx],
    confidence: bestConf,
  };
}
