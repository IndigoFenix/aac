// client-aac/src/components/RecordingIndicator.tsx
//
// A camera is pointed at a child and a file is being written. That is never
// allowed to be invisible, whatever the recording is for, so this dot is not
// optional and has no setting to turn it off — it renders whenever a clip is
// open and disappears the instant one closes.
//
// It is also deliberately small, cornered, and out of the way of every board
// button: the student's board is the thing on this screen that matters, and a
// recording overlay that competes with it for attention would be its own kind
// of harm. `pointer-events-none` keeps it from ever eating a press, which
// matters more here than usual — a mis-aimed dwell that lands on chrome is a
// selection the student did not get to make.

import { useLanguage } from "@/contexts/LanguageContext";

interface RecordingIndicatorProps {
  /** True while a clip is being written. */
  active: boolean;
}

export function RecordingIndicator({ active }: RecordingIndicatorProps) {
  const { t } = useLanguage();
  if (!active) return null;

  return (
    <div
      // `end-3` rather than `right-3`: the AAC ships in RTL languages and this
      // must sit in the trailing corner in both directions.
      className="pointer-events-none fixed top-3 end-3 z-50 flex items-center gap-1.5
                 rounded-full bg-black/60 px-2.5 py-1 backdrop-blur-sm"
      role="status"
      aria-label={t('aac.recording.active')}
      data-testid="recording-indicator"
    >
      <span className="relative flex h-2.5 w-2.5">
        {/* The pulse is a slow opacity fade, not a moving highlight — see the
            no-bright-moving-specular rule; students with photosensitivity share
            this screen. */}
        <span className="absolute inline-flex h-full w-full animate-pulse rounded-full bg-red-500 opacity-75" />
        <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-red-600" />
      </span>
      <span className="text-[11px] font-medium uppercase tracking-wide text-white/90">
        {t('aac.recording.badge')}
      </span>
    </div>
  );
}

export default RecordingIndicator;
