// src/components/BiometricCameraDialog.tsx
// Camera-capture modal for biometric face photos. Opens getUserMedia, lets
// the user snap a frame, runs the same auto-crop pipeline as the file path,
// and returns the cropped JPEG + embedding to the caller.
//
// Display is mirrored throughout (live preview + frozen snapshot + cropped
// result) so the user sees themselves "as in a mirror" — natural selfie
// behavior. The captured canvas is drawn mirrored, so the saved photo
// matches what the user saw at capture time.
//
// Camera tracks are stopped on capture, retake-restart, close, and unmount.

import { useEffect, useRef, useState } from 'react';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Camera, Check, Loader2, RefreshCw } from 'lucide-react';
import { useLanguage } from '@/contexts/LanguageContext';
import { useToast } from '@/hooks/use-toast';
import {
  processBiometricImage,
  type BiometricProcessResult,
} from '@/lib/biometricImage';

export type CameraCaptureResult = BiometricProcessResult;

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onCapture: (result: CameraCaptureResult) => void;
}

export function BiometricCameraDialog({ isOpen, onClose, onCapture }: Props) {
  const { t } = useLanguage();
  const { toast } = useToast();
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const [starting, setStarting] = useState(false);
  const [streamActive, setStreamActive] = useState(false);
  const [processing, setProcessing] = useState(false);
  // Frozen snapshot shown while face-api is running. Already mirrored to
  // match the live preview, so the visual handoff has no visible flip.
  const [frozenUrl, setFrozenUrl] = useState<string | null>(null);
  const [result, setResult] = useState<CameraCaptureResult | null>(null);

  function stopStream() {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    setStreamActive(false);
  }

  async function startCamera() {
    setStarting(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: 'user',
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
      }
      setStreamActive(true);
      return true;
    } catch (err: any) {
      toast({
        title: t('biometric.cameraError') || 'Camera Error',
        description: err?.message || t('biometric.cameraErrorDesc') || 'Could not access the camera.',
        variant: 'destructive',
      });
      return false;
    } finally {
      setStarting(false);
    }
  }

  function fullClose() {
    stopStream();
    setResult(null);
    setFrozenUrl(null);
    setProcessing(false);
    onClose();
  }

  // Start the camera each time the dialog opens; stop it on close/unmount.
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    (async () => {
      const ok = await startCamera();
      if (cancelled || !ok) {
        // If the parent is still treating us as open, close so they can recover.
        if (!ok && !cancelled) onClose();
      }
    })();
    return () => {
      cancelled = true;
      stopStream();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  async function handleCapture() {
    const video = videoRef.current;
    if (!video || !streamActive) return;
    const w = video.videoWidth;
    const h = video.videoHeight;
    if (!w || !h) return;

    // 1. Snapshot the current frame to a mirrored canvas — same orientation
    //    the user just saw on screen.
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.translate(w, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(video, 0, 0, w, h);

    // 2. Show the frozen snapshot immediately and release the camera.
    setFrozenUrl(canvas.toDataURL('image/jpeg', 0.9));
    setProcessing(true);
    stopStream();

    // 3. Yield so React commits the frozen-display + spinner state before
    //    face-api blocks the main thread.
    await new Promise((r) => setTimeout(r, 0));

    try {
      const out = await processBiometricImage(canvas);
      if (!('blob' in out)) {
        toast({
          title: t('biometric.noFaceDetected'),
          description: t('biometric.noFaceDetectedHint'),
          variant: 'destructive',
        });
        // No usable face — drop the snapshot and re-open the camera so the
        // user can retake without an extra click.
        setFrozenUrl(null);
        setProcessing(false);
        await startCamera();
        return;
      }
      setResult(out);
      // Drop the frozen snapshot — the cropped result takes over the preview.
      setFrozenUrl(null);
    } catch (err: any) {
      toast({ title: t('common.error'), description: err.message, variant: 'destructive' });
      setFrozenUrl(null);
      await startCamera();
    } finally {
      setProcessing(false);
    }
  }

  async function handleRetake() {
    setResult(null);
    setFrozenUrl(null);
    await startCamera();
  }

  function handleConfirm() {
    if (!result) return;
    onCapture(result);
    fullClose();
  }

  return (
    <Dialog open={isOpen} onOpenChange={(o) => !o && fullClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('biometric.takePhoto') || 'Take a photo'}</DialogTitle>
          <DialogDescription>
            {t('biometric.cameraHint') || 'Center your face in the frame, then capture.'}
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <div className="relative aspect-square rounded-lg overflow-hidden bg-black">
            {result ? (
              // Cropped result — already mirrored because we drew the source
              // canvas mirrored before processing.
              <img
                src={result.dataUrl}
                alt=""
                className="absolute inset-0 w-full h-full object-cover"
              />
            ) : frozenUrl ? (
              // Frozen snapshot during processing — already mirrored on the
              // canvas, so no CSS transform.
              <img
                src={frozenUrl}
                alt=""
                className="absolute inset-0 w-full h-full object-cover"
              />
            ) : (
              // Live preview — mirror via CSS so the user sees themselves
              // "as in a mirror".
              <video
                ref={videoRef}
                autoPlay
                playsInline
                muted
                className="absolute inset-0 w-full h-full object-cover -scale-x-100"
              />
            )}
            {(starting || processing) && (
              <div className="absolute inset-0 flex items-center justify-center bg-black/50 text-white">
                <Loader2 className="w-8 h-8 animate-spin" />
              </div>
            )}
          </div>
        </DialogBody>
        <DialogFooter>
          {result ? (
            <>
              <Button variant="outline" onClick={handleRetake} disabled={starting}>
                <RefreshCw className="w-4 h-4 me-2" />
                {t('biometric.retake') || 'Retake'}
              </Button>
              <Button onClick={handleConfirm}>
                <Check className="w-4 h-4 me-2" />
                {t('biometric.useThisPhoto') || 'Use this photo'}
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" onClick={fullClose} disabled={processing}>
                {t('common.cancel')}
              </Button>
              <Button
                disabled={!streamActive || processing || starting}
                onClick={handleCapture}
              >
                <Camera className="w-4 h-4 me-2" />
                {t('biometric.capture') || 'Capture'}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
