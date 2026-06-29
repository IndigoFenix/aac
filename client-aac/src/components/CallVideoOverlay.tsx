// client-aac/src/components/CallVideoOverlay.tsx
//
// AAC-side call-video helpers. Like SocialWorldOverlay, these live INSIDE
// CallProvider (so they can read useCall()) but are rendered by home, which owns
// the board state and the layout reflow:
//
//   - CallStateReporter:   lifts "is a call active / are there remote peers" up
//                          to home so it can decide whether to offer the big
//                          video window.
//   - CallBoardMirror:     streams the board the student is looking at to the
//                          clinician (board-mirror over the data channel).
//   - CallFacilitatorBridge: applies a clinician's facilitator press through the
//                          student's own press handler (consent-gated).
//   - CallVideoLarge:      portals the shared VideoTileLayout into a home-provided
//                          host (the "people I'm talking to" big window), with a
//                          dwell-friendly layout switcher.

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { BoardButton, ParsedBoardData } from "@shared/schema";
import VideoTileLayout, { type VideoTileData } from "@shared/social-world/VideoTileLayout";
import { pickSpotlightId, type VideoLayoutMode } from "@shared/call/video-layout";
import { useCall } from "@/contexts/CallContext";
import { useLanguage } from "@/contexts/LanguageContext";
import { useBoardMirror } from "@/hooks/useBoardMirror";

/** Lifts call activity to home (mirrors SocialGameReporter). */
export function CallStateReporter({ onChange }: { onChange: (s: { active: boolean; hasRemote: boolean }) => void }) {
  const { active, remoteStreams } = useCall();
  const hasRemote = remoteStreams.size > 0;
  useEffect(() => { onChange({ active, hasRemote }); }, [active, hasRemote, onChange]);
  return null;
}

/** Streams the student's current board to the clinician over the data channel. */
export function CallBoardMirror({ board, pageId, mode, appKind }: { board: ParsedBoardData | null; pageId?: string; mode?: "board" | "app"; appKind?: string }) {
  const { active, sendData } = useCall();
  useBoardMirror({ active, sendData, board, pageId, mode, appKind });
  return null;
}

/** Applies a clinician facilitator press through the student's own press handler.
 *  `enabled` is the per-student consent flag; when off, presses are ignored. */
export function CallFacilitatorBridge({ enabled, onPress }: { enabled: boolean; onPress: (button: BoardButton, spokenText: string) => void }) {
  const { facilitatorPress } = useCall();
  const lastAtRef = useRef(0);
  useEffect(() => {
    if (!facilitatorPress) return;
    if (facilitatorPress.at <= lastAtRef.current) return;
    lastAtRef.current = facilitatorPress.at;
    if (!enabled) {
      console.warn("[CallFacilitatorBridge] facilitator press ignored (consent off)");
      return;
    }
    onPress(facilitatorPress.button, facilitatorPress.spokenText || facilitatorPress.button.label);
  }, [facilitatorPress, enabled, onPress]);
  return null;
}

/** The "people I'm talking to" big window — portaled into a home-provided host
 *  in the board region. Offers spotlight / grid / auto and a shrink-to-board
 *  button (the "small video mode" toggle lives in home). */
export function CallVideoLarge({ host, onShrink }: { host: HTMLElement | null; onShrink: () => void }) {
  const { remoteStreams, contacts, peerGains, localStream, activeSpeakerId, selfPersonId } = useCall();
  const { t } = useLanguage();
  const [mode, setMode] = useState<VideoLayoutMode>("spotlight");
  const [pinned, setPinned] = useState<string | null>(null);

  const tiles: VideoTileData[] = useMemo(
    () => Array.from(remoteStreams.entries()).map(([personId, stream]) => ({
      personId,
      stream,
      name: contacts.find((c) => c.personId === personId)?.name ?? null,
      gain: peerGains.get(personId) ?? 1,
      speaking: personId === activeSpeakerId,
    })),
    [remoteStreams, contacts, peerGains, activeSpeakerId],
  );

  const spotlightId = useMemo(
    () => pickSpotlightId(tiles.map((x) => x.personId), { manualPin: pinned, activeSpeakerId }),
    [tiles, pinned, activeSpeakerId],
  );

  const selfTile: VideoTileData | null = localStream
    ? { personId: selfPersonId ?? "self", stream: localStream, name: null }
    : null;

  if (!host) return null;

  const modeButtons: Array<[VideoLayoutMode, string]> = [
    ["spotlight", t("call.layout.spotlight")],
    ["grid", t("call.layout.grid")],
    ["auto", t("call.layout.auto")],
  ];

  return createPortal(
    <div className="relative flex h-full w-full flex-col">
      {/* Dwell-friendly switcher row. */}
      <div className="flex items-center gap-2 p-1">
        {modeButtons.map(([m, label]) => (
          <button
            key={m}
            type="button"
            data-dwell={`video-layout-${m}`}
            onClick={() => setMode(m)}
            aria-pressed={mode === m}
            className={`rounded-lg px-3 py-1.5 text-sm font-medium ${mode === m ? "bg-emerald-500 text-white" : "bg-white/15 text-white hover:bg-white/25"}`}
          >
            {label}
          </button>
        ))}
        <button
          type="button"
          data-dwell="video-shrink"
          onClick={onShrink}
          className="ms-auto rounded-lg bg-white/15 px-3 py-1.5 text-sm font-medium text-white hover:bg-white/25"
        >
          {t("call.smallVideo")}
        </button>
      </div>
      <div className="min-h-0 flex-1">
        <VideoTileLayout
          tiles={tiles}
          mode={mode}
          spotlightId={spotlightId}
          onPin={(id) => setPinned((cur) => (cur === id ? null : id))}
          selfTile={selfTile}
          t={t}
        />
      </div>
    </div>,
    host,
  );
}
