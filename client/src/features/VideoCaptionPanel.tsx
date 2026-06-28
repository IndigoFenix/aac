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
import { useStudent } from '@/hooks/useStudent';
import { useInstitute } from '@/hooks/useInstitute';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Captions, FileVideo, FileText, Upload, Sparkles, Loader2, Download, Mic, Languages, Wand2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { apiRequest, apiUrl } from '@/lib/queryClient';
import { Glyph } from '@/components/Glyph';
import { registerStudentFace, registerSymbolPath, hasResolvedSymbol } from '@/lib/glyph-images';
import { parseGlyph, canResolveGlyph } from '@shared/glyph-compositor';
import { useSymbolStore } from '@/store/symbol-store';
import { GlyphCaptionOverlay } from '@/components/GlyphCaptionOverlay';
import { GlyphBuilder } from '@/components/syntAACx/glyph-builder';
import { CaptionTimeline, type TimelineStep } from '@/components/CaptionTimeline';
import { extractWavMono16k, STT_SAMPLE_RATE, AudioExtractError } from '@/lib/audioExtract';
import { useUIEvent } from '@/lib/uiEvents';
import { sha256Hex } from '@/lib/videoHash';
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

// Spoken/caption language options — the video's language may differ from the
// UI language, and it drives STT, glyph generation, and RTL. Mirrors the set in
// SettingsPanel.
const LANGUAGE_OPTIONS: Array<{ code: string; label: string }> = [
  { code: 'en', label: 'English' },
  { code: 'he', label: 'עברית' },
  { code: 'es', label: 'Español' },
  { code: 'pt', label: 'Português' },
  { code: 'fr', label: 'Français' },
  { code: 'ru', label: 'Русский' },
  { code: 'de', label: 'Deutsch' },
  { code: 'ar', label: 'العربية' },
  { code: 'zh', label: '中文' },
  { code: 'yue', label: '粵語' },
  { code: 'ko', label: '한국어' },
];

/** A caption segment plus its (optional) glyph — the persisted project shape. */
interface StoredSegment extends CaptionSegment {
  glyph?: string;
  fallback?: string;
}

const RTL_LANGS = new Set(['he', 'ar']);

export function VideoCaptionPanel(_props: VideoCaptionPanelProps) {
  const { t, isRTL, language } = useLanguage();
  const { student } = useStudent();
  const { currentInstitute } = useInstitute();
  const { toast } = useToast();

  // The selected student/institute scope the glyph palette (custom symbols +
  // known people) the AI may use, matching the board editor.
  const studentId = student?.id ?? null;
  const instituteId = currentInstitute?.id ?? null;

  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [videoName, setVideoName] = useState<string | null>(null);
  const [captionName, setCaptionName] = useState<string | null>(null);
  const [segments, setSegments] = useState<CaptionSegment[]>([]);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  // Glyph strings keyed by segment index, filled by the AI conversion step.
  const [glyphs, setGlyphs] = useState<Record<number, string>>({});
  // Immediate stand-in glyph per index for `generate:` sentences (shown until
  // the background-generated image is ready).
  const [fallbacks, setFallbacks] = useState<Record<number, string>>({});
  const [generating, setGenerating] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [extractingIdeas, setExtractingIdeas] = useState(false);
  // True once the first pass (idea extraction) has run on the current transcript.
  const [ideasReady, setIdeasReady] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState(0);
  // Segment index whose glyph image is being edited (replace via the shared
  // symbol dialog), or null when the dialog is closed.
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  // Spoken/caption language (defaults to the UI language; user-overridable).
  const [captionLanguage, setCaptionLanguage] = useState<string>(language);
  // SHA-256 of the current video — the saved-project key.
  const [projectHash, setProjectHash] = useState<string | null>(null);
  // Free-form caption requests (from the chat tool) threaded into both AI passes.
  const [captionInstructions, setCaptionInstructions] = useState<string>('');

  // Export needs WebCodecs (Chrome/Edge today). Detected once.
  const exportSupported = useMemo(() => isVideoExportSupported(), []);
  const glyphCount = Object.keys(glyphs).length;
  const captionRtl = RTL_LANGS.has(captionLanguage);

  const videoRef = useRef<HTMLVideoElement>(null);
  const videoInputRef = useRef<HTMLInputElement>(null);
  const captionInputRef = useRef<HTMLInputElement>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Refs (not state) for values the request closures need without a flush delay
  // — the chat auto-run chain runs faster than React state settles.
  const projectHashRef = useRef<string | null>(null);
  const captionSessionRef = useRef<string | null>(null);

  // Object URLs must be revoked when replaced or on unmount to avoid leaks.
  useEffect(() => {
    return () => {
      if (videoUrl) URL.revokeObjectURL(videoUrl);
    };
  }, [videoUrl]);

  // Populate the face cache for the selected student's people-directory so
  // `face:<id>` glyphs render their photo in the segment list, the overlay, and
  // the export — the same people the palette prompt knows about.
  useEffect(() => {
    if (!studentId) return;
    let cancelled = false;
    fetch(apiUrl(`/api/aac/students/${studentId}/people-directory`), { credentials: 'include' })
      .then((r) => r.json())
      .then((d) => {
        if (cancelled || !Array.isArray(d?.people)) return;
        for (const p of d.people) {
          if (p?.id && p?.hasPhoto) {
            registerStudentFace(p.id, apiUrl(`/api/aac/students/${studentId}/people/${p.id}/photo`));
          }
        }
      })
      .catch(() => {/* faces just won't render; non-fatal */});
    return () => {
      cancelled = true;
    };
  }, [studentId]);

  // Background image generation: for any `generate:<key>` in the current glyphs,
  // watch the symbol-resolution SSE and bridge resolved entries into the glyph
  // cache (registerSymbolPath) so each fallback swaps to its generated image.
  useEffect(() => {
    const keys = new Set<string>();
    for (const g of Object.values(glyphs)) {
      const re = /generate:([A-Za-z0-9_]+)/gi;
      let m: RegExpExecArray | null;
      while ((m = re.exec(g)) !== null) keys.add(m[1].toLowerCase());
    }
    if (keys.size === 0) return;
    const keyList = Array.from(keys);
    const bridge = (state: { symbols: Record<string, { status: string; symbolPath?: string }> }) => {
      for (const k of keyList) {
        const e = state.symbols[k];
        if (e?.status === 'resolved' && e.symbolPath) registerSymbolPath(k, e.symbolPath);
      }
    };
    useSymbolStore.getState().requestResolution(keyList);
    bridge(useSymbolStore.getState());
    return useSymbolStore.subscribe(bridge);
  }, [glyphs]);

  // Load a video File: set up preview, reset state, and load any saved project
  // (keyed by content hash). Returns whether a saved project with glyphs was
  // found (so an auto-run can skip re-processing). Shared by the file picker and
  // the chat-triggered hand-off.
  const loadVideoFile = useCallback(
    async (file: File): Promise<{ hadProject: boolean }> => {
      setVideoFile(file);
      setVideoUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return URL.createObjectURL(file);
      });
      setVideoName(file.name);
      // Reset working state until we know whether a saved project exists.
      setSegments([]);
      setGlyphs({});
      setFallbacks({});
      setIdeasReady(false);
      setCaptionInstructions('');
      setCaptionName(null);
      setActiveIndex(null);
      setProjectHash(null);
      projectHashRef.current = null;
      captionSessionRef.current = null;

      try {
        const hash = await sha256Hex(file);
        setProjectHash(hash);
        projectHashRef.current = hash;
        const res = await fetch(apiUrl(`/api/caption-projects/${hash}`), { credentials: 'include' });
        const data = await res.json();
        const project = data?.project;
        if (project && Array.isArray(project.segments) && project.segments.length > 0) {
          const stored = project.segments as StoredSegment[];
          setSegments(stored.map((s) => ({ startMs: s.startMs, endMs: s.endMs, text: s.text })));
          const loadedGlyphs: Record<number, string> = {};
          stored.forEach((s, i) => {
            if (s.glyph) loadedGlyphs[i] = s.glyph;
          });
          setGlyphs(loadedGlyphs);
          const loadedFallbacks: Record<number, string> = {};
          stored.forEach((s, i) => {
            if (s.fallback) loadedFallbacks[i] = s.fallback;
          });
          setFallbacks(loadedFallbacks);
          const hadGlyphs = Object.keys(loadedGlyphs).length > 0;
          // A saved project with glyphs has already been through both passes.
          setIdeasReady(hadGlyphs);
          if (project.language) setCaptionLanguage(project.language);
          setCaptionName(t('videoCaption.projectLoaded'));
          toast({ title: t('videoCaption.projectLoaded') });
          return { hadProject: hadGlyphs };
        }
      } catch {
        // Hashing/lookup failure is non-fatal — fall back to a fresh project.
      }
      return { hadProject: false };
    },
    [t, toast],
  );

  const handleVideoSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) void loadVideoFile(file);
    },
    [loadVideoFile],
  );

  // Debounced auto-save: persist the project whenever its content changes (only
  // once there's something to save). Upsert is idempotent, so a redundant save
  // right after a load is harmless.
  useEffect(() => {
    if (!projectHash || segments.length === 0) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      const stored: StoredSegment[] = segments.map((s, i) => ({
        startMs: s.startMs,
        endMs: s.endMs,
        text: s.text,
        ...(glyphs[i] ? { glyph: glyphs[i] } : {}),
        ...(fallbacks[i] ? { fallback: fallbacks[i] } : {}),
      }));
      void fetch(apiUrl(`/api/caption-projects/${projectHash}`), {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ videoName, language: captionLanguage, segments: stored }),
      }).catch(() => {/* best-effort; surfaced on next change */});
    }, 800);
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, [projectHash, segments, glyphs, fallbacks, captionLanguage, videoName]);

  const handleCaptionSelect = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      try {
        const parsed = await parseCaptionFile(file);
        setSegments(parsed);
        setGlyphs({});
        setFallbacks({});
        setIdeasReady(false);
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

  // Cheap pre-flight: detect the spoken language from a short audio sample so
  // the user can verify/correct it before running the full pipeline.
  const detectLanguageFromVideo = useCallback(async () => {
    if (!videoFile || detecting) return;
    setDetecting(true);
    try {
      const { blob } = await extractWavMono16k(videoFile, { clipSeconds: 30 });
      const form = new FormData();
      form.append('audio', blob, 'sample.wav');
      // Seed STT with the inferred guess first, then common alternatives (cap 4).
      const candidates = Array.from(new Set([captionLanguage, language, 'en', 'he', 'es', 'ar'])).slice(0, 4);
      form.append('candidates', candidates.join(','));
      form.append('sampleRate', String(STT_SAMPLE_RATE));
      if (projectHashRef.current) form.append('videoHash', projectHashRef.current);
      if (studentId) form.append('studentId', studentId);
      if (instituteId) form.append('instituteId', instituteId);
      const res = await fetch(apiUrl('/api/video-caption/detect-language'), {
        method: 'POST',
        credentials: 'include',
        body: form,
      });
      const data = await res.json();
      if (data?.success && data.language) {
        setCaptionLanguage(data.language);
        const label = LANGUAGE_OPTIONS.find((o) => o.code === data.language)?.label ?? data.language;
        toast({
          title: t('videoCaption.languageDetected').replace('{lang}', label),
          description: data.sampleText || undefined,
        });
      } else {
        toast({ title: t('videoCaption.detectFailed'), variant: 'destructive' });
      }
    } catch (err) {
      const description = err instanceof AudioExtractError ? err.message : undefined;
      toast({ title: t('videoCaption.detectFailed'), description, variant: 'destructive' });
    } finally {
      setDetecting(false);
    }
  }, [videoFile, detecting, captionLanguage, language, studentId, instituteId, t, toast]);

  // No caption file? Transcribe the video's own audio (Google Cloud STT).
  // Accepts an explicit file (for the auto-run chain, before videoFile state has
  // flushed) and returns the transcript segments (or null on failure/empty).
  const transcribeFromVideo = useCallback(
    async (fileArg?: File): Promise<CaptionSegment[] | null> => {
      const file = fileArg ?? videoFile;
      if (!file || transcribing) return null;
      setTranscribing(true);
      try {
        const { blob } = await extractWavMono16k(file);
        const form = new FormData();
        form.append('audio', blob, 'audio.wav');
        form.append('language', captionLanguage);
        form.append('sampleRate', String(STT_SAMPLE_RATE));
        if (projectHashRef.current) form.append('videoHash', projectHashRef.current);
        if (studentId) form.append('studentId', studentId);
        if (instituteId) form.append('instituteId', instituteId);
        if (captionSessionRef.current) form.append('sessionId', captionSessionRef.current);
        const res = await fetch(apiUrl('/api/video-caption/transcribe'), {
          method: 'POST',
          credentials: 'include',
          body: form,
        });
        const data = await res.json();
        if (!data?.success || !Array.isArray(data.segments)) {
          throw new Error('bad response');
        }
        if (data.segments.length === 0) {
          toast({ title: t('videoCaption.transcribeEmpty'), variant: 'destructive' });
          return null;
        }
        const segs: CaptionSegment[] = data.segments.map(
          (s: { startMs: number; endMs: number; text: string; words?: CaptionSegment['words'] }) => ({
            startMs: s.startMs,
            endMs: s.endMs,
            text: s.text,
            // Carry per-word timings (STT path) so the idea pass can split on
            // real word boundaries.
            ...(Array.isArray(s.words) && s.words.length ? { words: s.words } : {}),
          }),
        );
        setSegments(segs);
        setGlyphs({});
        setFallbacks({});
        setIdeasReady(false);
        setCaptionName(t('videoCaption.transcribedLabel'));
        setActiveIndex(null);
        return segs;
      } catch (err) {
        const description = err instanceof AudioExtractError ? err.message : undefined;
        toast({ title: t('videoCaption.transcribeFailed'), description, variant: 'destructive' });
        return null;
      } finally {
        setTranscribing(false);
      }
    },
    [videoFile, transcribing, captionLanguage, studentId, instituteId, t, toast],
  );

  // Second pass: convert idea segments to glyph SENTENCEs (text→glyph). Operates
  // on the passed segments so it can run right after the first pass replaces
  // them (before React state has flushed).
  const runGlyphPass = useCallback(
    async (segs: CaptionSegment[], instructionsArg?: string): Promise<boolean> => {
      setGenerating(true);
      try {
        const res = await apiRequest('POST', '/api/video-caption/glyphs', {
          segments: segs.map((s) => ({ startMs: s.startMs, endMs: s.endMs, text: s.text })),
          language: captionLanguage,
          customInstructions: (instructionsArg ?? captionInstructions) || undefined,
          studentId,
          instituteId,
          videoHash: projectHashRef.current ?? undefined,
          sessionId: captionSessionRef.current ?? undefined,
        });
        const data = await res.json();
        if (!data?.success || !Array.isArray(data.segments)) throw new Error('bad response');
        const next: Record<number, string> = {};
        const nextFallbacks: Record<number, string> = {};
        data.segments.forEach((s: { glyph?: string; fallback?: string }, i: number) => {
          if (s.glyph) next[i] = s.glyph;
          if (s.fallback) nextFallbacks[i] = s.fallback;
        });
        setGlyphs(next);
        setFallbacks(nextFallbacks);
        return true;
      } catch {
        toast({ title: t('videoCaption.glyphsFailed'), variant: 'destructive' });
        return false;
      } finally {
        setGenerating(false);
      }
    },
    [captionLanguage, captionInstructions, studentId, instituteId, t, toast],
  );

  // Full two-pass run: (1) re-segment the transcript into timed IDEA units, then
  // (2) convert each idea to a glyph. The timeline reflects each pass.
  const generateCaptions = useCallback(
    async (opts?: { segments?: CaptionSegment[]; instructions?: string }) => {
      const baseSegments = opts?.segments ?? segments;
      const instructions = opts?.instructions ?? captionInstructions;
      if (baseSegments.length === 0 || extractingIdeas || generating) return;

      // Pass 1 — ideas. Skip re-extraction only for a manual re-run of an
      // already-idea'd transcript; an explicit `opts.segments` is always fresh.
      let ideaSegs: CaptionSegment[] = baseSegments;
      const skipIdeas = !opts?.segments && ideasReady;
      if (!skipIdeas) {
        setExtractingIdeas(true);
        try {
          const res = await apiRequest('POST', '/api/video-caption/ideas', {
            // Forward per-word timings when present (STT path) so the idea pass
            // can split on real word boundaries instead of estimating.
            segments: baseSegments.map((s) => ({
              startMs: s.startMs,
              endMs: s.endMs,
              text: s.text,
              ...(s.words?.length ? { words: s.words } : {}),
            })),
            language: captionLanguage,
            customInstructions: instructions || undefined,
            studentId,
            instituteId,
            videoHash: projectHashRef.current ?? undefined,
            sessionId: captionSessionRef.current ?? undefined,
          });
          const data = await res.json();
          if (!data?.success || !Array.isArray(data.segments) || data.segments.length === 0) {
            throw new Error('bad response');
          }
          ideaSegs = data.segments.map((s: CaptionSegment) => ({
            startMs: s.startMs,
            endMs: s.endMs,
            text: s.text,
          }));
          setSegments(ideaSegs);
          setGlyphs({});
          setFallbacks({});
          setActiveIndex(null);
          setIdeasReady(true);
        } catch {
          toast({ title: t('videoCaption.ideasFailed'), variant: 'destructive' });
          setExtractingIdeas(false);
          return;
        }
        setExtractingIdeas(false);
      }

      // Pass 2 — glyphs.
      await runGlyphPass(ideaSegs, instructions);
    },
    [segments, extractingIdeas, generating, ideasReady, captionLanguage, captionInstructions, studentId, instituteId, runGlyphPass, t, toast],
  );

  // Chat hand-off: the captionVideo tool opens this panel with the uploaded
  // video + custom instructions. Load it and auto-run the pipeline.
  const onChatHandoff = useCallback(
    (data?: { customInstructions?: string; file?: File; sessionId?: string }) => {
      const file = data?.file;
      if (!file) {
        toast({ title: t('videoCaption.noVideo'), variant: 'destructive' });
        return;
      }
      void (async () => {
        const instructions = data?.customInstructions || '';
        const { hadProject } = await loadVideoFile(file);
        // loadVideoFile cleared the session ref; set the chat session (if any).
        captionSessionRef.current = data?.sessionId ?? null;
        setCaptionInstructions(instructions);
        if (hadProject) return; // already captioned — just show it
        const segs = await transcribeFromVideo(file);
        if (segs && segs.length > 0) {
          await generateCaptions({ segments: segs, instructions });
        }
      })();
    },
    [loadVideoFile, transcribeFromVideo, generateCaptions, t, toast],
  );
  useUIEvent('videoCaption', onChatHandoff);

  // Burn the glyph overlays into a downloadable MP4 (client-side, WebCodecs).
  const exportVideo = useCallback(async () => {
    if (!videoFile || exporting) return;
    // Use the real glyph when its symbols are resolvable; otherwise fall back
    // to the stand-in so a still-generating `generate:` key never bakes a ❓.
    const cues: GlyphCue[] = segments
      .map((s, i) => {
        const glyph = glyphs[i] ?? '';
        if (!glyph) return null;
        const effective = canResolveGlyph(glyph, hasResolvedSymbol) ? glyph : fallbacks[i] || glyph;
        return { startMs: s.startMs, endMs: s.endMs, glyph: effective };
      })
      .filter((c): c is GlyphCue => c !== null);
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
        rtl: captionRtl,
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
        console.error('[VideoCaption] export failed:', err);
        toast({
          title: t('videoCaption.exportFailed'),
          description: (err as Error)?.message,
          variant: 'destructive',
        });
      }
    } finally {
      setExporting(false);
    }
  }, [videoFile, exporting, segments, glyphs, fallbacks, captionRtl, videoName, t, toast]);

  // ----- Per-segment glyph editing via the board editor's "Edit Visual" popup -----
  // Reuses GlyphBuilder (the clinician board-editor glyph composer) so a caption
  // glyph is edited with the exact same UI. Seed it with the EFFECTIVE rendered
  // glyph (the fallback when a `generate:` image is still pending) so the user
  // starts from what's on screen. onChange fires live → update + clear fallback.
  const editSeed = (() => {
    if (editingIndex == null) return '';
    const g = glyphs[editingIndex] ?? '';
    if (!g) return '';
    return canResolveGlyph(g, hasResolvedSymbol) ? g : (fallbacks[editingIndex] || g);
  })();
  const handleGlyphEdit = useCallback(
    (g: string) => {
      if (editingIndex == null) return;
      const i = editingIndex;
      setGlyphs((prev) => ({ ...prev, [i]: g }));
      // The composed glyph is authoritative (immediate-render SYMBOLs, no
      // `generate:`), so any stale fallback for this index no longer applies.
      setFallbacks((prev) => {
        if (!(i in prev)) return prev;
        const next = { ...prev };
        delete next[i];
        return next;
      });
    },
    [editingIndex],
  );

  // Pipeline steps for the timeline — status derived from current state.
  const steps: TimelineStep[] = [
    { key: 'video', label: t('videoCaption.stepVideo'), status: videoFile ? 'done' : 'idle' },
    {
      key: 'transcript',
      label: t('videoCaption.stepTranscript'),
      status: transcribing ? 'active' : segments.length > 0 ? 'done' : 'idle',
    },
    {
      key: 'ideas',
      label: t('videoCaption.stepIdeas'),
      status: extractingIdeas ? 'active' : ideasReady ? 'done' : 'idle',
    },
    {
      key: 'glyphs',
      label: t('videoCaption.stepGlyphs'),
      status: generating ? 'active' : glyphCount > 0 ? 'done' : 'idle',
    },
  ];

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
        <Button
          variant="outline"
          onClick={() => transcribeFromVideo()}
          disabled={!videoFile || transcribing}
          data-testid="video-caption-transcribe"
        >
          {transcribing ? (
            <Loader2 className="w-4 h-4 me-2 animate-spin" />
          ) : (
            <Mic className="w-4 h-4 me-2" />
          )}
          {t('videoCaption.transcribe')}
        </Button>
        <div className="flex items-center gap-2 ms-auto" title={t('videoCaption.languageHint')}>
          <Button
            variant="ghost"
            size="sm"
            onClick={detectLanguageFromVideo}
            disabled={!videoFile || detecting}
            data-testid="video-caption-detect-language"
          >
            {detecting ? (
              <Loader2 className="w-4 h-4 me-1 animate-spin" />
            ) : (
              <Wand2 className="w-4 h-4 me-1" />
            )}
            {t('videoCaption.detect')}
          </Button>
          <Languages className="w-4 h-4 text-muted-foreground" />
          <Select value={captionLanguage} onValueChange={setCaptionLanguage}>
            <SelectTrigger className="w-[150px]" data-testid="video-caption-language">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LANGUAGE_OPTIONS.map((opt) => (
                <SelectItem key={opt.code} value={opt.code}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Pipeline progress */}
      <CaptionTimeline steps={steps} />

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
              >
                {/* Captions are rendered via GlyphCaptionOverlay, not a track */}
                <track kind="captions" />
              </video>
              <GlyphCaptionOverlay
                glyph={activeIndex != null ? glyphs[activeIndex] : undefined}
                fallback={activeIndex != null ? fallbacks[activeIndex] : undefined}
                rtl={captionRtl}
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
            onClick={() => generateCaptions()}
            disabled={segments.length === 0 || extractingIdeas || generating}
            data-testid="video-caption-generate"
          >
            {extractingIdeas || generating ? (
              <Loader2 className="w-4 h-4 me-2 animate-spin" />
            ) : (
              <Sparkles className="w-4 h-4 me-2" />
            )}
            {extractingIdeas
              ? t('videoCaption.stepIdeas')
              : generating
                ? t('videoCaption.generateGlyphs')
                : t('videoCaption.generateCaptions')}
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
              <li
                key={i}
                className={cn(
                  'flex items-center gap-3 px-3 py-2 hover:bg-accent transition-colors',
                  activeIndex === i && 'bg-accent',
                )}
              >
                <span className="text-xs font-mono text-muted-foreground shrink-0 tabular-nums">
                  {formatTimestamp(segment.startMs)}
                </span>
                {glyphs[i] && (
                  // Clicking the glyph image opens the editor to replace it.
                  // Separate <button> from the seek control (no nested buttons).
                  // Explicit box: the compositor fills its container (width 100%),
                  // so it needs a sized parent or it collapses. Width scales with
                  // the slot count (1–3 GLYPHs).
                  <button
                    type="button"
                    onClick={() => setEditingIndex(i)}
                    className="shrink-0 rounded hover:ring-2 hover:ring-primary/50 transition"
                    style={{
                      height: 44,
                      width: Math.min(3, Math.max(1, parseGlyph(glyphs[i]).slots.length)) * 44,
                    }}
                    title={t('videoCaption.editImage')}
                    aria-label={t('videoCaption.editImage')}
                    data-testid={`video-caption-edit-glyph-${i}`}
                  >
                    <Glyph glyph={glyphs[i]} fallback={fallbacks[i]} rtl={captionRtl} />
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => seekTo(segment)}
                  className="flex-1 min-w-0 text-start text-sm"
                  data-testid={`video-caption-segment-${i}`}
                >
                  {segment.text}
                </button>
              </li>
            ))}
          </ul>
        )}
      </ScrollArea>

      <GlyphBuilder
        value={editSeed}
        onChange={handleGlyphEdit}
        studentId={studentId ?? undefined}
        open={editingIndex != null}
        onOpenChange={(v) => { if (!v) setEditingIndex(null); }}
      />
    </div>
  );
}
