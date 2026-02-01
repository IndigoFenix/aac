// client-aac/src/hooks/usePersonIdentification.ts
// Fast, non-blocking person identification for AAC system

import { useState, useRef, useCallback, useEffect } from "react";
import { fetchWithAuth } from "@/lib/queryClient";

// =============================================================================
// TYPES
// =============================================================================

export interface KnownPerson {
  id: string;
  type: "student" | "user";
  name: string;
  relationship?: string; // 'student', 'parent', 'teacher', 'therapist', etc.
  faceEmbedding: number[] | null;
  voiceEmbedding: number[] | null;
}

export interface IdentifiedPerson {
  id: string;
  type: "student" | "user";
  name: string;
  relationship?: string;
  confidence: number;
  method: "face" | "voice" | "both";
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

// =============================================================================
// FACE-API LOADER (singleton)
// =============================================================================

let faceApiLoaded = false;
let faceApiPromise: Promise<void> | null = null;
let faceApiError: Error | null = null;

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
        const MODEL_URL = "https://cdn.jsdelivr.net/npm/@vladmandic/face-api/model";
        await Promise.all([
          faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL), // Faster than SSD
          faceapi.nets.faceLandmark68TinyNet.loadFromUri(MODEL_URL), // Faster landmarks
          faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL),
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

// =============================================================================
// HOOK
// =============================================================================

export interface UsePersonIdentificationOptions {
  studentId: string;
  enabled?: boolean;
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
  identifyFromVideo: (video: HTMLVideoElement) => Promise<IdentificationResult | null>;
  identifyFromImage: (image: HTMLImageElement) => Promise<IdentificationResult | null>;
  identifyFromCanvas: (canvas: HTMLCanvasElement) => Promise<IdentificationResult | null>;
  refreshKnownPeople: () => Promise<void>;
  clearCache: () => void;
}

export function usePersonIdentification(
  options: UsePersonIdentificationOptions
): UsePersonIdentificationReturn {
  const { studentId, enabled = true } = options;

  // State
  const [isReady, setIsReady] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [currentIdentification, setCurrentIdentification] = useState<IdentificationResult | null>(null);

  // Refs for caching (avoid re-renders)
  const knownPeopleRef = useRef<KnownPerson[]>([]);
  const identificationCacheRef = useRef<Map<string, CachedIdentification>>(new Map());
  const lastKnownPeopleFetchRef = useRef<number>(0);
  const pendingIdentificationRef = useRef<boolean>(false);

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
      element: HTMLVideoElement | HTMLImageElement | HTMLCanvasElement
    ): Promise<IdentificationResult | null> => {
      if (!isReady || pendingIdentificationRef.current) {
        return null;
      }

      // Non-blocking: don't wait if already processing
      pendingIdentificationRef.current = true;

      try {
        const faceapi = (window as any).faceapi;
        if (!faceapi) return null;

        // Use tiny detector for speed
        const detection = await faceapi
          .detectSingleFace(element, new faceapi.TinyFaceDetectorOptions({
            inputSize: 224, // Smaller = faster
            scoreThreshold: 0.5,
          }))
          .withFaceLandmarks(true) // Use tiny landmarks
          .withFaceDescriptor();

        if (!detection) {
          return null;
        }

        const result = matchFaceToKnownPeople(detection.descriptor);
        setCurrentIdentification(result);
        return result;
      } catch (err) {
        console.error("[PersonID] Detection error:", err);
        return null;
      } finally {
        pendingIdentificationRef.current = false;
      }
    },
    [isReady, matchFaceToKnownPeople]
  );

  const identifyFromVideo = useCallback(
    async (video: HTMLVideoElement): Promise<IdentificationResult | null> => {
      return identifyFromElement(video);
    },
    [identifyFromElement]
  );

  const identifyFromImage = useCallback(
    async (image: HTMLImageElement): Promise<IdentificationResult | null> => {
      return identifyFromElement(image);
    },
    [identifyFromElement]
  );

  const identifyFromCanvas = useCallback(
    async (canvas: HTMLCanvasElement): Promise<IdentificationResult | null> => {
      return identifyFromElement(canvas);
    },
    [identifyFromElement]
  );

  const clearCache = useCallback(() => {
    identificationCacheRef.current.clear();
    setCurrentIdentification(null);
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
  };
}

export default usePersonIdentification;
