// client-aac/src/hooks/usePersonIdentification.ts
// Fast, non-blocking person identification for AAC system

import { useState, useRef, useCallback, useEffect } from "react";
import { fetchWithAuth } from "@/lib/queryClient";

// =============================================================================
// TYPES
// =============================================================================

export interface KnownPerson {
  id: string;
  type: "student" | "user" | "contact";
  name: string;
  relationship?: string; // 'student', 'parent', 'teacher', 'therapist', 'classmate', etc.
  faceEmbedding: number[] | null;
  voiceEmbedding: number[] | null;
  description?: string;
  contextNotes?: string;
}

export interface IdentifiedPerson {
  id: string;
  type: "student" | "user" | "contact";
  name: string;
  relationship?: string;
  confidence: number;
  method: "face" | "voice" | "both";
  description?: string;
  contextNotes?: string;
}

export interface UnknownFaceDescriptor {
  descriptor: number[];
  boundingBox?: { x: number; y: number; w: number; h: number };
  cameraRole?: "user" | "environment" | "unknown";
  cameraLabel?: string;
  /** Frontality/size/detection score (0..1). Used server-side to gate which
   *  frames are worth enrolling into a person's multi-angle gallery. */
  quality?: number;
  /**
   * Coarse OBSERVED attributes from face-api's ageGenderNet, sent alongside the
   * 128-d descriptor so the server can veto biologically impossible matches
   * (the embedding is age-blind in practice — a child routinely lands inside
   * 0.6 of her grandmother's stored anchor, while "child vs senior" is a call
   * the attribute net gets right). All three are OPTIONAL and absent whenever
   * the net didn't load or the frame produced no estimate; the server treats
   * missing data as "no opinion" and never vetoes on it.
   */
  /** Estimated age in years (continuous, not a band). */
  observedAge?: number;
  /** Estimated sex, only when the net reported a usable label. */
  observedSex?: "male" | "female";
  /** 0..1 probability behind `observedSex`. The server ignores low-confidence
   *  sex readings entirely — face-api's gender head is noisy on children. */
  observedSexConfidence?: number;
}

export interface IdentifySourceOptions {
  /** Distinct key per camera so multiple cameras don't overwrite each other */
  sourceKey?: string;
  cameraRole?: "user" | "environment" | "unknown";
  cameraLabel?: string;
  /** Set true only for the primary user-facing source; gates `currentIdentification` and face-image caching. */
  updateCurrent?: boolean;
}

export interface IdentificationResult {
  identified: boolean;
  person: IdentifiedPerson | null;
  isStudent: boolean; // Quick check if identified person is the student
  timestamp: number;
}

interface CachedIdentification {
  result: IdentificationResult;
  descriptorHash: string;
  timestamp: number;
}

/** Last captured face image for debug display */
export interface LastCapturedFaceImage {
  contactId: string;
  contactName: string;
  dataUrl: string;
  quality: number;
  timestamp: number;
}

// =============================================================================
// FACE-API LOADER (singleton)
// =============================================================================

let faceApiLoaded = false;
let faceApiPromise: Promise<void> | null = null;
let faceApiError: Error | null = null;

// CDN base for the model weights — the same origin/version as the face-api
// bundle itself, so the nets always match the runtime that consumes them.
const MODEL_URL = "https://cdn.jsdelivr.net/npm/@vladmandic/face-api/model";

// ---- Age/gender net (OPTIONAL, best-effort) --------------------------------
// This net feeds the server's attribute veto. It is deliberately NOT part of
// the required model set: identification must keep working byte-for-byte as
// before when it is missing, so its load is fire-and-forget and its failure is
// never latched the way `faceApiError` is — `ageGenderPromise` is cleared on
// settle, so a later init pass retries a transient CDN failure instead of
// permanently disabling the attributes.
let ageGenderLoaded = false;
let ageGenderPromise: Promise<void> | null = null;

function loadAgeGenderNet(): Promise<void> {
  if (ageGenderLoaded) return Promise.resolve();
  if (ageGenderPromise) return ageGenderPromise;

  ageGenderPromise = (async () => {
    try {
      const net = (window as any).faceapi?.nets?.ageGenderNet;
      if (!net) {
        console.warn("[PersonID] ageGenderNet not present in this face-api build — observed age/sex disabled");
        return;
      }
      await net.loadFromUri(MODEL_URL);
      ageGenderLoaded = true;
      console.log("[PersonID] ageGenderNet loaded — descriptors will carry observed age/sex");
    } catch (err) {
      // Non-fatal by design. Never rethrow: the recognition pipeline must not
      // fail because an optional attribute net didn't download.
      console.warn("[PersonID] ageGenderNet failed to load — continuing without observed age/sex:", err);
    }
  })();
  // Clear the in-flight handle either way so a failed attempt can be retried.
  ageGenderPromise = ageGenderPromise.finally(() => {
    ageGenderPromise = null;
  });
  return ageGenderPromise;
}

async function loadFaceApi(): Promise<void> {
  if (faceApiLoaded) return;
  if (faceApiError) throw faceApiError;
  if (faceApiPromise) return faceApiPromise;

  faceApiPromise = new Promise(async (resolve, reject) => {
    try {
      if ((window as any).faceapi) {
        faceApiLoaded = true;
        resolve();
        return;
      }

      const script = document.createElement("script");
      script.src = "https://cdn.jsdelivr.net/npm/@vladmandic/face-api/dist/face-api.min.js";
      script.async = true;

      script.onload = async () => {
        const faceapi = (window as any).faceapi;
        if (!faceapi) {
          const err = new Error("face-api.js failed to load");
          faceApiError = err;
          reject(err);
          return;
        }

        // Load lightweight models for speed
        await Promise.all([
          faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL), // Faster than SSD
          faceapi.nets.faceLandmark68TinyNet.loadFromUri(MODEL_URL), // Faster landmarks
          faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL),
          // Optional 4th net — attribute veto input. loadAgeGenderNet() never
          // rejects, so a CDN miss here cannot fail the required three.
          loadAgeGenderNet(),
        ]);

        faceApiLoaded = true;
        console.log("[PersonID] Face-api loaded with tiny models");
        resolve();
      };

      script.onerror = () => {
        const err = new Error("Failed to load face-api.js");
        faceApiError = err;
        reject(err);
      };

      document.head.appendChild(script);
    } catch (error) {
      faceApiError = error as Error;
      reject(error);
    }
  });

  return faceApiPromise;
}

// =============================================================================
// UTILITIES
// =============================================================================

// Euclidean distance for face matching
function euclideanDistance(a: number[], b: number[]): number {
  if (a.length !== b.length) return Infinity;
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    sum += Math.pow(a[i] - b[i], 2);
  }
  return Math.sqrt(sum);
}

// Simple hash for face descriptor caching
function hashDescriptor(descriptor: number[]): string {
  // Use first 8 values as a quick hash (enough to differentiate faces)
  return descriptor.slice(0, 8).map(v => Math.round(v * 1000)).join(",");
}

// Face match threshold (lower = stricter)
const FACE_MATCH_THRESHOLD = 0.6;

// Cache duration (5 minutes)
const CACHE_DURATION_MS = 5 * 60 * 1000;

// Known people refresh interval (10 minutes)
const KNOWN_PEOPLE_REFRESH_MS = 10 * 60 * 1000;

// Crop a face from a media element using detection bounding box
function cropFaceFromElement(
  element: HTMLVideoElement | HTMLImageElement | HTMLCanvasElement,
  box: { x: number; y: number; width: number; height: number },
  padding = 0.2
): string | null {
  try {
    const sourceW = element instanceof HTMLVideoElement ? element.videoWidth : element.width;
    const sourceH = element instanceof HTMLVideoElement ? element.videoHeight : element.height;
    if (!sourceW || !sourceH) return null;

    const padX = box.width * padding;
    const padY = box.height * padding;
    const x = Math.max(0, Math.round(box.x - padX));
    const y = Math.max(0, Math.round(box.y - padY));
    const w = Math.min(sourceW - x, Math.round(box.width + padX * 2));
    const h = Math.min(sourceH - y, Math.round(box.height + padY * 2));

    const canvas = document.createElement("canvas");
    canvas.width = Math.min(w, 200); // Cap at 200px wide
    canvas.height = Math.round(h * (canvas.width / w));
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;

    ctx.drawImage(element, x, y, w, h, 0, 0, canvas.width, canvas.height);
    // Return base64 without the data URL prefix
    const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
    return dataUrl.replace(/^data:image\/jpeg;base64,/, "");
  } catch {
    return null;
  }
}

// Assess face quality using landmarks and detection score
function assessFaceQuality(
  detection: any, // face-api detection with landmarks
  elementWidth: number,
  elementHeight: number
): number {
  const box = detection.detection.box;
  const score = detection.detection.score || 0.5;
  const landmarks = detection.landmarks;

  // Frontality: symmetry of nose relative to face edges
  let symmetry = 0.5;
  if (landmarks) {
    const positions = landmarks.positions;
    const noseTip = positions[30]; // nose tip
    const leftEdge = positions[0]; // left jaw
    const rightEdge = positions[16]; // right jaw
    if (noseTip && leftEdge && rightEdge) {
      const leftDist = Math.abs(noseTip.x - leftEdge.x);
      const rightDist = Math.abs(rightEdge.x - noseTip.x);
      const total = leftDist + rightDist;
      if (total > 0) {
        symmetry = 1 - Math.abs(leftDist - rightDist) / total;
      }
    }
  }

  // Size: ratio of face area to image area
  const sizeRatio = (box.width * box.height) / (elementWidth * elementHeight);

  return symmetry * Math.min(1, sizeRatio * 15) * score;
}

// =============================================================================
// HOOK
// =============================================================================

export interface UsePersonIdentificationOptions {
  studentId: string;
  enabled?: boolean;
  /** Client-side face image cache — called when a contact's face is detected */
  cacheFaceImage?: (contactId: string, dataUrl: string, quality: number) => void;
}

export interface UsePersonIdentificationReturn {
  // State
  isReady: boolean;
  isLoading: boolean;
  error: string | null;
  knownPeopleCount: number;

  // Current identification
  currentIdentification: IdentificationResult | null;

  // Methods
  identifyFromVideo: (video: HTMLVideoElement, options?: IdentifySourceOptions) => Promise<IdentificationResult | null>;
  identifyFromImage: (image: HTMLImageElement, options?: IdentifySourceOptions) => Promise<IdentificationResult | null>;
  identifyFromCanvas: (canvas: HTMLCanvasElement, options?: IdentifySourceOptions) => Promise<IdentificationResult | null>;
  refreshKnownPeople: () => Promise<void>;
  clearCache: () => void;

  // Unknown face descriptors (for AI-triggered enrollment)
  getUnmatchedDescriptors: () => UnknownFaceDescriptor[];

  // Debug: last captured face image
  lastCapturedFaceImage: LastCapturedFaceImage | null;
}

export function usePersonIdentification(
  options: UsePersonIdentificationOptions
): UsePersonIdentificationReturn {
  const { studentId, enabled = true, cacheFaceImage } = options;

  // State
  const [isReady, setIsReady] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [currentIdentification, setCurrentIdentification] = useState<IdentificationResult | null>(null);
  const [lastCapturedFaceImage, setLastCapturedFaceImage] = useState<LastCapturedFaceImage | null>(null);

  // Refs for caching (avoid re-renders)
  const knownPeopleRef = useRef<KnownPerson[]>([]);
  const identificationCacheRef = useRef<Map<string, CachedIdentification>>(new Map());
  const lastKnownPeopleFetchRef = useRef<number>(0);
  // One pending flag per source so cameras don't block each other
  const pendingIdentificationRef = useRef<Map<string, boolean>>(new Map());
  // Descriptors keyed by source — last successful detection per camera
  const unmatchedDescriptorsRef = useRef<Map<string, UnknownFaceDescriptor>>(new Map());
  const faceImageQualityRef = useRef<Map<string, number>>(new Map());

  // ==========================================================================
  // FETCH KNOWN PEOPLE
  // ==========================================================================

  const fetchKnownPeople = useCallback(async () => {
    if (!studentId) return;

    try {
      const response = await fetchWithAuth(`/api/aac/students/${studentId}/known-people`);
      if (!response.ok) {
        throw new Error(`Failed to fetch known people: ${response.status}`);
      }
      const data = await response.json();
      knownPeopleRef.current = data.people || [];
      lastKnownPeopleFetchRef.current = Date.now();
      console.log(`[PersonID] Loaded ${knownPeopleRef.current.length} known people`);
    } catch (err: any) {
      console.error("[PersonID] Failed to fetch known people:", err);
      // Don't set error state - this is non-critical
    }
  }, [studentId]);

  const refreshKnownPeople = useCallback(async () => {
    await fetchKnownPeople();
  }, [fetchKnownPeople]);

  // ==========================================================================
  // FACE IMAGE CACHING (client-side only, no server upload)
  // ==========================================================================

  const cacheFaceImageRef = useRef(cacheFaceImage);
  cacheFaceImageRef.current = cacheFaceImage;

  // ==========================================================================
  // INITIALIZE
  // ==========================================================================

  useEffect(() => {
    if (!enabled || !studentId) return;

    let mounted = true;

    async function init() {
      setIsLoading(true);
      setError(null);

      try {
        // Load face-api in parallel with fetching known people
        await Promise.all([
          loadFaceApi(),
          fetchKnownPeople(),
        ]);

        if (mounted) {
          setIsReady(true);
          console.log("[PersonID] Initialization complete");
        }
      } catch (err: any) {
        console.error("[PersonID] Initialization error:", err);
        if (mounted) {
          setError(err.message || "Failed to initialize person identification");
        }
      } finally {
        if (mounted) {
          setIsLoading(false);
        }
      }
    }

    init();

    return () => {
      mounted = false;
    };
  }, [enabled, studentId, fetchKnownPeople]);

  // Periodic refresh of known people
  useEffect(() => {
    if (!enabled || !isReady) return;

    const interval = setInterval(() => {
      const timeSinceLastFetch = Date.now() - lastKnownPeopleFetchRef.current;
      if (timeSinceLastFetch > KNOWN_PEOPLE_REFRESH_MS) {
        fetchKnownPeople();
      }
    }, 60000); // Check every minute

    return () => clearInterval(interval);
  }, [enabled, isReady, fetchKnownPeople]);

  // ==========================================================================
  // IDENTIFICATION LOGIC
  // ==========================================================================

  const matchFaceToKnownPeople = useCallback(
    (descriptor: Float32Array): IdentificationResult => {
      const descriptorArray = Array.from(descriptor);
      const descriptorHash = hashDescriptor(descriptorArray);

      // Check cache first
      const cached = identificationCacheRef.current.get(descriptorHash);
      if (cached && Date.now() - cached.timestamp < CACHE_DURATION_MS) {
        return cached.result;
      }

      // Find best match
      let bestMatch: KnownPerson | null = null;
      let bestDistance = FACE_MATCH_THRESHOLD;

      for (const person of knownPeopleRef.current) {
        if (!person.faceEmbedding) continue;

        const distance = euclideanDistance(descriptorArray, person.faceEmbedding);
        if (distance < bestDistance) {
          bestDistance = distance;
          bestMatch = person;
        }
      }

      const result: IdentificationResult = {
        identified: !!bestMatch,
        person: bestMatch
          ? {
              id: bestMatch.id,
              type: bestMatch.type,
              name: bestMatch.name,
              relationship: bestMatch.relationship,
              confidence: Math.max(0, 1 - bestDistance / FACE_MATCH_THRESHOLD),
              method: "face",
              description: bestMatch.description,
              contextNotes: bestMatch.contextNotes,
            }
          : null,
        isStudent: bestMatch?.type === "student" && bestMatch?.id === studentId,
        timestamp: Date.now(),
      };

      // Cache result
      identificationCacheRef.current.set(descriptorHash, {
        result,
        descriptorHash,
        timestamp: Date.now(),
      });

      // Limit cache size
      if (identificationCacheRef.current.size > 100) {
        // Remove oldest entries
        const entries = Array.from(identificationCacheRef.current.entries());
        entries.sort((a, b) => a[1].timestamp - b[1].timestamp);
        for (let i = 0; i < 20; i++) {
          identificationCacheRef.current.delete(entries[i][0]);
        }
      }

      return result;
    },
    [studentId]
  );

  const identifyFromElement = useCallback(
    async (
      element: HTMLVideoElement | HTMLImageElement | HTMLCanvasElement,
      options?: IdentifySourceOptions,
    ): Promise<IdentificationResult | null> => {
      const sourceKey = options?.sourceKey ?? "default";
      const cameraRole = options?.cameraRole;
      const cameraLabel = options?.cameraLabel;
      const updateCurrent = options?.updateCurrent ?? true;

      if (!isReady || pendingIdentificationRef.current.get(sourceKey)) {
        return null;
      }

      // Non-blocking per-source: don't wait if this source is already processing
      pendingIdentificationRef.current.set(sourceKey, true);

      try {
        const faceapi = (window as any).faceapi;
        if (!faceapi) return null;

        // Use tiny detector for speed
        const detectorOptions = () => new faceapi.TinyFaceDetectorOptions({
          inputSize: 224, // Smaller = faster
          scoreThreshold: 0.5,
        });
        const baseTask = () => faceapi
          .detectSingleFace(element, detectorOptions())
          .withFaceLandmarks(true); // Use tiny landmarks

        // Age/sex ride along ONLY when the optional net loaded. Everything past
        // this point must behave identically either way — the extra pass adds
        // fields, it never gates the descriptor.
        let detection: any = null;
        if (ageGenderLoaded) {
          try {
            detection = await baseTask().withAgeAndGender().withFaceDescriptor();
          } catch (agErr) {
            console.warn("[PersonID] age/gender pass failed — retrying descriptor only:", agErr);
            detection = await baseTask().withFaceDescriptor();
          }
        } else {
          detection = await baseTask().withFaceDescriptor();
        }

        if (!detection) {
          // Clear stale descriptor for this source so empty cameras don't keep
          // sending old data after the person leaves the frame.
          unmatchedDescriptorsRef.current.delete(sourceKey);
          return null;
        }

        const result = matchFaceToKnownPeople(detection.descriptor);
        if (updateCurrent) {
          setCurrentIdentification(result);
        }

        // Frame quality (frontality/size/score) — sent with the descriptor so
        // the server can decide whether this pose is worth adding to the
        // person's gallery. Cheap; computed for every detection.
        const elementW = element instanceof HTMLVideoElement ? element.videoWidth : element.width;
        const elementH = element instanceof HTMLVideoElement ? element.videoHeight : element.height;
        const quality = assessFaceQuality(detection, elementW, elementH);

        // Always surface the detected descriptor so the server can run its own
        // (authoritative) database match. The local match above is kept only
        // for client-side face-image caching; the server is the source of
        // truth for the AI.
        const box = detection.detection.box;

        // Coarse observed attributes (present only when ageGenderNet ran and
        // produced usable numbers). Each is spread in individually so a partial
        // read — say an age with no gender label — still contributes what it
        // has, and a total miss leaves the payload byte-identical to before.
        const rawAge = detection.age;
        const observedAge =
          typeof rawAge === "number" && Number.isFinite(rawAge) && rawAge > 0 ? rawAge : undefined;
        const rawSex = detection.gender;
        const observedSex: "male" | "female" | undefined =
          rawSex === "male" || rawSex === "female" ? rawSex : undefined;
        const rawSexConf = detection.genderProbability;
        const observedSexConfidence =
          observedSex && typeof rawSexConf === "number" && Number.isFinite(rawSexConf)
            ? rawSexConf
            : undefined;

        unmatchedDescriptorsRef.current.set(sourceKey, {
          descriptor: Array.from(detection.descriptor),
          boundingBox: box ? { x: box.x, y: box.y, w: box.width, h: box.height } : undefined,
          cameraRole,
          cameraLabel,
          quality,
          ...(observedAge !== undefined ? { observedAge } : {}),
          ...(observedSex !== undefined ? { observedSex } : {}),
          ...(observedSexConfidence !== undefined ? { observedSexConfidence } : {}),
        });

        if (updateCurrent && result.identified) {
          // Auto-capture face image for contacts (client-side cache only)
          if (result.person?.type === "contact") {
            const contactId = result.person.id;
            const cachedQuality = faceImageQualityRef.current.get(contactId);
            const shouldCache = !cachedQuality || quality > cachedQuality;

            if (shouldCache) {
              const imageData = cropFaceFromElement(element, detection.detection.box);
              if (imageData) {
                const dataUrl = `data:image/jpeg;base64,${imageData}`;
                faceImageQualityRef.current.set(contactId, quality);
                cacheFaceImageRef.current?.(contactId, dataUrl, quality);
                setLastCapturedFaceImage({
                  contactId,
                  contactName: result.person.name,
                  dataUrl,
                  quality,
                  timestamp: Date.now(),
                });
                console.log(`[PersonID] Cached face image for "${result.person.name}" (${contactId}), quality=${quality.toFixed(3)}`);
              }
            }
          }
        }

        return result;
      } catch (err) {
        console.error("[PersonID] Detection error:", err);
        return null;
      } finally {
        pendingIdentificationRef.current.set(sourceKey, false);
      }
    },
    [isReady, matchFaceToKnownPeople]
  );

  const identifyFromVideo = useCallback(
    async (video: HTMLVideoElement, options?: IdentifySourceOptions): Promise<IdentificationResult | null> => {
      return identifyFromElement(video, options);
    },
    [identifyFromElement]
  );

  const identifyFromImage = useCallback(
    async (image: HTMLImageElement, options?: IdentifySourceOptions): Promise<IdentificationResult | null> => {
      return identifyFromElement(image, options);
    },
    [identifyFromElement]
  );

  const identifyFromCanvas = useCallback(
    async (canvas: HTMLCanvasElement, options?: IdentifySourceOptions): Promise<IdentificationResult | null> => {
      return identifyFromElement(canvas, options);
    },
    [identifyFromElement]
  );

  const clearCache = useCallback(() => {
    identificationCacheRef.current.clear();
    setCurrentIdentification(null);
    unmatchedDescriptorsRef.current.clear();
  }, []);

  const getUnmatchedDescriptors = useCallback((): UnknownFaceDescriptor[] => {
    return Array.from(unmatchedDescriptorsRef.current.values());
  }, []);

  return {
    isReady,
    isLoading,
    error,
    knownPeopleCount: knownPeopleRef.current.length,
    currentIdentification,
    identifyFromVideo,
    identifyFromImage,
    identifyFromCanvas,
    refreshKnownPeople,
    clearCache,
    getUnmatchedDescriptors,
    lastCapturedFaceImage,
  };
}

export default usePersonIdentification;
