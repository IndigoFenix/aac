// Biometric image processing: face-api loader + detect/crop/encode pipeline.
//
// Used by BiometricPhotoUpload (file path) and BiometricCameraDialog (camera
// path) so both go through the same flow:
//   1. Downscale source to MAX_DETECT_SIZE before face-api detection
//      — face-api.js runs synchronously on the main thread, and a 12 MP
//        source can freeze the UI for several seconds. Downscaling the
//        detection input is the single biggest perf win.
//   2. Crop the source to the detected face bbox + padding, square aspect.
//   3. Re-encode at OUTPUT_SIZE as JPEG for upload.

const FACE_API_CDN = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api/dist/face-api.min.js';
const MODEL_URL = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api/model';

const MAX_DETECT_SIZE = 800;
const OUTPUT_SIZE = 512;
const FACE_PADDING = 0.4;
const JPEG_QUALITY = 0.88;

let faceApiLoaded = false;
let faceApiPromise: Promise<void> | null = null;

export async function loadFaceApi(): Promise<void> {
  if (faceApiLoaded) return;
  if (faceApiPromise) return faceApiPromise;

  faceApiPromise = (async () => {
    if (!(window as any).faceapi) {
      await new Promise<void>((resolve, reject) => {
        const script = document.createElement('script');
        script.src = FACE_API_CDN;
        script.async = true;
        script.onload = () => resolve();
        script.onerror = () => reject(new Error('Failed to load face-api.js'));
        document.head.appendChild(script);
      });
    }
    const faceapi = (window as any).faceapi;
    if (!faceapi) throw new Error('face-api.js failed to load');
    await Promise.all([
      faceapi.nets.ssdMobilenetv1.loadFromUri(MODEL_URL),
      faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL),
      faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL),
    ]);
    faceApiLoaded = true;
  })();

  return faceApiPromise;
}

export interface BiometricProcessResult {
  blob: Blob;
  embedding: number[];
  quality: number;
  dataUrl: string;
}

export type BiometricProcessOutcome =
  | BiometricProcessResult
  | { embedding: null };

function getSourceDims(source: HTMLImageElement | HTMLVideoElement | HTMLCanvasElement): [number, number] {
  if (source instanceof HTMLVideoElement) return [source.videoWidth, source.videoHeight];
  if (source instanceof HTMLImageElement) return [source.naturalWidth || source.width, source.naturalHeight || source.height];
  return [source.width, source.height];
}

/**
 * Detect a face in the source, then crop+resize the source around it. Returns
 * `{ embedding: null }` when no face is found.
 */
export async function processBiometricImage(
  source: HTMLImageElement | HTMLVideoElement | HTMLCanvasElement,
): Promise<BiometricProcessOutcome> {
  await loadFaceApi();
  const faceapi = (window as any).faceapi;

  const [sw, sh] = getSourceDims(source);
  if (!sw || !sh) throw new Error('Source has no dimensions');

  // Downscaled detection canvas — keeps face-api off the slow path.
  const scale = Math.min(1, MAX_DETECT_SIZE / Math.max(sw, sh));
  const dw = Math.max(1, Math.round(sw * scale));
  const dh = Math.max(1, Math.round(sh * scale));
  const detectCanvas = document.createElement('canvas');
  detectCanvas.width = dw;
  detectCanvas.height = dh;
  const dctx = detectCanvas.getContext('2d');
  if (!dctx) throw new Error('2D context unavailable');
  dctx.drawImage(source, 0, 0, dw, dh);

  const detection = await faceapi
    .detectSingleFace(detectCanvas)
    .withFaceLandmarks()
    .withFaceDescriptor();
  if (!detection) return { embedding: null };

  // Scale the detected bbox back to source coords.
  const box = detection.detection.box;
  const fx = box.x / scale;
  const fy = box.y / scale;
  const fw = box.width / scale;
  const fh = box.height / scale;

  // Pad and square the crop region.
  const padX = fw * FACE_PADDING;
  const padY = fh * FACE_PADDING;
  let cropX = fx - padX;
  let cropY = fy - padY;
  let cropW = fw + 2 * padX;
  let cropH = fh + 2 * padY;
  const side = Math.max(cropW, cropH);
  cropX -= (side - cropW) / 2;
  cropY -= (side - cropH) / 2;
  cropW = side;
  cropH = side;

  // Clamp to source bounds; if the padded box overflows, tighten on the
  // overflowing edge rather than letting drawImage produce black bars.
  if (cropX < 0) { cropW += cropX; cropX = 0; }
  if (cropY < 0) { cropH += cropY; cropY = 0; }
  if (cropX + cropW > sw) cropW = sw - cropX;
  if (cropY + cropH > sh) cropH = sh - cropY;

  const outCanvas = document.createElement('canvas');
  outCanvas.width = OUTPUT_SIZE;
  outCanvas.height = OUTPUT_SIZE;
  const octx = outCanvas.getContext('2d');
  if (!octx) throw new Error('Output 2D context unavailable');
  octx.drawImage(source, cropX, cropY, cropW, cropH, 0, 0, OUTPUT_SIZE, OUTPUT_SIZE);

  const blob = await new Promise<Blob>((resolve, reject) => {
    outCanvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('Image encoding failed'))),
      'image/jpeg',
      JPEG_QUALITY,
    );
  });

  return {
    blob,
    embedding: Array.from(detection.descriptor as Float32Array),
    quality: detection.detection.score,
    dataUrl: outCanvas.toDataURL('image/jpeg', JPEG_QUALITY),
  };
}

/**
 * Decode a File into an HTMLImageElement so it can be passed to
 * `processBiometricImage`. Caller is responsible for calling
 * `URL.revokeObjectURL(img.src)` after they're done with the image.
 */
export function fileToImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = document.createElement('img');
    img.src = URL.createObjectURL(file);
    img.onload = () => resolve(img);
    img.onerror = () => {
      URL.revokeObjectURL(img.src);
      reject(new Error('Image decode failed'));
    };
  });
}
