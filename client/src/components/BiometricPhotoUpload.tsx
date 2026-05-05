// src/components/BiometricPhotoUpload.tsx
// Reusable photo upload for biometric data. Used by:
//   - StudentModal (student face)
//   - User profile (user face)
//   - StudentContactsPanel (contact face)
//
// Two capture paths:
//   - File picker → resize-before-detect, auto-crop to face bbox, upload
//     the cropped JPEG.
//   - Camera (BiometricCameraDialog) → live preview → snapshot → same
//     auto-crop pipeline.
//
// The cropped image + 128D embedding are sent together as multipart
// form-data; the server doesn't run face detection.

import { useState, useRef, useEffect } from 'react';
import { apiUrl } from '@/lib/queryClient';
import { useLanguage } from '@/contexts/LanguageContext';
import { useToast } from '@/hooks/use-toast';

import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Upload, Loader2, AlertTriangle, Camera } from 'lucide-react';
import {
  loadFaceApi,
  processBiometricImage,
  fileToImage,
  type BiometricProcessResult,
} from '@/lib/biometricImage';
import { BiometricCameraDialog } from '@/components/BiometricCameraDialog';

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
  const [cameraOpen, setCameraOpen] = useState(false);

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

  async function uploadResult(processed: BiometricProcessResult) {
    setUploading(true);
    setPreview(processed.dataUrl);
    try {
      const form = new FormData();
      form.append('image', processed.blob, 'photo.jpg');
      form.append('embedding', JSON.stringify(processed.embedding));
      form.append('quality', String(processed.quality));

      const response = await fetch(apiUrl(endpointFor(target)), {
        method: 'POST',
        credentials: 'include',
        body: form,
      });
      const data = await response.json().catch(() => ({}));

      if (!response.ok || !data.success) {
        if (data.code === 'NO_FACE') {
          toast({
            title: t('biometric.noFaceDetected'),
            description: t('biometric.noFaceDetectedHint'),
            variant: 'destructive',
          });
          setPreview(null);
          return;
        }
        throw new Error(data.message || `Upload failed (${response.status})`);
      }

      toast({ title: t('biometric.photoUploaded') });
      onUploaded?.({ biometricDataId: data.biometricDataId, faceImageUrl: data.faceImageUrl });
    } catch (err: any) {
      console.error('[BiometricPhotoUpload] error:', err);
      toast({ title: t('common.error'), description: err.message, variant: 'destructive' });
      setPreview(null);
    } finally {
      setUploading(false);
    }
  }

  async function handleFile(file: File) {
    if (!file.type.startsWith('image/')) {
      toast({ title: t('common.error'), description: t('biometric.fileTypeError'), variant: 'destructive' });
      return;
    }

    setUploading(true);
    let img: HTMLImageElement | null = null;
    try {
      img = await fileToImage(file);
      // Yield to the browser so the spinner paints before face-api blocks
      // the main thread; without this the upload button looks frozen until
      // detection completes.
      await new Promise((r) => setTimeout(r, 0));
      const processed = await processBiometricImage(img);
      if (!('blob' in processed)) {
        toast({
          title: t('biometric.noFaceDetected'),
          description: t('biometric.noFaceDetectedHint'),
          variant: 'destructive',
        });
        return;
      }
      // Hand off to the shared upload path.
      await uploadResult(processed);
    } catch (err: any) {
      console.error('[BiometricPhotoUpload] processing error:', err);
      toast({ title: t('common.error'), description: err.message, variant: 'destructive' });
      setPreview(null);
    } finally {
      if (img) URL.revokeObjectURL(img.src);
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  function handleCameraCapture(result: BiometricProcessResult) {
    void uploadResult(result);
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
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => fileInputRef.current?.click()}
              disabled={disabled || uploading || !faceApiReady}
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
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setCameraOpen(true)}
              disabled={disabled || uploading || !faceApiReady}
            >
              <Camera className="w-4 h-4 me-2" />
              {t('biometric.takePhoto') || 'Take Photo'}
            </Button>
          </div>
          {!dense && (
            <p className="text-xs text-muted-foreground">{t('biometric.photoHint')}</p>
          )}
        </div>
      </div>

      <BiometricCameraDialog
        isOpen={cameraOpen}
        onClose={() => setCameraOpen(false)}
        onCapture={handleCameraCapture}
      />
    </div>
  );
}
