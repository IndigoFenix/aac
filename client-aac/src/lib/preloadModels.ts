// client-aac/src/lib/preloadModels.ts
//
// Kick off the always-used on-device models at app startup so downloads and
// WASM compilation overlap with auth/session initialization instead of
// starting at first use (mic attach, first camera frame). Each is a retrying
// loader (lib/modelLoader.ts) — a failure here retries in the background,
// never blocks or throws.
//
// Deliberately NOT preloaded: the wavlm speaker-embedding model (~100MB, only
// when voice ID is enabled), whisper transcription, and the pose/hand
// landmarkers (ref-counted per consumer, GPU-context cost — they now retry on
// their own via visionWorkerClient).

import { preloadSileroVad } from "./sileroVad";
import { getFaceLandmarkerLoader } from "@/hooks/useFaceTracking";
import { preloadKokoroTts } from "@/services/kokoroTts";

export function preloadClientModels(): void {
  preloadSileroVad();
  getFaceLandmarkerLoader().preload();
  // Kokoro (local neural voice, ~92 MB) self-gates on the weights being staged
  // — on a build that didn't run `npm run kokoro:model` this is a no-op and the
  // client keeps using speechSynthesis. See services/kokoroTts.ts.
  preloadKokoroTts();
}
