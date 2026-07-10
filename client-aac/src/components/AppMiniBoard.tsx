// client-aac/src/components/AppMiniBoard.tsx
// Compact button panel shown alongside open apps / prebuilt boards (the context
// sidebar) and, during a game, the main board's 8 buttons in 2×4. Buttons render
// through the SAME shared <SentenceButton> as the main board, so borders, colors
// and glyph/symbol/face rendering are identical. Positioned left (LTR) / right
// (RTL) by the parent flex-row.

import { AnimatePresence } from "framer-motion";
import type { ParsedBoardData, BoardButton } from "@shared/schema";
import { useTextToSpeech } from "@/hooks/useTextToSpeech";
import { SentenceButton } from "@/components/SentenceButton";
import { ButtonBusyIndicator, type ButtonBusyPhase } from "@/components/ButtonBusyIndicator";

interface AppMiniBoardProps {
  board: ParsedBoardData | null;
  onButtonClick: (button: BoardButton, spokenText: string) => void;
  language?: string;
  voiceType?: string;
  suppressLocalSpeech?: boolean;
  getFaceImage?: (contactId: string) => string | null;
  /** Number of columns. 1 (default) = the narrow context strip; >1 = a wider
   *  panel (e.g. the main board's 8 buttons in 2×4 during a game). */
  columns?: number;
  /** Button id a remote clinician is hovering (their "cursor") — ringed. */
  highlightButtonId?: string | null;
  /** Button id the child just pressed — shows an ambient processing/speaking cue. */
  busyButtonId?: string | null;
  /** Which phase of the busy cue to show on `busyButtonId`. */
  busyPhase?: ButtonBusyPhase | null;
}

// Icon/text sizing for a 4-row column — mirrors DynamicBoard's formula so the
// buttons read the same on the side as in the grid.
const ICON_FONT = "clamp(1rem, calc((100dvh - 10.5rem) / 4 * 0.45), 6rem)";
const TEXT_FONT = "clamp(0.5rem, calc((100dvh - 10.5rem) / 4 * 0.10), 1.25rem)";

export default function AppMiniBoard({ board, onButtonClick, language, voiceType, suppressLocalSpeech, getFaceImage, columns = 1, highlightButtonId, busyButtonId, busyPhase }: AppMiniBoardProps) {
  const { speak } = useTextToSpeech();

  // 4 rows per column; the narrow strip is 1 col (4 buttons), the game panel is
  // 2 cols (the main board's 8 buttons).
  const cols = Math.max(1, columns);
  const page = board?.pages?.[0];
  const buttons = (page?.buttons || []).slice(0, cols * 4);
  // Game panel is a fixed 2×4; the narrow context strip sizes its rows to the
  // button count so 1–2 buttons still fill the height (as before).
  const rows = cols === 1 ? Math.max(1, buttons.length) : 4;

  const handleClick = (button: BoardButton) => {
    const text = button.spokenText || button.label;
    if (!suppressLocalSpeech) {
      speak(text, language, voiceType as any);
    }
    onButtonClick(button, text);
  };

  return (
    <div
      className="grid gap-2 p-2 h-full flex-shrink-0"
      style={{
        // The narrow context strip stays 7rem/col; a multi-column GAME board is
        // ~twice as wide (14rem/col) so its buttons read big.
        width: `${cols * (cols > 1 ? 14 : 7)}rem`,
        gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
        gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))`,
      }}
    >
      <AnimatePresence mode="popLayout">
        {buttons.map((button, i) => (
          <SentenceButton
            key={button.label + i}
            variant="board"
            button={button}
            onClick={() => handleClick(button)}
            borderClassName={highlightButtonId && button.id === highlightButtonId ? "ring-4 ring-sky-400 border-gray-200" : "border-gray-200"}
            extraButtonProps={{ "data-mirror-id": button.id }}
            getFaceImage={getFaceImage ?? undefined}
            iconFontSize={ICON_FONT}
            textFontSize={TEXT_FONT}
            entering={false}
            cornerIndicator={busyPhase && busyButtonId && button.id === busyButtonId ? <ButtonBusyIndicator phase={busyPhase} /> : undefined}
          />
        ))}
      </AnimatePresence>
    </div>
  );
}
