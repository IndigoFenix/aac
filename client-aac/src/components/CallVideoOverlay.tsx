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
//   - CallFacilitatorBridge: a clinician's facilitated press — the button LIGHTS
//                          UP and is READ ALOUD on the student's device
//                          (consent-gated). It is an offer, not an utterance:
//                          nothing reaches the press pipeline, the server, or
//                          the AI's ears.
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
import { formatBuilderTarget } from "@shared/call/builder-mirror";
import VideoTileLayout, { type VideoTileData } from "@shared/social-world/VideoTileLayout";
import { pickSpotlightId, type VideoLayoutMode } from "@shared/call/video-layout";
import { useCall } from "@/contexts/CallContext";
import { useBoardAudio } from "@/contexts/BoardAudioContext";
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

/**
 * A CLINICIAN'S FACILITATED PRESS ON THE MIRRORED BOARD — an OFFER, not the
 * child's voice.
 *
 * The button lights up and reads itself aloud on the student's device, and that
 * is all: the very thing the audio scan does for one button, and the very thing
 * a caretaker in the room does by HOLDING a button. It deliberately does NOT go
 * through `handleBoardButtonClick` — a facilitated press used to be re-emitted
 * as a real press, so the student's own voice said it and the AI answered it as
 * the student's utterance. Nobody wanted words put in the child's mouth.
 *
 * "The AI does not hear it" is not a mute: `readout` announces the sentence
 * through BoardAudioContext's `lastSpoken`, which DualAgentContext forwards to
 * the Observer as [OWN_SPEECH], so the reading is discarded as the device's own
 * voice rather than transcribed as a fresh turn.
 *
 * `enabled` is the per-student consent flag; when off, presses are REFUSED —
 * and the refusal is sent back. `allowFacilitatorControl` defaults to false, so
 * a clinician arming Interact for the first time gets a board that appears to
 * do nothing; a silent drop is indistinguishable from a broken call.
 */
export function CallFacilitatorBridge({ enabled }: { enabled: boolean }) {
  const { facilitatorPress, sendData } = useCall();
  const { readout } = useBoardAudio();
  const lastAtRef = useRef(0);
  useEffect(() => {
    if (!facilitatorPress) return;
    if (facilitatorPress.at <= lastAtRef.current) return;
    lastAtRef.current = facilitatorPress.at;
    if (!enabled) {
      console.warn("[CallFacilitatorBridge] facilitator press ignored (consent off)");
      sendData({ k: "facilitator-ack", ok: false, reason: "consent", at: Date.now() });
      return;
    }
    // Same address the pointing gesture resolves: a button the clinician can
    // see on the mirror is a button this device can find by `data-mirror-id`.
    const el = document.querySelector<HTMLElement>(
      `[data-mirror-id="${CSS.escape(facilitatorPress.button.id)}"]`,
    );
    if (!el) {
      // The board moved on under the clinician (a rebuild, a page turn, the
      // child left the surface). Say so — there is nothing on screen to light.
      console.warn("[CallFacilitatorBridge] no board element for", facilitatorPress.button.id);
      sendData({ k: "facilitator-ack", ok: false, reason: "unavailable", at: Date.now() });
      return;
    }
    // The clinician's own resolution of the sentence is only a FALLBACK: the
    // device's `data-speech` is what this button says in the child's language.
    void readout(el, facilitatorPress.spokenText || facilitatorPress.button.label);
    sendData({ k: "facilitator-ack", ok: true, at: Date.now() });
  }, [facilitatorPress, enabled, readout, sendData]);
  return null;
}

/**
 * A clinician POINTING at a button, without pressing it.
 *
 * Routed into `BoardAudioContext.highlight` — the very controller the in-room
 * hold-to-highlight gesture and the audio scan already share — so the child
 * sees ONE yellow box however the pointing arrived, and the remote gesture
 * inherits the local one's behaviour for free.
 *
 * Pointing is NOT gated on facilitator consent: the clinician's cursor already
 * highlights buttons on this board unconditionally (`peerDwellId`), and drawing
 * attention to a word is not saying it. `speak` IS gated — reading the button
 * aloud produces sound on the child's device, which is the part consent covers.
 *
 * ⚠️ The yellow box is DRAWN by `HoldHighlightOverlay`, which home mounts
 * unconditionally. Only that component's own gesture is eyegaze-gated (`enabled`)
 * — its render of `highlightEl` is not — so remote pointing works whether or not
 * the child is on eye control. Unmounting that overlay would silently take this
 * with it.
 */
export function CallIndicateBridge({ allowSpeech }: { allowSpeech: boolean }) {
  const { peerIndicate } = useCall();
  const { highlight } = useBoardAudio();
  const lastAtRef = useRef(0);
  useEffect(() => {
    if (!peerIndicate) return;
    if (peerIndicate.at <= lastAtRef.current) return;
    lastAtRef.current = peerIndicate.at;
    if (!peerIndicate.buttonId) { highlight(null); return; }
    // The mirror addresses buttons by the same `data-mirror-id` the cursor
    // reporter reads, so a button the clinician can see is a button we can find.
    const el = document.querySelector<HTMLElement>(`[data-mirror-id="${CSS.escape(peerIndicate.buttonId)}"]`);
    if (!el) {
      console.warn("[CallIndicateBridge] no board element for", peerIndicate.buttonId);
      return;
    }
    highlight(el, !!peerIndicate.speak && allowSpeech);
  }, [peerIndicate, highlight, allowSpeech]);
  return null;
}

/**
 * The same offer, on the mirrored SENTENCE BUILDER.
 *
 * A builder cell lights up and reads itself aloud exactly as a board button
 * does; the composition is NOT touched. A clinician showing a child the word
 * "juice" in the palette is pointing at it, and the sentence the child is
 * building stays the child's — the builder's own handlers are reached only by
 * the child's own press.
 *
 * `enabled` is the same per-student consent flag that gates board presses, and
 * a cell that is no longer on screen (the child left the builder, or paged the
 * grid) comes back as `unavailable` rather than a silent nothing.
 *
 * Some controls have genuinely nothing to say (a pure icon with no label). They
 * still light up, and still ack ok — the pointing landed.
 */
export function CallBuilderFacilitatorBridge({ enabled }: { enabled: boolean }) {
  const { facilitatorBuilder, sendData } = useCall();
  const { readout } = useBoardAudio();
  const lastAtRef = useRef(0);
  useEffect(() => {
    if (!facilitatorBuilder) return;
    if (facilitatorBuilder.at <= lastAtRef.current) return;
    lastAtRef.current = facilitatorBuilder.at;
    if (!enabled) {
      console.warn("[CallBuilderFacilitatorBridge] builder press ignored (consent off)");
      sendData({ k: "facilitator-ack", ok: false, reason: "consent", at: Date.now() });
      return;
    }
    // The builder tags its cells with the very id the mirror addresses them by
    // (`bx:` targets — builder-mirror.ts), so one lookup covers words, tabs,
    // chips, the paging controls and the sentence controls alike.
    const mirrorId = formatBuilderTarget(facilitatorBuilder.target);
    const el = document.querySelector<HTMLElement>(`[data-mirror-id="${CSS.escape(mirrorId)}"]`);
    if (!el) {
      console.warn("[CallBuilderFacilitatorBridge] no builder element for", mirrorId);
      sendData({ k: "facilitator-ack", ok: false, reason: "unavailable", at: Date.now() });
      return;
    }
    void readout(el);
    sendData({ k: "facilitator-ack", ok: true, at: Date.now() });
  }, [facilitatorBuilder, enabled, readout, sendData]);
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
