// src/components/BiometricPhotoUpload.tsx
// Reusable photo upload for biometric data. Used by:
//   - StudentModal (student face)
//   - User profile (user face)
//   - StudentContactsPanel (contact face)
//
// The client extracts the 128D face embedding via face-api.js before upload,
// so the server doesn't need its own face detection. Image + embedding are
// sent together as multipart form-data.

import { useState, useRef, useEffect } from 'react';
import { apiRequest, apiUrl } from '@/lib/queryClient';
import { useLanguage } from '@/contexts/LanguageContext';
import { useToast } from '@/hooks/use-toast';

import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Upload, Loader2, AlertTriangle, Camera } from 'lucide-react';

// =============================================================================
// Face-api loader (CDN) — shared across all biometric components.
// =============================================================================

let faceApiLoaded = false;
let faceApiPromise: Promise<void> | null = null;

async function loadFaceApi(): Promise<void> {
  if (faceApiLoaded) return;
  if (faceApiPromise) return faceApiPromise;

  faceApiPromise = new Promise(async (resolve, reject) => {
    try {
      if ((window as any).faceapi) {
        faceApiLoaded = true;
        resolve();
        return;
      }
      const script = document.createElement('script');
      script.src = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api/dist/face-api.min.js';
      script.async = true;
      script.onload = async () => {
        const faceapi = (window as any).faceapi;
        if (!faceapi) {
          reject(new Error('face-api.js failed to load'));
          return;
        }
        const MODEL_URL = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api/model';
        await Promise.all([
          faceapi.nets.ssdMobilenetv1.loadFromUri(MODEL_URL),
          faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL),
          faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL),
        ]);
        faceApiLoaded = true;
        resolve();
      };
      script.onerror = () => reject(new Error('Failed to load face-api.js'));
      document.head.appendChild(script);
    } catch (error) {
      reject(error);
    }
  });

  return faceApiPromise;
}

async function extractEmbedding(img: HTMLImageElement): Promise<{ embedding: number[] | null; quality?: number }> {
  await loadFaceApi();
  const faceapi = (window as any).faceapi;
  const detection = await faceapi
    .detectSingleFace(img)
    .withFaceLandmarks()
    .withFaceDescriptor();
  if (!detection) return { embedding: null };
  // Quality proxy: detection score (0-1). face-api already gates low-score
  // detections; anything past the gate is usable.
  return { embedding: Array.from(detection.descriptor as Float32Array), quality: detection.detection.score };
}

// =============================================================================
// Component
// =============================================================================

export type BiometricPhotoTarget =
  | { type: 'user'; userId: string }
  | { type: 'student'; studentId: string }
  | { type: 'contact'; studentId: string; contactId: string };

interface BiometricPhotoUploadProps {
  target: BiometricPhotoTarget;
  currentPhotoUrl?: string | null;     // S3 URL path (key) — not a raw URL
  biometricDataId?: string | null;     // for rendering the current photo
  disabled?: boolean;
  onUploaded?: (result: { biometricDataId: string; faceImageUrl: string }) => void;
  /** When true, hides the description prompt under the button */
  dense?: boolean;
}

export function BiometricPhotoUpload({
  target,
  currentPhotoUrl,
  biometricDataId,
  disabled,
  onUploaded,
  dense,
}: BiometricPhotoUploadProps) {
  const { t } = useLanguage();
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [uploading, setUploading] = useState(false);
  const [faceApiReady, setFaceApiReady] = useState(false);
  const [faceApiError, setFaceApiError] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);

  useEffect(() => {
    loadFaceApi()
      .then(() => setFaceApiReady(true))
      .catch((err) => {
        console.error('[BiometricPhotoUpload] face-api load error:', err);
        setFaceApiError(t('biometric.faceApiError'));
      });
  }, [t]);

  // Render a live preview from the stored photo via API (auth-gated passthrough).
  // Route through apiUrl so VITE_API_URL is honored in local dev.
  const displayedPhoto = preview || (biometricDataId ? apiUrl(`/api/biometric-data/${biometricDataId}/photo`) : null);

  function endpointFor(target: BiometricPhotoTarget): string {
    if (target.type === 'user') return `/api/biometric/users/${target.userId}/photo`;
    if (target.type === 'student') return `/api/biometric/students/${target.studentId}/photo`;
    return `/api/biometric/students/${target.studentId}/contacts/${target.contactId}/photo`;
  }

  async function handleFile(file: File) {
    if (!file.type.startsWith('image/')) {
      toast({ title: t('common.error'), description: t('biometric.fileTypeError'), variant: 'destructive' });
      return;
    }

    setUploading(true);
    try {
      // Local preview
      const reader = new FileReader();
      reader.onload = () => setPreview(reader.result as string);
      reader.readAsDataURL(file);

      // Extract 128D embedding client-side
      const img = document.createElement('img');
      img.src = URL.createObjectURL(file);
      await new Promise<void>((res, rej) => {
        img.onload = () => res();
        img.onerror = () => rej(new Error('image load failed'));
      });

      const { embedding, quality } = await extractEmbedding(img);
      URL.revokeObjectURL(img.src);

      if (!embedding) {
        toast({
          title: t('biometric.noFaceDetected'),
          description: t('biometric.noFaceDetectedHint'),
          variant: 'destructive',
        });
        setPreview(null);
        return;
      }

      // Multipart upload — apiRequest handles FormData + prefixes VITE_API_URL
      const form = new FormData();
      form.append('image', file);
      form.append('embedding', JSON.stringify(embedding));
      if (quality !== undefined) form.append('quality', String(quality));

      const response = await apiRequest('POST', endpointFor(target), form);
      const data = await response.json();
      if (!data.success) {
        throw new Error(data.message || 'Upload failed');
      }

      toast({ title: t('biometric.photoUploaded') });
      onUploaded?.({ biometricDataId: data.biometricDataId, faceImageUrl: data.faceImageUrl });
    } catch (err: any) {
      console.error('[BiometricPhotoUpload] error:', err);
      toast({ title: t('common.error'), description: err.message, variant: 'destructive' });
      setPreview(null);
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  return (
    <div className="space-y-2">
      {faceApiError && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription>{faceApiError}</AlertDescription>
        </Alert>
      )}

      <div className="flex items-center gap-3">
        {displayedPhoto ? (
          <img
            src={displayedPhoto}
            alt=""
            className="w-16 h-16 rounded-lg object-cover border"
            onError={(e) => ((e.currentTarget as HTMLImageElement).style.display = 'none')}
          />
        ) : (
          <div className="w-16 h-16 rounded-lg border bg-muted flex items-center justify-center">
            <Camera className="w-6 h-6 text-muted-foreground" />
          </div>
        )}
        <div className="flex flex-col gap-2 flex-1 min-w-0">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) handleFile(file);
            }}
          />
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => fileInputRef.current?.click()}
            disabled={disabled || uploading || !faceApiReady}
            className="w-fit"
          >
            {uploading ? (
              <Loader2 className="w-4 h-4 me-2 animate-spin" />
            ) : (
              <Upload className="w-4 h-4 me-2" />
            )}
            {uploading
              ? t('biometric.uploading')
              : displayedPhoto
              ? t('biometric.replacePhoto')
              : t('biometric.uploadPhoto')}
          </Button>
          {!dense && (
            <p className="text-xs text-muted-foreground">{t('biometric.photoHint')}</p>
          )}
        </div>
      </div>
    </div>
  );
}
