// client/src/features/call/StudentSplitView.tsx
//
// THE STUDENT'S FACE AND THE STUDENT'S SCREEN, AT THE SAME TIME.
//
// The call used to make the clinician choose: `viewBoard` was a boolean, so you
// watched the mirrored board OR the camera. Both halves answer different
// questions and you need both at once — the grid says what they pressed, the
// face says whether they meant it — and toggling between them loses whichever
// one you are not on at the moment that matters.
//
// The divider is draggable, but the DEFAULT is per surface and lives in
// shared/call/student-view.ts: a board splits evenly (the ask was literally
// "half the student's camera, and half the grid"), while a game gives the
// camera much less, because a world scene with its own HUD carries far more
// detail to read than a grid does.
//
// The camera shown is the one belonging to the peer that SENT the mirror, not
// "the first remote stream" — in a group call those are routinely different
// people, and pairing a student's board with someone else's face is worse than
// showing no face at all.
//
// 🚨 THE SURFACE PANE LEADS AND THE CAMERA TRAILS, and that order is load-
// bearing. The clinician's own self-view is pinned `bottom-4 end-4` over the
// whole call area, so whichever pane trails gets a video thumbnail dropped on
// its bottom corner. Covering a corner of the camera costs nothing; covering a
// corner of the BOARD hides buttons, and the whole point of the mirror is that
// the clinician sees every button the child has. Both the self-view's `end` and
// this flex order are LOGICAL, so the pairing survives RTL without a special
// case — but the drag maths does not, and has to invert.

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  clampCameraShare,
  defaultCameraShare,
  type StudentSurface,
} from "@shared/call/student-view";
import { useLanguage } from "@/contexts/LanguageContext";
import { cn } from "@/lib/utils";

interface Props {
  /** The mirroring peer's camera, when it is arriving. */
  stream: MediaStream | null;
  /** Name to caption the camera pane with. */
  name?: string | null;
  /** Which surface fills the other pane — decides the default proportion. */
  surface?: StudentSurface;
  /** The surface pane's content (mirrored board, builder, or a screen feed). */
  children: ReactNode;
  /** Caption shown when the peer's camera is off / not arriving. */
  noVideoLabel?: string;
  /** Accessible name for the drag handle. */
  resizeLabel?: string;
  className?: string;
}

export function StudentSplitView({ stream, name, surface, children, noVideoLabel, resizeLabel, className }: Props) {
  const { isRTL } = useLanguage();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [share, setShare] = useState(() => defaultCameraShare(surface));
  const [dragging, setDragging] = useState(false);

  // A new surface brings its own proportion. A drag is a decision about the
  // surface in front of you, not a standing preference — when the student moves
  // from their board into a game, the game's default is the right answer again.
  useEffect(() => { setShare(defaultCameraShare(surface)); }, [surface]);

  const attach = useCallback((el: HTMLVideoElement | null) => {
    // Visual only — CallAudioSinks owns this call's audio for its whole life.
    if (!el) return;
    if (el.srcObject !== stream) el.srcObject = stream;
    el.muted = true;
  }, [stream]);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(true);
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    const host = hostRef.current;
    if (!host) return;
    const rect = host.getBoundingClientRect();
    if (rect.width <= 0) return;
    const fromLeft = (e.clientX - rect.left) / rect.width;
    // The camera pane TRAILS, so it occupies what is left of the container:
    // the right edge in LTR, the left edge in RTL.
    setShare(clampCameraShare(isRTL ? fromLeft : 1 - fromLeft));
  }, [dragging, isRTL]);

  const endDrag = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    setDragging(false);
  }, []);

  return (
    <div ref={hostRef} className={cn("flex h-full w-full items-stretch", className)}>
      {/* The student's screen LEADS — see the note at the top of this file: the
          self-view thumbnail lands on the trailing pane, and it must not be
          allowed to sit on top of the child's buttons. */}
      <div className="min-w-0 flex-1">{children}</div>

      {/* Drag handle. Wide hit area, thin visual — a hairline is hard to grab
          and this sits between two things the clinician is actively reading. */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={resizeLabel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        className="group flex w-3 shrink-0 cursor-col-resize items-center justify-center"
      >
        <div className={cn("h-16 w-1 rounded-full transition-colors", dragging ? "bg-amber-400" : "bg-white/25 group-hover:bg-white/50")} />
      </div>

      <div className="relative min-w-0 overflow-hidden rounded-lg bg-black/60" style={{ flex: `0 0 ${share * 100}%` }}>
        {stream ? (
          // eslint-disable-next-line jsx-a11y/media-has-caption -- live WebRTC peer feed
          <video ref={attach} autoPlay playsInline className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full w-full items-center justify-center px-2 text-center text-sm text-white/40">
            {noVideoLabel}
          </div>
        )}
        {name && (
          // Sits at the TOP: the bottom corner of this pane is where the
          // clinician's own self-view thumbnail lands.
          <div className="absolute inset-x-0 top-0 truncate bg-black/50 px-2 py-1 text-center text-xs text-white">
            {name}
          </div>
        )}
      </div>
    </div>
  );
}

export default StudentSplitView;
