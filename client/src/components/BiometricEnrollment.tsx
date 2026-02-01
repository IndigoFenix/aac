// src/components/BiometricEnrollment.tsx
// Component for enrolling face and voice biometric data

import { useState, useRef, useCallback, useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '@/lib/queryClient';
import { useLanguage } from '@/contexts/LanguageContext';
import { useToast } from '@/hooks/use-toast';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import {
  Camera,
  Mic,
  Upload,
  Trash2,
  CheckCircle2,
  XCircle,
  Loader2,
  RefreshCw,
  AlertTriangle,
} from 'lucide-react';

// =============================================================================
// TYPES
// =============================================================================

interface BiometricEnrollmentProps {
  entityType: 'user' | 'student';
  entityId: string;
  compact?: boolean; // For embedding in modals
}

interface EnrollmentStatus {
  face: boolean;
  voice: boolean;
}

// =============================================================================
// FACE-API LOADING (client-side face detection)
// We'll use face-api.js loaded from CDN for face detection
// =============================================================================

let faceApiLoaded = false;
let faceApiPromise: Promise<void> | null = null;

async function loadFaceApi(): Promise<void> {
  if (faceApiLoaded) return;
  if (faceApiPromise) return faceApiPromise;

  faceApiPromise = new Promise(async (resolve, reject) => {
    try {
      // Check if already loaded
      if ((window as any).faceapi) {
        faceApiLoaded = true;
        resolve();
        return;
      }

      // Load face-api.js from CDN
      const script = document.createElement('script');
      script.src = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api/dist/face-api.min.js';
      script.async = true;

      script.onload = async () => {
        const faceapi = (window as any).faceapi;
        if (!faceapi) {
          reject(new Error('face-api.js failed to load'));
          return;
        }

        // Load models
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

async function extractFaceEmbedding(imageElement: HTMLImageElement | HTMLVideoElement): Promise<number[] | null> {
  try {
    await loadFaceApi();
    const faceapi = (window as any).faceapi;

    const detection = await faceapi
      .detectSingleFace(imageElement)
      .withFaceLandmarks()
      .withFaceDescriptor();

    if (!detection) {
      return null;
    }

    // Return the 128-dimensional face descriptor
    return Array.from(detection.descriptor);
  } catch (error) {
    console.error('[BiometricEnrollment] Face detection error:', error);
    return null;
  }
}

// =============================================================================
// COMPONENT
// =============================================================================

export function BiometricEnrollment({
  entityType,
  entityId,
  compact = false,
}: BiometricEnrollmentProps) {
  const { t, isRTL } = useLanguage();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // Video ref for camera capture
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // State
  const [cameraActive, setCameraActive] = useState(false);
  const [cameraStream, setCameraStream] = useState<MediaStream | null>(null);
  const [processingFace, setProcessingFace] = useState(false);
  const [faceApiReady, setFaceApiReady] = useState(false);
  const [faceApiError, setFaceApiError] = useState<string | null>(null);

  // Load face-api on mount
  useEffect(() => {
    loadFaceApi()
      .then(() => setFaceApiReady(true))
      .catch((err) => {
        console.error('[BiometricEnrollment] Failed to load face-api:', err);
        setFaceApiError('Failed to load face detection library');
      });
  }, []);

  // Cleanup camera on unmount
  useEffect(() => {
    return () => {
      if (cameraStream) {
        cameraStream.getTracks().forEach((track) => track.stop());
      }
    };
  }, [cameraStream]);

  // ==========================================================================
  // QUERIES
  // ==========================================================================

  const basePath = entityType === 'user' ? 'users' : 'students';

  const { data: faceStatus, refetch: refetchFaceStatus } = useQuery({
    queryKey: [`/api/biometric/${basePath}/${entityId}/face`],
    queryFn: async () => {
      const res = await apiRequest('GET', `/api/biometric/${basePath}/${entityId}/face`);
      return res.json();
    },
    enabled: !!entityId,
  });

  const { data: voiceStatus, refetch: refetchVoiceStatus } = useQuery({
    queryKey: [`/api/biometric/${basePath}/${entityId}/voice`],
    queryFn: async () => {
      const res = await apiRequest('GET', `/api/biometric/${basePath}/${entityId}/voice`);
      return res.json();
    },
    enabled: !!entityId,
  });

  const hasFace = faceStatus?.enrolled ?? false;
  const hasVoice = voiceStatus?.enrolled ?? false;

  // ==========================================================================
  // MUTATIONS
  // ==========================================================================

  const enrollFaceMutation = useMutation({
    mutationFn: async (embedding: number[]) => {
      const res = await apiRequest('POST', `/api/biometric/${basePath}/${entityId}/face`, {
        embedding,
      });
      return res.json();
    },
    onSuccess: () => {
      refetchFaceStatus();
      toast({
        title: t('biometric.faceEnrolled') || 'Face Enrolled',
        description: t('biometric.faceEnrolledDesc') || 'Face recognition has been set up successfully.',
      });
    },
    onError: (error: any) => {
      toast({
        title: t('biometric.enrollFailed') || 'Enrollment Failed',
        description: error?.message || 'Failed to enroll face.',
        variant: 'destructive',
      });
    },
  });

  const removeFaceMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest('DELETE', `/api/biometric/${basePath}/${entityId}/face`);
      return res.json();
    },
    onSuccess: () => {
      refetchFaceStatus();
      toast({
        title: t('biometric.faceRemoved') || 'Face Removed',
        description: t('biometric.faceRemovedDesc') || 'Face recognition data has been removed.',
      });
    },
    onError: (error: any) => {
      toast({
        title: t('biometric.removeFailed') || 'Removal Failed',
        description: error?.message || 'Failed to remove face data.',
        variant: 'destructive',
      });
    },
  });

  const enrollVoiceMutation = useMutation({
    mutationFn: async (embedding: number[]) => {
      const res = await apiRequest('POST', `/api/biometric/${basePath}/${entityId}/voice`, {
        embedding,
      });
      return res.json();
    },
    onSuccess: () => {
      refetchVoiceStatus();
      toast({
        title: t('biometric.voiceEnrolled') || 'Voice Enrolled',
        description: t('biometric.voiceEnrolledDesc') || 'Voice recognition has been set up successfully.',
      });
    },
    onError: (error: any) => {
      toast({
        title: t('biometric.enrollFailed') || 'Enrollment Failed',
        description: error?.message || 'Failed to enroll voice.',
        variant: 'destructive',
      });
    },
  });

  const removeVoiceMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest('DELETE', `/api/biometric/${basePath}/${entityId}/voice`);
      return res.json();
    },
    onSuccess: () => {
      refetchVoiceStatus();
      toast({
        title: t('biometric.voiceRemoved') || 'Voice Removed',
        description: t('biometric.voiceRemovedDesc') || 'Voice recognition data has been removed.',
      });
    },
    onError: (error: any) => {
      toast({
        title: t('biometric.removeFailed') || 'Removal Failed',
        description: error?.message || 'Failed to remove voice data.',
        variant: 'destructive',
      });
    },
  });

  // ==========================================================================
  // CAMERA HANDLERS
  // ==========================================================================

  const startCamera = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: 640, height: 480 },
      });
      setCameraStream(stream);
      setCameraActive(true);

      if (videoRef.current) {
        videoRef.current.srcObject = stream;
      }
    } catch (error) {
      console.error('[BiometricEnrollment] Camera error:', error);
      toast({
        title: t('biometric.cameraError') || 'Camera Error',
        description: t('biometric.cameraErrorDesc') || 'Could not access the camera. Please check permissions.',
        variant: 'destructive',
      });
    }
  };

  const stopCamera = () => {
    if (cameraStream) {
      cameraStream.getTracks().forEach((track) => track.stop());
      setCameraStream(null);
    }
    setCameraActive(false);
  };

  const captureAndEnrollFace = async () => {
    if (!videoRef.current || !faceApiReady) return;

    setProcessingFace(true);
    try {
      const embedding = await extractFaceEmbedding(videoRef.current);

      if (!embedding) {
        toast({
          title: t('biometric.noFaceDetected') || 'No Face Detected',
          description: t('biometric.noFaceDetectedDesc') || 'Please position your face clearly in the camera view.',
          variant: 'destructive',
        });
        return;
      }

      await enrollFaceMutation.mutateAsync(embedding);
      stopCamera();
    } catch (error) {
      console.error('[BiometricEnrollment] Capture error:', error);
    } finally {
      setProcessingFace(false);
    }
  };

  // ==========================================================================
  // FILE UPLOAD HANDLER
  // ==========================================================================

  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file || !faceApiReady) return;

    setProcessingFace(true);
    try {
      // Create image element
      const img = new Image();
      img.src = URL.createObjectURL(file);

      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error('Failed to load image'));
      });

      const embedding = await extractFaceEmbedding(img);
      URL.revokeObjectURL(img.src);

      if (!embedding) {
        toast({
          title: t('biometric.noFaceDetected') || 'No Face Detected',
          description: t('biometric.noFaceInImageDesc') || 'No face was detected in the uploaded image.',
          variant: 'destructive',
        });
        return;
      }

      await enrollFaceMutation.mutateAsync(embedding);
    } catch (error) {
      console.error('[BiometricEnrollment] File upload error:', error);
      toast({
        title: t('biometric.uploadError') || 'Upload Error',
        description: t('biometric.uploadErrorDesc') || 'Failed to process the uploaded image.',
        variant: 'destructive',
      });
    } finally {
      setProcessingFace(false);
      // Reset file input
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  // ==========================================================================
  // RENDER
  // ==========================================================================

  if (compact) {
    // Compact version for embedding in modals
    return (
      <div className="space-y-4">
        <Separator />
        <div className="space-y-2">
          <h4 className="text-sm font-medium">
            {t('biometric.title') || 'Biometric Recognition'}
          </h4>
          <p className="text-xs text-muted-foreground">
            {t('biometric.description') || 'Set up face and voice recognition for identification.'}
          </p>
        </div>

        {/* Face Status */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Camera className="w-4 h-4" />
            <span className="text-sm">{t('biometric.faceRecognition') || 'Face Recognition'}</span>
            {hasFace ? (
              <Badge variant="default" className="text-xs">
                <CheckCircle2 className="w-3 h-3 mr-1" />
                {t('biometric.enrolled') || 'Enrolled'}
              </Badge>
            ) : (
              <Badge variant="outline" className="text-xs">
                <XCircle className="w-3 h-3 mr-1" />
                {t('biometric.notEnrolled') || 'Not Enrolled'}
              </Badge>
            )}
          </div>
          <div className="flex gap-1">
            {!cameraActive ? (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={startCamera}
                  disabled={!faceApiReady || processingFace}
                >
                  <Camera className="w-3 h-3 mr-1" />
                  {t('biometric.capture') || 'Capture'}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={!faceApiReady || processingFace}
                >
                  <Upload className="w-3 h-3" />
                </Button>
                {hasFace && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => removeFaceMutation.mutate()}
                    disabled={removeFaceMutation.isPending}
                  >
                    <Trash2 className="w-3 h-3 text-destructive" />
                  </Button>
                )}
              </>
            ) : (
              <>
                <Button
                  size="sm"
                  onClick={captureAndEnrollFace}
                  disabled={processingFace}
                >
                  {processingFace ? (
                    <Loader2 className="w-3 h-3 animate-spin" />
                  ) : (
                    t('biometric.enroll') || 'Enroll'
                  )}
                </Button>
                <Button size="sm" variant="ghost" onClick={stopCamera}>
                  {t('common.cancel') || 'Cancel'}
                </Button>
              </>
            )}
          </div>
        </div>

        {/* Camera preview */}
        {cameraActive && (
          <div className="relative aspect-video bg-black rounded-lg overflow-hidden">
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              className="w-full h-full object-cover"
            />
            {processingFace && (
              <div className="absolute inset-0 bg-black/50 flex items-center justify-center">
                <Loader2 className="w-8 h-8 animate-spin text-white" />
              </div>
            )}
          </div>
        )}

        {/* Voice Status (placeholder for now) */}
        <div className="flex items-center justify-between opacity-50">
          <div className="flex items-center gap-2">
            <Mic className="w-4 h-4" />
            <span className="text-sm">{t('biometric.voiceRecognition') || 'Voice Recognition'}</span>
            <Badge variant="outline" className="text-xs">
              {t('biometric.comingSoon') || 'Coming Soon'}
            </Badge>
          </div>
        </div>

        {/* Hidden file input */}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={handleFileUpload}
        />

        {/* Face API loading error */}
        {faceApiError && (
          <Alert variant="destructive">
            <AlertTriangle className="w-4 h-4" />
            <AlertDescription>{faceApiError}</AlertDescription>
          </Alert>
        )}
      </div>
    );
  }

  // Full card version
  return (
    <Card>
      <CardHeader>
        <CardTitle className={isRTL ? 'text-right' : ''}>
          {t('biometric.title') || 'Biometric Recognition'}
        </CardTitle>
        <CardDescription className={isRTL ? 'text-right' : ''}>
          {t('biometric.description') || 'Set up face and voice recognition for identification.'}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Face Recognition Section */}
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Camera className="w-5 h-5" />
              <span className="font-medium">{t('biometric.faceRecognition') || 'Face Recognition'}</span>
            </div>
            {hasFace ? (
              <Badge variant="default">
                <CheckCircle2 className="w-3 h-3 mr-1" />
                {t('biometric.enrolled') || 'Enrolled'}
              </Badge>
            ) : (
              <Badge variant="outline">
                <XCircle className="w-3 h-3 mr-1" />
                {t('biometric.notEnrolled') || 'Not Enrolled'}
              </Badge>
            )}
          </div>

          {cameraActive ? (
            <div className="space-y-4">
              <div className="relative aspect-video bg-black rounded-lg overflow-hidden">
                <video
                  ref={videoRef}
                  autoPlay
                  playsInline
                  muted
                  className="w-full h-full object-cover"
                />
                {processingFace && (
                  <div className="absolute inset-0 bg-black/50 flex items-center justify-center">
                    <Loader2 className="w-8 h-8 animate-spin text-white" />
                  </div>
                )}
              </div>
              <div className="flex gap-2">
                <Button onClick={captureAndEnrollFace} disabled={processingFace}>
                  {processingFace ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      {t('biometric.processing') || 'Processing...'}
                    </>
                  ) : (
                    <>
                      <Camera className="w-4 h-4 mr-2" />
                      {t('biometric.captureAndEnroll') || 'Capture & Enroll'}
                    </>
                  )}
                </Button>
                <Button variant="outline" onClick={stopCamera}>
                  {t('common.cancel') || 'Cancel'}
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex gap-2">
              <Button
                variant="outline"
                onClick={startCamera}
                disabled={!faceApiReady || processingFace}
              >
                <Camera className="w-4 h-4 mr-2" />
                {t('biometric.useCamera') || 'Use Camera'}
              </Button>
              <Button
                variant="outline"
                onClick={() => fileInputRef.current?.click()}
                disabled={!faceApiReady || processingFace}
              >
                <Upload className="w-4 h-4 mr-2" />
                {t('biometric.uploadPhoto') || 'Upload Photo'}
              </Button>
              {hasFace && (
                <Button
                  variant="destructive"
                  onClick={() => removeFaceMutation.mutate()}
                  disabled={removeFaceMutation.isPending}
                >
                  <Trash2 className="w-4 h-4 mr-2" />
                  {t('biometric.remove') || 'Remove'}
                </Button>
              )}
            </div>
          )}
        </div>

        <Separator />

        {/* Voice Recognition Section (placeholder) */}
        <div className="space-y-4 opacity-50">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Mic className="w-5 h-5" />
              <span className="font-medium">{t('biometric.voiceRecognition') || 'Voice Recognition'}</span>
            </div>
            <Badge variant="secondary">
              {t('biometric.comingSoon') || 'Coming Soon'}
            </Badge>
          </div>
          <p className="text-sm text-muted-foreground">
            {t('biometric.voiceComingSoonDesc') || 'Voice recognition enrollment will be available in a future update.'}
          </p>
        </div>

        {/* Hidden file input */}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={handleFileUpload}
        />

        {/* Errors */}
        {faceApiError && (
          <Alert variant="destructive">
            <AlertTriangle className="w-4 h-4" />
            <AlertDescription>{faceApiError}</AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  );
}
