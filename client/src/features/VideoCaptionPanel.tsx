// src/features/VideoCaptionPanel.tsx
// Video Caption Studio — step 1: ingestion.
//
// Upload a video and a caption file (SRT/VTT), parse the captions into
// timestamped segments, and preview them against the playing video. Later
// steps add the AI text→glyph conversion, a glyph overlay on the player, and
// a WebCodecs MP4 export. The parsed `CaptionSegment[]` is the shared spine
// those steps build on, so this panel deliberately surfaces it as a list.

import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { useLanguage } from '@/contexts/LanguageContext';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Captions, FileVideo, FileText, Upload, Sparkles, Loader2, Download } from 'lucide-react';
import { cn } from '@/lib/utils';
import { apiRequest } from '@/lib/queryClient';
import { Glyph } from '@/components/Glyph';
import { GlyphCaptionOverlay } from '@/components/GlyphCaptionOverlay';
import {
  parseCaptionFile,
  formatTimestamp,
  CaptionParseError,
  type CaptionSegment,
  type GlyphCue,
} from '@/lib/captionParser';
import { exportCaptionedVideo, isVideoExportSupported } from '@/lib/videoExport';

interface VideoCaptionPanelProps {
  isOpen?: boolean;
}

export function VideoCaptionPanel(_props: VideoCaptionPanelProps) {
  const { t, isRTL, language } = useLanguage();
  const { toast } = useToast();

  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [videoName, setVideoName] = useState<string | null>(null);
  const [captionName, setCaptionName] = useState<string | null>(null);
  const [segments, setSegments] = useState<CaptionSegment[]>([]);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  // Glyph strings keyed by segment index, filled by the AI conversion step.
  const [glyphs, setGlyphs] = useState<Record<number, string>>({});
  const [generating, setGenerating] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState(0);

  // Export needs WebCodecs (Chrome/Edge today). Detected once.
  const exportSupported = useMemo(() => isVideoExportSupported(), []);
  const glyphCount = Object.keys(glyphs).length;

  const videoRef = useRef<HTMLVideoElement>(null);
  const videoInputRef = useRef<HTMLInputElement>(null);
  const captionInputRef = useRef<HTMLInputElement>(null);

  // Object URLs must be revoked when replaced or on unmount to avoid leaks.
  useEffect(() => {
    return () => {
      if (videoUrl) URL.revokeObjectURL(videoUrl);
    };
  }, [videoUrl]);

  const handleVideoSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setVideoFile(file);
    setVideoUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return URL.createObjectURL(file);
    });
    setVideoName(file.name);
  }, []);

  const handleCaptionSelect = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      try {
        const parsed = await parseCaptionFile(file);
        setSegments(parsed);
        setGlyphs({});
        setCaptionName(file.name);
        setActiveIndex(null);
      } catch (err) {
        const message =
          err instanceof CaptionParseError ? err.message : t('videoCaption.parseFailed');
        toast({ title: t('videoCaption.parseFailed'), description: message, variant: 'destructive' });
      }
    },
    [t, toast],
  );

  // Keep the highlighted segment in sync with playback.
  const handleTimeUpdate = useCallback(() => {
    const video = videoRef.current;
    if (!video || segments.length === 0) return;
    const ms = video.currentTime * 1000;
    const idx = segments.findIndex((s) => ms >= s.startMs && ms < s.endMs);
    setActiveIndex(idx === -1 ? null : idx);
  }, [segments]);

  // Clicking a segment seeks the video to its start.
  const seekTo = useCallback((segment: CaptionSegment) => {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = segment.startMs / 1000;
    void video.play().catch(() => {/* autoplay may be blocked; ignore */});
  }, []);

  // Convert every caption to a glyph SENTENCE via the server (text→glyph).
  const generateGlyphs = useCallback(async () => {
    if (segments.length === 0 || generating) return;
    setGenerating(true);
    try {
      const res = await apiRequest('POST', '/api/video-caption/glyphs', {
        segments: segments.map((s) => ({ startMs: s.startMs, endMs: s.endMs, text: s.text })),
        language,
      });
      const data = await res.json();
      if (!data?.success || !Array.isArray(data.segments)) {
        throw new Error('bad response');
      }
      const next: Record<number, string> = {};
      data.segments.forEach((s: { glyph?: string }, i: number) => {
        if (s.glyph) next[i] = s.glyph;
      });
      setGlyphs(next);
    } catch {
      toast({ title: t('videoCaption.glyphsFailed'), variant: 'destructive' });
    } finally {
      setGenerating(false);
    }
  }, [segments, generating, language, t, toast]);

  // Burn the glyph overlays into a downloadable MP4 (client-side, WebCodecs).
  const exportVideo = useCallback(async () => {
    if (!videoFile || exporting) return;
    const cues: GlyphCue[] = segments
      .map((s, i) => ({ startMs: s.startMs, endMs: s.endMs, glyph: glyphs[i] ?? '' }))
      .filter((c) => c.glyph);
    if (cues.length === 0) {
      toast({ title: t('videoCaption.exportNoGlyphs'), variant: 'destructive' });
      return;
    }
    setExporting(true);
    setExportProgress(0);
    try {
      const blob = await exportCaptionedVideo({
        file: videoFile,
        cues,
        rtl: isRTL,
        onProgress: setExportProgress,
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = (videoName?.replace(/\.[^.]+$/, '') ?? 'video') + '-glyphs.mp4';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      if ((err as Error)?.name !== 'AbortError') {
        toast({ title: t('videoCaption.exportFailed'), variant: 'destructive' });
      }
    } finally {
      setExporting(false);
    }
  }, [videoFile, exporting, segments, glyphs, isRTL, videoName, t, toast]);

  return (
    <div className="flex flex-col h-full min-h-0 p-4 gap-4" dir={isRTL ? 'rtl' : 'ltr'}>
      {/* Header */}
      <div className="flex items-center gap-2">
        <Captions className="w-5 h-5 text-primary" />
        <h2 className="text-lg font-semibold">{t('videoCaption.title')}</h2>
      </div>
      <p className="text-sm text-muted-foreground -mt-2">{t('videoCaption.description')}</p>

      {/* Upload controls */}
      <div className="flex flex-wrap gap-3">
        <input
          ref={videoInputRef}
          type="file"
          accept="video/*"
          className="hidden"
          onChange={handleVideoSelect}
          data-testid="video-caption-video-input"
        />
        <input
          ref={captionInputRef}
          type="file"
          accept=".srt,.vtt,text/vtt,application/x-subrip"
          className="hidden"
          onChange={handleCaptionSelect}
          data-testid="video-caption-caption-input"
        />
        <Button variant="outline" onClick={() => videoInputRef.current?.click()}>
          <FileVideo className="w-4 h-4 me-2" />
          {videoName ?? t('videoCaption.uploadVideo')}
        </Button>
        <Button variant="outline" onClick={() => captionInputRef.current?.click()}>
          <FileText className="w-4 h-4 me-2" />
          {captionName ?? t('videoCaption.uploadCaptions')}
        </Button>
      </div>

      {/* Video preview with live glyph overlay */}
      {videoUrl ? (
        <Card>
          <CardContent className="p-2">
            <div className="relative">
              <video
                ref={videoRef}
                src={videoUrl}
                controls
                className="w-full max-h-[40vh] rounded bg-black"
                onTimeUpdate={handleTimeUpdate}
                data-testid="video-caption-player"
              />
              <GlyphCaptionOverlay
                glyph={activeIndex != null ? glyphs[activeIndex] : undefined}
              />
            </div>
          </CardContent>
        </Card>
      ) : (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center justify-center gap-2 py-10 text-muted-foreground">
            <Upload className="w-8 h-8" />
            <span className="text-sm">{t('videoCaption.noVideo')}</span>
          </CardContent>
        </Card>
      )}

      {/* Parsed caption segments */}
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium">{t('videoCaption.segments')}</h3>
        <div className="flex items-center gap-3">
          {segments.length > 0 && (
            <span className="text-xs text-muted-foreground">
              {t('videoCaption.segmentCount').replace('{count}', String(segments.length))}
            </span>
          )}
          <Button
            size="sm"
            onClick={generateGlyphs}
            disabled={segments.length === 0 || generating}
            data-testid="video-caption-generate"
          >
            {generating ? (
              <Loader2 className="w-4 h-4 me-2 animate-spin" />
            ) : (
              <Sparkles className="w-4 h-4 me-2" />
            )}
            {t('videoCaption.generateGlyphs')}
          </Button>
          {exportSupported && (
            <Button
              size="sm"
              variant="outline"
              onClick={exportVideo}
              disabled={!videoFile || glyphCount === 0 || exporting}
              data-testid="video-caption-export"
            >
              {exporting ? (
                <Loader2 className="w-4 h-4 me-2 animate-spin" />
              ) : (
                <Download className="w-4 h-4 me-2" />
              )}
              {exporting
                ? `${Math.round(exportProgress * 100)}%`
                : t('videoCaption.export')}
            </Button>
          )}
        </div>
      </div>
      {!exportSupported && glyphCount > 0 && (
        <p className="text-xs text-muted-foreground -mt-2">{t('videoCaption.exportUnsupported')}</p>
      )}

      <ScrollArea className="flex-1 min-h-0 rounded-md border">
        {segments.length === 0 ? (
          <div className="p-6 text-center text-sm text-muted-foreground">
            {t('videoCaption.noCaptions')}
          </div>
        ) : (
          <ul className="divide-y">
            {segments.map((segment, i) => (
              <li key={i}>
                <button
                  type="button"
                  onClick={() => seekTo(segment)}
                  className={cn(
                    'w-full text-start px-3 py-2 flex gap-3 hover:bg-accent transition-colors',
                    activeIndex === i && 'bg-accent',
                  )}
                  data-testid={`video-caption-segment-${i}`}
                >
                  <span className="text-xs font-mono text-muted-foreground shrink-0 pt-0.5 tabular-nums">
                    {formatTimestamp(segment.startMs)}
                  </span>
                  {glyphs[i] && (
                    <span className="shrink-0">
                      <Glyph glyph={glyphs[i]} height={40} />
                    </span>
                  )}
                  <span className="text-sm">{segment.text}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </ScrollArea>
    </div>
  );
}
