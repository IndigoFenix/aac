// client-aac/src/components/apps/YouTubeApp.tsx
// Full-screen YouTube player with two modes:
//   1. Direct play — AI supplied a videoId (e.g. from open_app("youtube", data=...))
//   2. Browse mode — AI opened YouTube without a query; student picks a channel
//      and a video from its recent uploads (RSS-backed).
// When channels are available, the player view shows a "← channels" button
// so the student can return to browse mode and pick a different video.

import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { X, Play, Pause, RotateCcw, Rewind, FastForward, ChevronLeft, ChevronRight, Video } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import type { PermittedYoutubeChannel } from "@shared/schema";
import { useLanguage } from "@/contexts/LanguageContext";

interface YouTubeAppProps {
  /** Initial video to play. When omitted, app opens in browse mode (requires `channels`). */
  videoId?: string;
  title?: string;
  /** Permitted channels for browse mode. When empty and no videoId, the app shows an error. */
  channels?: PermittedYoutubeChannel[];
  onClose: () => void;
  /** Called with a short free-form string when the student picks/finishes a video manually. */
  sendContextOnly?: (text: string) => void;
}

interface RssVideo {
  videoId: string;
  title: string;
  thumbnailUrl: string;
  published: string;
}

// YouTube IFrame API types
declare global {
  interface Window {
    YT: any;
    onYouTubeIframeAPIReady: (() => void) | undefined;
  }
}

let ytApiLoaded = false;
let ytApiLoading = false;
const ytApiCallbacks: Array<() => void> = [];

function loadYTApi(): Promise<void> {
  if (ytApiLoaded) return Promise.resolve();
  return new Promise((resolve) => {
    ytApiCallbacks.push(resolve);
    if (ytApiLoading) return;
    ytApiLoading = true;

    const tag = document.createElement("script");
    tag.src = "https://www.youtube.com/iframe_api";
    document.head.appendChild(tag);

    window.onYouTubeIframeAPIReady = () => {
      ytApiLoaded = true;
      ytApiLoading = false;
      for (const cb of ytApiCallbacks) cb();
      ytApiCallbacks.length = 0;
    };
  });
}

export default function YouTubeApp({
  videoId,
  title,
  channels,
  onClose,
  sendContextOnly,
}: YouTubeAppProps) {
  const [activeVideo, setActiveVideo] = useState<{ videoId: string; title: string } | null>(
    videoId ? { videoId, title: title || "Video" } : null,
  );
  const hasChannels = (channels?.length ?? 0) > 0;
  // "Back to channels" is available whenever channels exist — so a student
  // given a specific video by the AI can still browse other approved options.
  const canReturnToBrowse = hasChannels;

  const pickVideo = useCallback(
    (v: { videoId: string; title: string }, channelLabel?: string) => {
      setActiveVideo(v);
      sendContextOnly?.(
        `[YOUTUBE] The student picked "${v.title}"${channelLabel ? ` from ${channelLabel}` : ""}.`,
      );
    },
    [sendContextOnly],
  );

  const returnToBrowse = useCallback(() => {
    setActiveVideo(null);
  }, []);

  // No video, no channels — render a minimal "unavailable" screen.
  if (!activeVideo && !hasChannels) {
    return <UnavailableView onClose={onClose} />;
  }

  if (activeVideo) {
    return (
      <PlayerView
        videoId={activeVideo.videoId}
        title={activeVideo.title}
        onClose={onClose}
        onBackToBrowse={canReturnToBrowse ? returnToBrowse : undefined}
      />
    );
  }

  return (
    <BrowseView
      channels={channels!}
      onPickVideo={pickVideo}
      onClose={onClose}
    />
  );
}

// ---------------------------------------------------------------------------
// Browse view — channel list + recent videos per channel
// ---------------------------------------------------------------------------

// Page size for the browse grid (2 rows × 3 cols). Kept as a tuple so the
// CSS grid and the slicing logic stay in sync.
const PAGE_ROWS = 2;
const PAGE_COLS = 3;
const PAGE_SIZE = PAGE_ROWS * PAGE_COLS;

function BrowseView({
  channels,
  onPickVideo,
  onClose,
}: {
  channels: PermittedYoutubeChannel[];
  onPickVideo: (v: { videoId: string; title: string }, channelLabel?: string) => void;
  onClose: () => void;
}) {
  const { t } = useLanguage();
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(
    channels.length === 1 ? channels[0].channelId : null,
  );
  const selectedChannel = useMemo(
    () => channels.find((c) => c.channelId === selectedChannelId) || null,
    [channels, selectedChannelId],
  );

  if (selectedChannel) {
    return (
      <ChannelVideosView
        channel={selectedChannel}
        onBack={channels.length > 1 ? () => setSelectedChannelId(null) : undefined}
        onClose={onClose}
        onPickVideo={(v) => onPickVideo(v, selectedChannel.label)}
      />
    );
  }

  return (
    <PaginatedGrid
      title={t("youtubeApp.chooseChannel")}
      items={channels}
      getKey={(ch) => ch.channelId}
      renderItem={(ch) => (
        <button
          data-dwell
          key={ch.channelId}
          onClick={() => setSelectedChannelId(ch.channelId)}
          className="flex flex-col items-center justify-center gap-2 p-4 rounded-2xl bg-gray-800 hover:bg-gray-700 active:scale-95 transition-all text-center w-full h-full min-h-0 overflow-hidden"
        >
          <Video size={48} className="text-red-500 shrink-0" />
          <span className="text-white text-base font-semibold line-clamp-2 w-full">
            {ch.label}
          </span>
          {ch.description && (
            <span className="text-gray-400 text-xs line-clamp-2 w-full">
              {ch.description}
            </span>
          )}
        </button>
      )}
      onClose={onClose}
    />
  );
}

// ---------------------------------------------------------------------------
// Single-channel video list — fetched on demand from RSS endpoint
// ---------------------------------------------------------------------------

function ChannelVideosView({
  channel,
  onBack,
  onClose,
  onPickVideo,
}: {
  channel: PermittedYoutubeChannel;
  onBack?: () => void;
  onClose: () => void;
  onPickVideo: (v: { videoId: string; title: string }) => void;
}) {
  const { t } = useLanguage();
  const [videos, setVideos] = useState<RssVideo[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setVideos(null);
    setError(null);
    (async () => {
      try {
        const res = await apiRequest(
          "GET",
          `/api/aac/youtube/channel-videos?channelId=${encodeURIComponent(channel.channelId)}`,
        );
        const data = await res.json();
        if (cancelled) return;
        const list: RssVideo[] = Array.isArray(data?.videos) ? data.videos : [];
        if (list.length === 0) {
          setError(t("youtubeApp.noVideos"));
        } else {
          setVideos(list);
        }
      } catch (err: any) {
        if (!cancelled) setError(err?.message || t("youtubeApp.loadError"));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [channel.channelId, t]);

  if (videos === null && !error) {
    return (
      <StatusView
        title={channel.label}
        message={t("youtubeApp.loading")}
        onBack={onBack}
        onClose={onClose}
      />
    );
  }
  if (error) {
    return (
      <StatusView
        title={channel.label}
        message={error}
        onBack={onBack}
        onClose={onClose}
      />
    );
  }

  return (
    <PaginatedGrid
      title={channel.label}
      items={videos || []}
      getKey={(v) => v.videoId}
      renderItem={(v) => (
        <button
          data-dwell
          key={v.videoId}
          onClick={() => onPickVideo({ videoId: v.videoId, title: v.title })}
          className="flex flex-col gap-0 rounded-2xl overflow-hidden bg-gray-800 hover:bg-gray-700 active:scale-95 transition-all text-left w-full h-full min-h-0"
        >
          <div className="relative w-full flex-1 min-h-0 bg-black">
            <img
              src={v.thumbnailUrl}
              alt=""
              className="absolute inset-0 w-full h-full object-cover"
              loading="lazy"
            />
            <div className="absolute inset-0 flex items-center justify-center bg-black/0 hover:bg-black/30 transition-colors">
              <Play size={48} className="text-white drop-shadow-lg" />
            </div>
          </div>
          <div className="px-3 py-2 shrink-0">
            <span className="text-white text-sm font-medium line-clamp-2">{v.title}</span>
          </div>
        </button>
      )}
      onBack={onBack}
      onClose={onClose}
    />
  );
}

// ---------------------------------------------------------------------------
// PaginatedGrid — shared fixed-grid pager for channel list / video list
// ---------------------------------------------------------------------------

function PaginatedGrid<T>({
  title,
  items,
  getKey,
  renderItem,
  onBack,
  onClose,
}: {
  title: string;
  items: T[];
  getKey: (item: T) => string;
  renderItem: (item: T) => React.ReactNode;
  /** Shown in the header when present — e.g. "← channels" in channel-videos view. */
  onBack?: () => void;
  onClose: () => void;
}) {
  const { t } = useLanguage();
  const [page, setPage] = useState(0);
  const totalPages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));

  // If the item list shrinks (e.g. re-fetch), clamp page.
  useEffect(() => {
    if (page >= totalPages) setPage(totalPages - 1);
  }, [page, totalPages]);

  const pageItems = useMemo(
    () => items.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE),
    [items, page],
  );

  const canPrev = page > 0;
  const canNext = page < totalPages - 1;

  return (
    <div className="h-full w-full bg-gray-900 flex flex-col">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-3 bg-black/70 border-b border-gray-800 shrink-0">
        {onBack && (
          <button
            data-dwell
            onClick={onBack}
            className="w-12 h-12 rounded-xl bg-gray-800 text-white flex items-center justify-center active:scale-95 transition-transform"
            aria-label={t("youtubeApp.backToChannels")}
          >
            <ChevronLeft size={28} />
          </button>
        )}
        <h2 className="text-white text-lg font-semibold truncate flex-1">{title}</h2>
        {totalPages > 1 && (
          <span className="text-white/60 text-sm tabular-nums whitespace-nowrap">
            {page + 1} / {totalPages}
          </span>
        )}
        <button
          data-dwell
          onClick={onClose}
          className="w-12 h-12 rounded-xl bg-red-600 text-white flex items-center justify-center active:scale-95 transition-transform"
          aria-label={t("youtubeApp.close")}
        >
          <X size={24} />
        </button>
      </div>

      {/* Fixed-grid content — fills remaining height, never scrolls. */}
      <div
        className="flex-1 min-h-0 p-3 grid gap-3"
        style={{
          gridTemplateColumns: `repeat(${PAGE_COLS}, minmax(0, 1fr))`,
          gridTemplateRows: `repeat(${PAGE_ROWS}, minmax(0, 1fr))`,
        }}
      >
        {pageItems.map((item) => (
          <div key={getKey(item)} className="min-h-0 min-w-0">
            {renderItem(item)}
          </div>
        ))}
        {/* Fill empty slots so the grid keeps its shape on the last page. */}
        {Array.from({ length: PAGE_SIZE - pageItems.length }).map((_, i) => (
          <div key={`empty-${i}`} className="min-h-0 min-w-0" />
        ))}
      </div>

      {/* Pager controls — hidden when only one page. */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-6 px-4 py-4 bg-black/70 border-t border-gray-800 shrink-0">
          <button
            data-dwell
            onClick={() => canPrev && setPage(page - 1)}
            disabled={!canPrev}
            className="w-20 h-16 rounded-2xl bg-blue-600 text-white flex items-center justify-center active:scale-95 transition-transform disabled:opacity-30 disabled:bg-gray-700"
            aria-label={t("youtubeApp.prevPage")}
          >
            <ChevronLeft size={36} />
          </button>
          <button
            data-dwell
            onClick={() => canNext && setPage(page + 1)}
            disabled={!canNext}
            className="w-20 h-16 rounded-2xl bg-blue-600 text-white flex items-center justify-center active:scale-95 transition-transform disabled:opacity-30 disabled:bg-gray-700"
            aria-label={t("youtubeApp.nextPage")}
          >
            <ChevronRight size={36} />
          </button>
        </div>
      )}
    </div>
  );
}

// Loading / error / empty splash that still shows header chrome.
function StatusView({
  title,
  message,
  onBack,
  onClose,
}: {
  title: string;
  message: string;
  onBack?: () => void;
  onClose: () => void;
}) {
  const { t } = useLanguage();
  return (
    <div className="h-full w-full bg-gray-900 flex flex-col">
      <div className="flex items-center gap-2 px-4 py-3 bg-black/70 border-b border-gray-800 shrink-0">
        {onBack && (
          <button
            data-dwell
            onClick={onBack}
            className="w-12 h-12 rounded-xl bg-gray-800 text-white flex items-center justify-center active:scale-95 transition-transform"
            aria-label={t("youtubeApp.backToChannels")}
          >
            <ChevronLeft size={28} />
          </button>
        )}
        <h2 className="text-white text-lg font-semibold truncate flex-1">{title}</h2>
        <button
          data-dwell
          onClick={onClose}
          className="w-12 h-12 rounded-xl bg-red-600 text-white flex items-center justify-center active:scale-95 transition-transform"
          aria-label={t("youtubeApp.close")}
        >
          <X size={24} />
        </button>
      </div>
      <div className="flex-1 flex items-center justify-center text-white/70 text-center px-6">
        {message}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Player view — embedded YT iframe with large accessible controls
// ---------------------------------------------------------------------------

function PlayerView({
  videoId,
  title,
  onClose,
  onBackToBrowse,
}: {
  videoId: string;
  title: string;
  onClose: () => void;
  onBackToBrowse?: () => void;
}) {
  const { t } = useLanguage();
  const containerRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<any>(null);
  const [isPlaying, setIsPlaying] = useState(true);
  const [isReady, setIsReady] = useState(false);
  const [hasError, setHasError] = useState(false);

  useEffect(() => {
    let destroyed = false;

    (async () => {
      await loadYTApi();
      if (destroyed) return;

      const playerId = `yt-player-${Date.now()}`;
      const div = document.createElement("div");
      div.id = playerId;
      containerRef.current?.querySelector(".yt-container")?.appendChild(div);

      playerRef.current = new window.YT.Player(playerId, {
        videoId,
        width: "100%",
        height: "100%",
        playerVars: {
          autoplay: 1,
          controls: 0,
          modestbranding: 1,
          rel: 0,
          playsinline: 1,
          fs: 0,
        },
        events: {
          onReady: () => {
            if (!destroyed) setIsReady(true);
          },
          onStateChange: (event: any) => {
            if (destroyed) return;
            if (event.data === 1) setIsPlaying(true);
            else if (event.data === 2) setIsPlaying(false);
            else if (event.data === 0) setIsPlaying(false);
          },
          onError: () => {
            if (!destroyed) setHasError(true);
          },
        },
      });
    })();

    return () => {
      destroyed = true;
      try {
        playerRef.current?.destroy();
      } catch {
        // ignore
      }
      playerRef.current = null;
    };
  }, [videoId]);

  const togglePlay = useCallback(() => {
    const p = playerRef.current;
    if (!p) return;
    try {
      const state = p.getPlayerState();
      if (state === 1) p.pauseVideo();
      else p.playVideo();
    } catch { /* ignore */ }
  }, []);

  const seekRelative = useCallback((delta: number) => {
    const p = playerRef.current;
    if (!p) return;
    try {
      const current = p.getCurrentTime() || 0;
      p.seekTo(Math.max(0, current + delta), true);
    } catch { /* ignore */ }
  }, []);

  const restart = useCallback(() => {
    const p = playerRef.current;
    if (!p) return;
    try {
      p.seekTo(0, true);
      p.playVideo();
    } catch { /* ignore */ }
  }, []);

  const btnBase =
    "flex items-center justify-center rounded-2xl text-white font-bold shadow-lg active:scale-95 transition-transform select-none";

  return (
    <div ref={containerRef} className="h-full bg-black flex flex-col">
      <div className="relative z-10 flex items-center gap-3 px-4 py-3 bg-gradient-to-b from-black/80 to-transparent">
        {onBackToBrowse && (
          <button
            data-dwell
            onClick={onBackToBrowse}
            className="w-12 h-12 rounded-xl bg-gray-800 flex items-center justify-center active:scale-95 transition-transform shrink-0"
            aria-label={t("youtubeApp.backToChannels")}
          >
            <ChevronLeft size={26} className="text-white" />
          </button>
        )}
        <span className="text-white text-lg font-semibold truncate flex-1">{title}</span>
      </div>

      <div className="flex-1 relative">
        <div className="yt-container absolute inset-0" />
        {!isReady && !hasError && (
          <div className="absolute inset-0 flex items-center justify-center text-white text-xl">
            {t("youtubeApp.loading")}
          </div>
        )}
        {hasError && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-4">
            <p className="text-white text-xl">{t("youtubeApp.unavailable")}</p>
            <button data-dwell onClick={onClose} className={`${btnBase} w-20 h-20 bg-red-600 hover:bg-red-700`}>
              <X size={36} />
            </button>
          </div>
        )}
      </div>

      {!hasError && (
        <div className="relative z-10 flex items-center justify-center gap-4 px-4 py-5 bg-gradient-to-t from-black/80 to-transparent">
          <button data-dwell onClick={onClose} className={`${btnBase} w-20 h-20 bg-red-600 hover:bg-red-700`} aria-label={t("youtubeApp.close")}>
            <X size={36} />
          </button>
          <button data-dwell onClick={() => seekRelative(-10)} className={`${btnBase} w-20 h-20 bg-blue-600 hover:bg-blue-700`} aria-label={t("youtubeApp.back10")}>
            <Rewind size={32} />
          </button>
          <button data-dwell onClick={togglePlay} className={`${btnBase} w-24 h-24 bg-green-600 hover:bg-green-700`} aria-label={isPlaying ? t("youtubeApp.pause") : t("youtubeApp.play")}>
            {isPlaying ? <Pause size={42} /> : <Play size={42} />}
          </button>
          <button data-dwell onClick={() => seekRelative(10)} className={`${btnBase} w-20 h-20 bg-blue-600 hover:bg-blue-700`} aria-label={t("youtubeApp.forward10")}>
            <FastForward size={32} />
          </button>
          <button data-dwell onClick={restart} className={`${btnBase} w-20 h-20 bg-purple-600 hover:bg-purple-700`} aria-label={t("youtubeApp.restart")}>
            <RotateCcw size={32} />
          </button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Unavailable view — shown when no videoId and no channels were provided
// ---------------------------------------------------------------------------

function UnavailableView({ onClose }: { onClose: () => void }) {
  const { t } = useLanguage();
  return (
    <div className="h-full w-full bg-black flex flex-col items-center justify-center gap-4 p-8 text-center">
      <Video size={64} className="text-gray-500" />
      <p className="text-white text-xl">{t("youtubeApp.unavailable")}</p>
      <button
        data-dwell
        onClick={onClose}
        className="w-20 h-20 bg-red-600 hover:bg-red-700 rounded-2xl text-white flex items-center justify-center active:scale-95 transition-transform"
        aria-label={t("youtubeApp.close")}
      >
        <X size={36} />
      </button>
    </div>
  );
}
