// shared/social-world/VideoTileLayout.tsx
//
// A reusable multi-participant video layout, SHARED by the clinician CallView
// and the AAC large-video window. It owns one <video> tile implementation
// (callback-ref attach + gain/mute volume sync — the pattern previously
// duplicated as PeerVideoTile / PeerTile) and arranges the tiles per the pure
// `video-layout` helpers:
//
//   - spotlight / auto: one prominent tile + a thumbnail strip of the rest
//   - grid:             an even gallery
//   - compact:          a thin strip (the board/app keeps the rest of the space)
//
// It is framework-agnostic about strings (optional `t`), like CallGameSurface.

import { useCallback, useEffect, useRef } from "react";
import { arrangeTiles, type VideoLayoutMode } from "../call/video-layout.js";

const DEFAULT_LABELS: Record<string, string> = {
  "call.noOneElse": "No one else is here yet",
  "call.screenLabel": "Screen",
};

export interface VideoTileData {
  personId: string;
  stream: MediaStream | null;
  name: string | null;
  /** Face-photo URL shown when there's no live video (camera off / not yet up). */
  photoUrl?: string | null;
  /** Output volume 0..1 (proximity gain). Defaults to 1. */
  gain?: number;
  /** Local output mute (silences what we hear from this tile). */
  muted?: boolean;
  /** Highlight ring — the current active speaker. */
  speaking?: boolean;
  /** Small corner badge, e.g. a screen-share marker. */
  badge?: string;
}

interface VideoTileProps extends VideoTileData {
  onClick?: () => void;
  /** Larger label text / rings for the prominent tile. */
  prominent?: boolean;
}

/** One participant's tile: live video when present, else a photo/initial disc. */
function VideoTile({ stream, name, photoUrl, gain = 1, muted, speaking, badge, onClick, prominent }: VideoTileProps) {
  const ref = useRef<HTMLVideoElement | null>(null);
  const attach = useCallback((el: HTMLVideoElement | null) => {
    ref.current = el;
    if (el) {
      if (el.srcObject !== stream) el.srcObject = stream;
      el.volume = gain;
      el.muted = !!muted;
    }
  }, [stream, gain, muted]);
  useEffect(() => { if (ref.current) ref.current.volume = gain; }, [gain]);
  useEffect(() => { if (ref.current) ref.current.muted = !!muted; }, [muted]);

  const initial = (name ?? "?").trim().charAt(0).toUpperCase() || "?";
  const hasVideo = !!stream && stream.getVideoTracks().some((t) => t.enabled && t.readyState === "live");

  const Wrapper: any = onClick ? "button" : "div";
  return (
    <Wrapper
      {...(onClick ? { type: "button", onClick } : {})}
      className={[
        "relative w-full h-full overflow-hidden rounded-xl bg-black/60",
        speaking ? "ring-4 ring-emerald-400" : "",
        onClick ? "cursor-pointer" : "",
      ].join(" ")}
    >
      {hasVideo ? (
        // eslint-disable-next-line jsx-a11y/media-has-caption -- live WebRTC peer feed
        <video ref={attach} autoPlay playsInline className="h-full w-full object-cover" />
      ) : photoUrl ? (
        <img src={photoUrl} alt={name ?? ""} className="h-full w-full object-cover" />
      ) : (
        <div className="flex h-full w-full items-center justify-center bg-emerald-700/80">
          <span className={prominent ? "text-6xl font-bold text-white" : "text-2xl font-bold text-white"}>{initial}</span>
        </div>
      )}
      {badge && (
        <div className="absolute top-1 start-1 rounded bg-sky-600/90 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white">
          {badge}
        </div>
      )}
      {name && (
        <div className="absolute inset-x-0 bottom-0 truncate bg-black/50 px-1 py-0.5 text-center text-xs text-white">
          {name}
        </div>
      )}
    </Wrapper>
  );
}

interface Props {
  tiles: VideoTileData[];
  mode: VideoLayoutMode;
  /** The prominent participant for spotlight/auto (caller resolves it via
   *  pickSpotlightId so auto can follow the active speaker). */
  spotlightId?: string | null;
  /** Click/tap a tile to pin it as the prominent one (spotlight). */
  onPin?: (personId: string) => void;
  /** Local self-view, rendered as a small picture-in-picture corner tile. */
  selfTile?: VideoTileData | null;
  className?: string;
  t?: (key: string) => string;
}

/** Lays out `tiles` for `mode`. Fills its container (give it a sized parent). */
export default function VideoTileLayout({ tiles, mode, spotlightId = null, onPin, selfTile, className, t }: Props) {
  const tr = useCallback((key: string) => t?.(key) ?? DEFAULT_LABELS[key] ?? key, [t]);
  const ids = tiles.map((x) => x.personId);
  const arranged = arrangeTiles(mode, ids, spotlightId);
  const byId = new Map(tiles.map((x) => [x.personId, x]));

  const selfPip = selfTile && (
    <div className="absolute bottom-3 end-3 z-10 w-28 sm:w-36 aspect-video">
      <VideoTile {...selfTile} muted />
    </div>
  );

  if (tiles.length === 0) {
    return (
      <div className={["relative flex h-full w-full items-center justify-center bg-black/30", className ?? ""].join(" ")}>
        <div className="px-4 text-center text-sm text-white/50">{tr("call.noOneElse")}</div>
        {selfPip}
      </div>
    );
  }

  if (mode === "compact") {
    // A single horizontal strip of small tiles; the host gives it a short height.
    return (
      <div className={["relative flex h-full w-full items-stretch gap-2 overflow-x-auto bg-black/30 p-2", className ?? ""].join(" ")}>
        {arranged.strip.map((id) => (
          <div key={id} className="aspect-video h-full shrink-0">
            <VideoTile {...(byId.get(id) as VideoTileData)} onClick={onPin ? () => onPin(id) : undefined} />
          </div>
        ))}
        {selfPip}
      </div>
    );
  }

  if (mode === "grid") {
    return (
      <div className={["relative h-full w-full bg-black/30 p-2", className ?? ""].join(" ")}>
        <div
          className="grid h-full w-full gap-2"
          style={{ gridTemplateColumns: `repeat(${arranged.gridColumns}, minmax(0, 1fr))` }}
        >
          {arranged.strip.map((id) => (
            <VideoTile key={id} {...(byId.get(id) as VideoTileData)} onClick={onPin ? () => onPin(id) : undefined} />
          ))}
        </div>
        {selfPip}
      </div>
    );
  }

  // spotlight / auto: one prominent tile + a thumbnail strip beneath it.
  const prominent = arranged.spotlightId ? byId.get(arranged.spotlightId) : undefined;
  return (
    <div className={["relative flex h-full w-full flex-col gap-2 bg-black/30 p-2", className ?? ""].join(" ")}>
      <div className="min-h-0 flex-1">
        {prominent && <VideoTile {...prominent} prominent onClick={onPin ? () => onPin(prominent.personId) : undefined} />}
      </div>
      {arranged.strip.length > 0 && (
        <div className="flex h-24 shrink-0 items-stretch gap-2 overflow-x-auto">
          {arranged.strip.map((id) => (
            <div key={id} className="aspect-video h-full shrink-0">
              <VideoTile {...(byId.get(id) as VideoTileData)} onClick={onPin ? () => onPin(id) : undefined} />
            </div>
          ))}
        </div>
      )}
      {selfPip}
    </div>
  );
}
