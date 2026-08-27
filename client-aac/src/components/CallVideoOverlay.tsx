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
import type {
  MirrorHudSections,
  MirrorQuickButton,
  MirrorStripItem,
  MirrorSurface,
} from "@shared/call/call-data-messages";
import type { BuilderTarget } from "@shared/call/builder-mirror";
import VideoTileLayout, { type VideoTileData } from "@shared/social-world/VideoTileLayout";
import { pickSpotlightId, type VideoLayoutMode } from "@shared/call/video-layout";
import { useCall } from "@/contexts/CallContext";
import { useLanguage } from "@/contexts/LanguageContext";
import { useEyeTrackingDwell } from "@/contexts/EyeTrackingDwellContext";
import { useBoardMirror } from "@/hooks/useBoardMirror";

/** Lifts call activity to home (mirrors SocialGameReporter). */
export function CallStateReporter({ onChange }: { onChange: (s: { active: boolean; hasRemote: boolean }) => void }) {
  const { active, remoteStreams } = useCall();
  const hasRemote = remoteStreams.size > 0;
  useEffect(() => { onChange({ active, hasRemote }); }, [active, hasRemote, onChange]);
  return null;
}

/** Streams the surface the student is currently looking at to the clinician
 *  over the data channel — the board, the sentence builder, or a game's
 *  mini-board plus its ambient HUD. */
export function CallBoardMirror({ board, pageId, mode, appKind, surface, title, rtl, contextButtons, quickButtons, strip, chips, hud }: {
  board: ParsedBoardData | null; pageId?: string; mode?: "board" | "app"; appKind?: string;
  surface?: MirrorSurface; title?: string;
  rtl?: boolean; contextButtons?: BoardButton[]; quickButtons?: MirrorQuickButton[];
  strip?: MirrorStripItem[]; chips?: MirrorQuickButton[]; hud?: MirrorHudSections;
}) {
  const { active, sendData } = useCall();
  useBoardMirror({ active, sendData, board, pageId, mode, appKind, surface, title, rtl, contextButtons, quickButtons, strip, chips, hud });
  return null;
}

/** A small always-visible banner while this device is sharing its screen — so
 *  the student / facilitator can see (and is reminded) that the screen is live. */
export function CallScreenShareIndicator() {
  const { screenSharing } = useCall();
  const { t } = useLanguage();
  if (!screenSharing) return null;
  return (
    <div className="pointer-events-none fixed top-safe-2 left-1/2 z-[70] -translate-x-1/2 rounded-full bg-rose-600/90 px-4 py-1.5 text-sm font-semibold text-white shadow-lg">
      {t("call.screenSharing")}
    </div>
  );
}

/** Lifts the clinician's hovered button id (their "cursor") up to home so it can
 *  highlight that button on the student's real board. */
export function CallPeerCursorReporter({ onChange }: { onChange: (buttonId: string | null) => void }) {
  const { peerDwellId } = useCall();
  useEffect(() => { onChange(peerDwellId); }, [peerDwellId, onChange]);
  return null;
}

/** Streams where the STUDENT is looking/pointing to the clinician (board-dwell),
 *  so the clinician's mirror highlights it. Maps the dwell-target / pointer to a
 *  board button via its `data-mirror-id`; only sends when the button changes. */
export function CallCursorReporter() {
  const { active, sendData } = useCall();
  const { dwellTarget } = useEyeTrackingDwell();
  const lastRef = useRef<string | null>(null);
  const lastMoveRef = useRef(0);

  const send = (id: string | null) => {
    if (id === lastRef.current) return;
    lastRef.current = id;
    sendData({ k: "board-dwell", buttonId: id, at: Date.now() });
  };
  const sendRef = useRef(send);
  sendRef.current = send;

  // Pointer / touch (covers mouse, touch, and switch users).
  useEffect(() => {
    if (!active) return;
    const onMove = (e: PointerEvent) => {
      const now = Date.now();
      if (now - lastMoveRef.current < 80) return;
      lastMoveRef.current = now;
      const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
      const btn = el?.closest("[data-mirror-id]") as HTMLElement | null;
      sendRef.current(btn?.getAttribute("data-mirror-id") ?? null);
    };
    window.addEventListener("pointermove", onMove);
    return () => window.removeEventListener("pointermove", onMove);
  }, [active]);

  // Eye-gaze dwell target.
  useEffect(() => {
    if (!active) return;
    const btn = dwellTarget?.element?.closest?.("[data-mirror-id]") as HTMLElement | null;
    if (btn) sendRef.current(btn.getAttribute("data-mirror-id"));
  }, [active, dwellTarget]);

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

/** Applies a clinician's facilitated press on the mirrored SENTENCE BUILDER.
 *  `press` is the builder's own imperative handle, so a remote press takes the
 *  SAME path as the student's — there is no second composition pipeline that
 *  could drift from what the child's own finger does. `enabled` is the same
 *  per-student consent flag that gates board presses. */
export function CallBuilderFacilitatorBridge({ enabled, press }: {
  enabled: boolean; press: (target: BuilderTarget) => void;
}) {
  const { facilitatorBuilder } = useCall();
  const lastAtRef = useRef(0);
  useEffect(() => {
    if (!facilitatorBuilder) return;
    if (facilitatorBuilder.at <= lastAtRef.current) return;
    lastAtRef.current = facilitatorBuilder.at;
    if (!enabled) {
      console.warn("[CallBuilderFacilitatorBridge] builder press ignored (consent off)");
      return;
    }
    press(facilitatorBuilder.target);
  }, [facilitatorBuilder, enabled, press]);
  return null;
}

/** The "people I'm talking to" big window — portaled into a home-provided host
 *  in the board region. Offers spotlight / grid / auto and a shrink-to-board
 *  button (the "small video mode" toggle lives in home). */
export function CallVideoLarge({ host, onShrink }: { host: HTMLElement | null; onShrink: () => void }) {
  const { remoteStreams, contacts, localStream, activeSpeakerId, selfPersonId } = useCall();
  const { t } = useLanguage();
  const [mode, setMode] = useState<VideoLayoutMode>("spotlight");
  const [pinned, setPinned] = useState<string | null>(null);

  const tiles: VideoTileData[] = useMemo(
    () => Array.from(remoteStreams.entries()).map(([personId, stream]) => ({
      personId,
      stream,
      name: contacts.find((c) => c.personId === personId)?.name ?? null,
      speaking: personId === activeSpeakerId,
    })),
    [remoteStreams, contacts, activeSpeakerId],
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
