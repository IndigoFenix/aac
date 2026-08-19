// client-aac/src/components/apps/YouTubeApp.tsx
// Full-screen YouTube player with two modes:
//   1. Direct play — AI supplied a videoId (e.g. from open_app("youtube", data=...))
//   2. Browse mode — AI opened YouTube without a query; student picks a channel
//      and a video from its recent uploads (RSS-backed).
// When channels are available, the player view shows a "← channels" button
// so the student can return to browse mode and pick a different video.

import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { X, Play, Pause, RotateCcw, Rewind, FastForward, Video, ListVideo } from "lucide-react";
// Back / page-nav chevrons are LOGICAL (they follow the reading direction).
// The transport row keeps lucide's Rewind / FastForward / Play as-is: those
// map to tape motion, not to reading order, and stay LTR in RTL locales.
import { ChevronBack, ChevronForward } from "@/components/ui/directional-icons";
import { apiRequest } from "@/lib/queryClient";
import type { PermittedYoutubeChannel, PermittedYoutubeItem, PermittedYoutubeVideo } from "@shared/schema";
import { useLanguage } from "@/contexts/LanguageContext";
import YouTubePlayer, { type YouTubePlayerHandle } from "@/components/YouTubePlayer";

interface YouTubeAppProps {
  /** Initial video to play. When omitted, app opens in browse mode (requires `channels` or `videos`). */
  videoId?: string;
  title?: string;
  /** Permitted channels for browse mode. */
  channels?: PermittedYoutubeChannel[];
  /** Pinned videos (curated playlist) shown as direct-play tiles in browse mode. */
  videos?: PermittedYoutubeVideo[];
  /** Permitted playlists for browse mode (browsed like channels). */
  playlists?: PermittedYoutubeItem[];
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

export default function YouTubeApp({
  videoId,
  title,
  channels,
  videos,
  playlists,
  onClose,
  sendContextOnly,
}: YouTubeAppProps) {
  const [activeVideo, setActiveVideo] = useState<{ videoId: string; title: string } | null>(
    videoId ? { videoId, title: title || "Video" } : null,
  );
  const hasChannels = (channels?.length ?? 0) > 0;
  const hasVideos = (videos?.length ?? 0) > 0;
  const hasPlaylists = (playlists?.length ?? 0) > 0;
  // "Back to browse" is available whenever the student has curated content
  // they could pick from — channels, playlists, or pinned videos.
  const canReturnToBrowse = hasChannels || hasVideos || hasPlaylists;

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

  // No video and no curated content — render a minimal "unavailable" screen.
  if (!activeVideo && !canReturnToBrowse) {
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
      channels={channels || []}
      videos={videos || []}
      playlists={playlists || []}
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

/** A source the student drills into for a video list — a channel or a playlist. */
type BrowseSource = { kind: "channel" | "playlist"; id: string; label: string };

/** One stacked section in the browse view. `items`/renderers are heterogeneous by section. */
interface BrowseSection {
  key: string;
  title: string;
  items: any[];
  getKey: (item: any) => string;
  renderItem: (item: any) => React.ReactNode;
}

function BrowseView({
  channels,
  videos,
  playlists,
  onPickVideo,
  onClose,
}: {
  channels: PermittedYoutubeChannel[];
  videos: PermittedYoutubeVideo[];
  playlists: PermittedYoutubeItem[];
  onPickVideo: (v: { videoId: string; title: string }, sourceLabel?: string) => void;
  onClose: () => void;
}) {
  const { t } = useLanguage();

  // Channels + playlists are both "sources" the student drills into.
  const sources: BrowseSource[] = useMemo(
    () => [
      ...channels.map((c) => ({ kind: "channel" as const, id: c.channelId, label: c.label })),
      ...playlists.map((p) => ({ kind: "playlist" as const, id: p.id, label: p.label })),
    ],
    [channels, playlists],
  );

  // Auto-jump straight to the only source iff there are no pinned videos to
  // pick from. With pinned videos present, always show the browse view so the
  // student sees every option.
  const [selectedSource, setSelectedSource] = useState<BrowseSource | null>(
    sources.length === 1 && videos.length === 0 ? sources[0] : null,
  );

  if (selectedSource) {
    return (
      <SourceVideosView
        source={selectedSource}
        onBack={() => setSelectedSource(null)}
        onClose={onClose}
        onPickVideo={(v) => onPickVideo(v, selectedSource.label)}
      />
    );
  }

  const renderVideoTile = (v: PermittedYoutubeVideo) => (
    <button type="button"
      data-dwell
      key={v.videoId}
      onClick={() => onPickVideo({ videoId: v.videoId, title: v.label })}
      className="flex flex-col gap-0 rounded-2xl overflow-hidden bg-gray-800 hover:bg-gray-700 active:scale-95 transition-all text-left w-full h-full min-h-0"
    >
      <div className="relative w-full flex-1 min-h-0 bg-black">
        <img
          src={`https://img.youtube.com/vi/${encodeURIComponent(v.videoId)}/hqdefault.jpg`}
          alt=""
          className="absolute inset-0 w-full h-full object-cover"
          loading="lazy"
        />
        <div className="absolute inset-0 flex items-center justify-center bg-black/0 hover:bg-black/30 transition-colors">
          <Play size={48} className="text-white drop-shadow-lg" />
        </div>
      </div>
      <div className="px-3 py-2 shrink-0">
        <span className="text-white text-sm font-medium line-clamp-2">{v.label}</span>
      </div>
    </button>
  );

  const renderChannelTile = (ch: PermittedYoutubeChannel) => (
    <button type="button"
      data-dwell
      key={ch.channelId}
      onClick={() => setSelectedSource({ kind: "channel", id: ch.channelId, label: ch.label })}
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
  );

  const renderPlaylistTile = (pl: PermittedYoutubeItem) => (
    <button type="button"
      data-dwell
      key={pl.id}
      onClick={() => setSelectedSource({ kind: "playlist", id: pl.id, label: pl.label })}
      className="flex flex-col items-center justify-center gap-2 p-4 rounded-2xl bg-gray-800 hover:bg-gray-700 active:scale-95 transition-all text-center w-full h-full min-h-0 overflow-hidden"
    >
      <ListVideo size={48} className="text-amber-400 shrink-0" />
      <span className="text-white text-base font-semibold line-clamp-2 w-full">
        {pl.label}
      </span>
      {pl.description && (
        <span className="text-gray-400 text-xs line-clamp-2 w-full">
          {pl.description}
        </span>
      )}
    </button>
  );

  // Visible sections, in order: pinned videos, channels, playlists. Empty kinds
  // are omitted.
  const sections: BrowseSection[] = [];
  if (videos.length > 0) {
    sections.push({ key: "videos", title: t("youtubeApp.pinnedVideos"), items: videos, getKey: (v) => v.videoId, renderItem: renderVideoTile });
  }
  if (channels.length > 0) {
    sections.push({ key: "channels", title: t("youtubeApp.channelsHeading"), items: channels, getKey: (c) => c.channelId, renderItem: renderChannelTile });
  }
  if (playlists.length > 0) {
    sections.push({ key: "playlists", title: t("youtubeApp.playlistsHeading"), items: playlists, getKey: (p) => p.id, renderItem: renderPlaylistTile });
  }

  // A single kind → keep the full-screen PaginatedGrid (existing behavior).
  if (sections.length === 1) {
    const only = sections[0];
    const title = only.key === "channels" ? t("youtubeApp.chooseChannel") : only.title;
    return (
      <PaginatedGrid
        title={title}
        items={only.items}
        getKey={only.getKey}
        renderItem={only.renderItem}
        onClose={onClose}
      />
    );
  }

  // Multiple kinds → stacked, each gets an equal share of vertical space.
  return <SectionedBrowseView sections={sections} onClose={onClose} />;
}

// ---------------------------------------------------------------------------
// SectionedBrowseView — stacked paginated grids, one per content kind
// ---------------------------------------------------------------------------

function SectionedBrowseView({
  sections,
  onClose,
}: {
  sections: BrowseSection[];
  onClose: () => void;
}) {
  const { t } = useLanguage();
  return (
    <div className="h-full w-full bg-gray-900 flex flex-col">
      {/* Single top header with close button */}
      <div className="flex items-center gap-2 px-4 py-3 bg-black/70 border-b border-gray-800 shrink-0">
        <h2 className="text-white text-lg font-semibold truncate flex-1">
          {t("youtubeApp.browseTitle")}
        </h2>
        <button type="button"
          data-dwell
          onClick={onClose}
          className="w-12 h-12 rounded-xl bg-red-600 text-white flex items-center justify-center active:scale-95 transition-transform"
          aria-label={t("youtubeApp.close")}
        >
          <X size={24} />
        </button>
      </div>

      {/* Stacked sections, each gets an equal share of the available height. */}
      <div className="flex-1 min-h-0 flex flex-col">
        {sections.map((s) => (
          <SectionGrid
            key={s.key}
            title={s.title}
            items={s.items}
            getKey={s.getKey}
            renderItem={s.renderItem}
          />
        ))}
      </div>
    </div>
  );
}

// One section inside SectionedBrowseView — 1 row × 3 cols paginated grid with
// its own header label and (when needed) its own pager.
const SECTION_COLS = 3;
const SECTION_ROWS = 1;
const SECTION_PAGE_SIZE = SECTION_COLS * SECTION_ROWS;

function SectionGrid<T>({
  title,
  items,
  getKey,
  renderItem,
}: {
  title: string;
  items: T[];
  getKey: (item: T) => string;
  renderItem: (item: T) => React.ReactNode;
}) {
  const { t } = useLanguage();
  const [page, setPage] = useState(0);
  const totalPages = Math.max(1, Math.ceil(items.length / SECTION_PAGE_SIZE));
  useEffect(() => {
    if (page >= totalPages) setPage(totalPages - 1);
  }, [page, totalPages]);

  const pageItems = useMemo(
    () => items.slice(page * SECTION_PAGE_SIZE, page * SECTION_PAGE_SIZE + SECTION_PAGE_SIZE),
    [items, page],
  );
  const canPrev = page > 0;
  const canNext = page < totalPages - 1;

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="flex items-center gap-2 px-4 pt-2 pb-1 shrink-0">
        <h3 className="text-white/80 text-sm font-semibold uppercase tracking-wide flex-1">
          {title}
        </h3>
        {totalPages > 1 && (
          <span className="text-white/50 text-xs tabular-nums">
            {page + 1} / {totalPages}
          </span>
        )}
        {totalPages > 1 && (
          <>
            <button type="button"
              data-dwell
              onClick={() => canPrev && setPage(page - 1)}
              disabled={!canPrev}
              className="w-10 h-10 rounded-xl bg-blue-600 text-white flex items-center justify-center active:scale-95 transition-transform disabled:opacity-30 disabled:bg-gray-700"
              aria-label={t("youtubeApp.prevPage")}
            >
              <ChevronBack size={20} />
            </button>
            <button type="button"
              data-dwell
              onClick={() => canNext && setPage(page + 1)}
              disabled={!canNext}
              className="w-10 h-10 rounded-xl bg-blue-600 text-white flex items-center justify-center active:scale-95 transition-transform disabled:opacity-30 disabled:bg-gray-700"
              aria-label={t("youtubeApp.nextPage")}
            >
              <ChevronForward size={20} />
            </button>
          </>
        )}
      </div>
      <div
        className="flex-1 min-h-0 px-3 pb-3 grid gap-3"
        style={{
          gridTemplateColumns: `repeat(${SECTION_COLS}, minmax(0, 1fr))`,
          gridTemplateRows: `repeat(${SECTION_ROWS}, minmax(0, 1fr))`,
        }}
      >
        {pageItems.map((item) => (
          <div key={getKey(item)} className="min-h-0 min-w-0">
            {renderItem(item)}
          </div>
        ))}
        {Array.from({ length: SECTION_PAGE_SIZE - pageItems.length }).map((_, i) => (
          <div key={`empty-${i}`} className="min-h-0 min-w-0" />
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Single-channel video list — fetched on demand from RSS endpoint
// ---------------------------------------------------------------------------

function SourceVideosView({
  source,
  onBack,
  onClose,
  onPickVideo,
}: {
  source: BrowseSource;
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
        const endpoint =
          source.kind === "playlist"
            ? `/api/aac/youtube/playlist-videos?playlistId=${encodeURIComponent(source.id)}`
            : `/api/aac/youtube/channel-videos?channelId=${encodeURIComponent(source.id)}`;
        const res = await apiRequest("GET", endpoint);
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
  }, [source.kind, source.id, t]);

  if (videos === null && !error) {
    return (
      <StatusView
        title={source.label}
        message={t("youtubeApp.loading")}
        onBack={onBack}
        onClose={onClose}
      />
    );
  }
  if (error) {
    return (
      <StatusView
        title={source.label}
        message={error}
        onBack={onBack}
        onClose={onClose}
      />
    );
  }

  return (
    <PaginatedGrid
      title={source.label}
      items={videos || []}
      getKey={(v) => v.videoId}
      renderItem={(v) => (
        <button type="button"
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
          <button type="button"
            data-dwell
            onClick={onBack}
            className="w-12 h-12 rounded-xl bg-gray-800 text-white flex items-center justify-center active:scale-95 transition-transform"
            aria-label={t("youtubeApp.backToChannels")}
          >
            <ChevronBack size={28} />
          </button>
        )}
        <h2 className="text-white text-lg font-semibold truncate flex-1">{title}</h2>
        {totalPages > 1 && (
          <span className="text-white/60 text-sm tabular-nums whitespace-nowrap">
            {page + 1} / {totalPages}
          </span>
        )}
        <button type="button"
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
          <button type="button"
            data-dwell
            onClick={() => canPrev && setPage(page - 1)}
            disabled={!canPrev}
            className="w-20 h-16 rounded-2xl bg-blue-600 text-white flex items-center justify-center active:scale-95 transition-transform disabled:opacity-30 disabled:bg-gray-700"
            aria-label={t("youtubeApp.prevPage")}
          >
            <ChevronBack size={36} />
          </button>
          <button type="button"
            data-dwell
            onClick={() => canNext && setPage(page + 1)}
            disabled={!canNext}
            className="w-20 h-16 rounded-2xl bg-blue-600 text-white flex items-center justify-center active:scale-95 transition-transform disabled:opacity-30 disabled:bg-gray-700"
            aria-label={t("youtubeApp.nextPage")}
          >
            <ChevronForward size={36} />
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
          <button type="button"
            data-dwell
            onClick={onBack}
            className="w-12 h-12 rounded-xl bg-gray-800 text-white flex items-center justify-center active:scale-95 transition-transform"
            aria-label={t("youtubeApp.backToChannels")}
          >
            <ChevronBack size={28} />
          </button>
        )}
        <h2 className="text-white text-lg font-semibold truncate flex-1">{title}</h2>
        <button type="button"
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
  const playerRef = useRef<YouTubePlayerHandle>(null);
  const [isPlaying, setIsPlaying] = useState(true);
  const [isReady, setIsReady] = useState(false);
  const [hasError, setHasError] = useState(false);

  const togglePlay = useCallback(() => playerRef.current?.toggle(), []);
  const seekRelative = useCallback((delta: number) => playerRef.current?.seekRelative(delta), []);
  const restart = useCallback(() => playerRef.current?.restart(), []);

  const btnBase =
    "flex items-center justify-center rounded-2xl text-white font-bold shadow-lg active:scale-95 transition-transform select-none";

  return (
    <div className="h-full bg-black flex flex-col">
      <div className="relative z-10 flex items-center gap-3 px-4 py-3 bg-gradient-to-b from-black/80 to-transparent">
        {onBackToBrowse && (
          <button type="button"
            data-dwell
            onClick={onBackToBrowse}
            className="w-12 h-12 rounded-xl bg-gray-800 flex items-center justify-center active:scale-95 transition-transform shrink-0"
            aria-label={t("youtubeApp.backToChannels")}
          >
            <ChevronBack size={26} className="text-white" />
          </button>
        )}
        <span className="text-white text-lg font-semibold truncate flex-1">{title}</span>
      </div>

      <div className="flex-1 relative">
        <YouTubePlayer
          ref={playerRef}
          videoId={videoId}
          onReady={() => setIsReady(true)}
          onPlayingChange={setIsPlaying}
          onError={() => setHasError(true)}
          className="absolute inset-0"
        />
        {!isReady && !hasError && (
          <div className="absolute inset-0 flex items-center justify-center text-white text-xl pointer-events-none">
            {t("youtubeApp.loading")}
          </div>
        )}
        {hasError && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-black">
            <p className="text-white text-xl">{t("youtubeApp.unavailable")}</p>
            <button type="button" data-dwell onClick={onClose} className={`${btnBase} w-20 h-20 bg-red-600 hover:bg-red-700`} aria-label={t("youtubeApp.close")}>
              <X size={36} />
            </button>
          </div>
        )}
      </div>

      {!hasError && (
        <div className="relative z-10 flex items-center justify-center gap-4 px-4 py-5 bg-gradient-to-t from-black/80 to-transparent">
          <button type="button" data-dwell onClick={onClose} className={`${btnBase} w-20 h-20 bg-red-600 hover:bg-red-700`} aria-label={t("youtubeApp.close")}>
            <X size={36} />
          </button>
          <button type="button" data-dwell onClick={() => seekRelative(-10)} className={`${btnBase} w-20 h-20 bg-blue-600 hover:bg-blue-700`} aria-label={t("youtubeApp.back10")}>
            <Rewind size={32} />
          </button>
          <button type="button" data-dwell onClick={togglePlay} className={`${btnBase} w-24 h-24 bg-green-600 hover:bg-green-700`} aria-label={isPlaying ? t("youtubeApp.pause") : t("youtubeApp.play")}>
            {isPlaying ? <Pause size={42} /> : <Play size={42} />}
          </button>
          <button type="button" data-dwell onClick={() => seekRelative(10)} className={`${btnBase} w-20 h-20 bg-blue-600 hover:bg-blue-700`} aria-label={t("youtubeApp.forward10")}>
            <FastForward size={32} />
          </button>
          <button type="button" data-dwell onClick={restart} className={`${btnBase} w-20 h-20 bg-purple-600 hover:bg-purple-700`} aria-label={t("youtubeApp.restart")}>
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
      <button type="button"
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
