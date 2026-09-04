// client-aac/src/hooks/usePersonIdentification.ts
// Fast, non-blocking person identification for AAC system

import { useState, useRef, useCallback, useEffect } from "react";
import { fetchWithAuth } from "@/lib/queryClient";
import { FaceTrackAssociator } from "@/lib/faceTrackAssociation";

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

  /**
   * TRACK CONTINUITY (presence ledger §7). All optional and all additive: an
   * older server that knows nothing about tracks reads the same payload it
   * always did. Populated by `FaceTrackAssociator` — one track holds ONE
   * identity server-side, which is what stops a single borderline frame from
   * renaming the person mid-session.
   */
  /** Stable handle for this face across frames: `${sourceKey}#${n}`. */
  trackId?: string;
  /** How long this track has been alive, in ms. */
  trackAgeMs?: number;
  /** How many frames the track has been seen in. */
  framesInTrack?: number;
  /**
   * Running mean of the last few ABOVE-QUALITY descriptors on this track —
   * the vector worth matching on, because single frames of one person sit far
   * enough apart to cross the threshold while their mean does not. Omitted
   * when only one sample backs it: that mean IS `descriptor`, and a 128-float
   * duplicate per face per batch is real bytes on a tethered device.
   */
  meanDescriptor?: number[];
  /**
   * How many faces this camera saw in the frame these entries came from (the
   * RAW count, before the ≤ 3 cap — the server uses it as a ceiling on how
   * many people it may claim are present, so under-reporting it would be the
   * dangerous direction). Identical on every entry from the same frame.
   */
  facesInFrame?: number;
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

// Faces kept per camera per tick. Matches DEFAULT_FACE_TRACKING_CONFIG.maxFaces
// so the identification path and the MediaPipe tracking path agree on how
// crowded a room they are willing to describe.
const MAX_FACES_PER_SOURCE = 3;

// ONE associator for the whole app, keyed internally by sourceKey. Module-level
// on purpose: track ids must survive a remount of the hook, or every reload of
// the component would hand the server a "new person" for the child who never
// moved.
const faceTrackAssociator = new FaceTrackAssociator();

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
  // Descriptors keyed by source — the last successful detection per camera,
  // now ONE ENTRY PER FACE (≤ MAX_FACES_PER_SOURCE) rather than a single
  // last-write-wins descriptor, so a room with a parent and a child stops
  // reporting whichever of them the detector happened to pick.
  const unmatchedDescriptorsRef = useRef<Map<string, UnknownFaceDescriptor[]>>(new Map());
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
        // detectAllFaces, not detectSingleFace: the presence ledger needs to
        // know how MANY people the camera can see — a face count is the only
        // hard ceiling on how many people the AI may claim are in the room —
        // and a second person in frame is precisely the situation where a
        // single-face guess picks the wrong one.
        const baseTask = () => faceapi
          .detectAllFaces(element, detectorOptions())
          .withFaceLandmarks(true); // Use tiny landmarks

        // Age/sex ride along ONLY when the optional net loaded. Everything past
        // this point must behave identically either way — the extra pass adds
        // fields, it never gates the descriptor.
        let detections: any[] = [];
        if (ageGenderLoaded) {
          try {
            detections = await baseTask().withAgeAndGender().withFaceDescriptors();
          } catch (agErr) {
            console.warn("[PersonID] age/gender pass failed — retrying descriptor only:", agErr);
            detections = await baseTask().withFaceDescriptors();
          }
        } else {
          detections = await baseTask().withFaceDescriptors();
        }

        if (!detections || detections.length === 0) {
          // Clear stale descriptors for this source so empty cameras don't keep
          // sending old data after the person leaves the frame. The TRACKS are
          // deliberately left alone — a blink or a turned head is a gap of a
          // tick or two, and `lostAfterMs` is what decides when continuity is
          // genuinely broken.
          unmatchedDescriptorsRef.current.delete(sourceKey);
          return null;
        }

        // The honest face count, taken BEFORE the cap: the server treats it as
        // a ceiling, so it must never read lower than what the camera saw.
        const facesInFrame = detections.length;

        // Largest first, then capped. Size is the closest cheap proxy for "who
        // is actually with the child" — and it keeps the primary face (index 0)
        // the same one `detectSingleFace` would most often have returned.
        // (The cap trims what we SEND and track, not what face-api computed:
        // the chained task already ran a descriptor per detection. At
        // scoreThreshold 0.5 on a 224px input a room with more than three
        // detected faces is rare enough not to buy back with a hand-rolled
        // per-face `computeFaceDescriptor` pass.)
        const boxArea = (d: any) => {
          const b = d?.detection?.box;
          return b ? b.width * b.height : 0;
        };
        const kept = [...detections].sort((a, b) => boxArea(b) - boxArea(a)).slice(0, MAX_FACES_PER_SOURCE);

        // Frame quality (frontality/size/score) — sent with each descriptor so
        // the server can decide whether this pose is worth adding to the
        // person's gallery. Cheap; computed for every detection.
        const elementW = element instanceof HTMLVideoElement ? element.videoWidth : element.width;
        const elementH = element instanceof HTMLVideoElement ? element.videoHeight : element.height;
        const qualities = kept.map(d => assessFaceQuality(d, elementW, elementH));
        const descriptors = kept.map(d => Array.from(d.descriptor as Float32Array) as number[]);

        // Tie this frame's faces to the ones from the last frame. Quality is
        // passed through so a blurred profile shot moves the box without
        // polluting the track's averaged descriptor.
        const now = Date.now();
        const tracks = faceTrackAssociator.associate(
          sourceKey,
          kept.map((d, i) => {
            const b = d.detection.box;
            return {
              box: { x: b.x, y: b.y, w: b.width, h: b.height },
              descriptor: descriptors[i],
              quality: qualities[i],
            };
          }),
          now,
        );

        // Always surface every detected descriptor so the server can run its
        // own (authoritative) database match. The local match below is kept
        // only for client-side face-image caching; the server is the source of
        // truth for the AI.
        const entries: UnknownFaceDescriptor[] = kept.map((detection, i) => {
          const box = detection.detection.box;
          const track = tracks[i];

          // Coarse observed attributes (present only when ageGenderNet ran and
          // produced usable numbers). Each is spread in individually so a
          // partial read — say an age with no gender label — still contributes
          // what it has, and a total miss leaves the payload byte-identical to
          // before.
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

          const sendMean = !!track?.meanDescriptor && track.descriptorCount >= 2;

          return {
            descriptor: descriptors[i],
            boundingBox: box ? { x: box.x, y: box.y, w: box.width, h: box.height } : undefined,
            cameraRole,
            cameraLabel,
            quality: qualities[i],
            ...(observedAge !== undefined ? { observedAge } : {}),
            ...(observedSex !== undefined ? { observedSex } : {}),
            ...(observedSexConfidence !== undefined ? { observedSexConfidence } : {}),
            ...(track
              ? {
                  trackId: track.trackId,
                  trackAgeMs: now - track.firstSeenAt,
                  framesInTrack: track.frames,
                  ...(sendMean ? { meanDescriptor: track.meanDescriptor as number[] } : {}),
                }
              : {}),
            facesInFrame,
          };
        });
        unmatchedDescriptorsRef.current.set(sourceKey, entries);

        // The primary face — largest in frame — is the one that drives
        // `currentIdentification` and the face-image cache, matching the old
        // single-face behaviour as closely as a multi-face pass can.
        const primary = kept[0];
        const primaryQuality = qualities[0];
        const result = matchFaceToKnownPeople(primary.descriptor);
        if (updateCurrent) {
          setCurrentIdentification(result);
        }

        if (updateCurrent && result.identified) {
          // Auto-capture face image for contacts (client-side cache only)
          if (result.person?.type === "contact") {
            const contactId = result.person.id;
            const cachedQuality = faceImageQualityRef.current.get(contactId);
            const shouldCache = !cachedQuality || primaryQuality > cachedQuality;

            if (shouldCache) {
              const imageData = cropFaceFromElement(element, primary.detection.box);
              if (imageData) {
                const dataUrl = `data:image/jpeg;base64,${imageData}`;
                faceImageQualityRef.current.set(contactId, primaryQuality);
                cacheFaceImageRef.current?.(contactId, dataUrl, primaryQuality);
                setLastCapturedFaceImage({
                  contactId,
                  contactName: result.person.name,
                  dataUrl,
                  quality: primaryQuality,
                  timestamp: Date.now(),
                });
                console.log(`[PersonID] Cached face image for "${result.person.name}" (${contactId}), quality=${primaryQuality.toFixed(3)}`);
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
    // Tracks go too: clearing the cache means "forget what you think you know
    // about who is here", and a surviving track would carry the old identity
    // straight back to the server on the next tick.
    faceTrackAssociator.reset();
  }, []);

  /** Every cached face across every camera — bounded at
   *  MAX_FACES_PER_SOURCE per source, so this stays small by construction. */
  const getUnmatchedDescriptors = useCallback((): UnknownFaceDescriptor[] => {
    const out: UnknownFaceDescriptor[] = [];
    for (const entries of unmatchedDescriptorsRef.current.values()) out.push(...entries);
    return out;
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
