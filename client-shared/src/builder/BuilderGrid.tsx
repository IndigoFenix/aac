// client-shared/src/builder/BuilderGrid.tsx
//
// SHARED BY THE AAC STUDENT BUILDER (SentenceConstructorBoard) AND THE
// CLINICIAN "EDIT VISUAL" BUILDER. Change it for both, or for neither.
//
// THE MAIN WORD GRID'S SHELL: 9 columns × 2 rows of equal cells, with the
// paging controls BRACKETING the words.
//
// The bracket is the whole point, and it is a decision, not an accident:
//
//   - The controls are only rendered when the current list has more items than
//     one page (`needsMore`). Without the conditional they would always push
//     the grid onto an implicit third row and the browser would compress the
//     two declared rows to make space.
//   - BACK as well as More (user, 2026-08-25): forward-only paging made a word
//     you had scrolled past cost a full lap of the list, which on a 54-word
//     budget is two more dwells.
//   - BACK LEADS THE LIST, More closes it (user, 2026-08-27). The two used to
//     sit side by side in the last two cells, which read as one pair of arrows
//     rather than as the two ENDS of a list — and put the control for "what
//     came before" after everything that comes after. First cell and last cell
//     say which way each one goes without being read, which is the only way a
//     control is read at all on a board driven by dwell. The reading direction
//     carries it: the board's `dir` flips the grid's flow, so on a Hebrew board
//     Back is the top-RIGHT cell and still the first one.
//
// Paging itself lives in `@shared/aac-builder-paging` (`pageBuilderGrid`), and
// the HOST calls it: the AAC also publishes the visible page to a clinician's
// call mirror, so it needs the sliced list in its own hands. This component is
// the shell those tiles go into.

import type { CSSProperties, ReactNode } from "react";
import { MoreButton, PageBackButton } from "./buttons";

/** 9 wide, 2 tall, every cell equal — wider than tall per cell, since each
 *  button's label sits BELOW a square image (the image dominates the visual
 *  identity; the cell can afford to be narrower because the label is just a
 *  one-line hint). */
const GRID_STYLE: CSSProperties = {
  gridTemplateColumns: "repeat(9, minmax(0, 1fr))",
  gridTemplateRows: "repeat(2, minmax(0, 1fr))",
};

export interface BuilderGridProps {
  /** The tiles for the CURRENT page — already sliced by the host. */
  children: ReactNode;
  /** True when the list is longer than one page: draws Back and More. */
  needsMore: boolean;
  onBack: () => void;
  onMore: () => void;
  backTestId?: string;
  moreTestId?: string;
  testId?: string;
  /** Encoded call-mirror addresses for the two paging controls. The HOST
   *  supplies them; omitted, no attribute is rendered. */
  backMirrorId?: string;
  moreMirrorId?: string;
}

export function BuilderGrid(props: BuilderGridProps) {
  return (
    <div className="grid gap-2 w-full h-full" style={GRID_STYLE} data-testid={props.testId}>
      {props.needsMore && (
        <PageBackButton onPress={props.onBack} testId={props.backTestId} mirrorId={props.backMirrorId} />
      )}
      {props.children}
      {props.needsMore && (
        <MoreButton onPress={props.onMore} testId={props.moreTestId} mirrorId={props.moreMirrorId} />
      )}
    </div>
  );
}

/** The full-width message a grid shows when its list is empty (no people to
 *  pick, no words for this group). Spans the whole 9×2 area so it centres. */
export function BuilderGridEmpty(props: { children: ReactNode }) {
  return (
    <div className="col-span-9 row-span-2 flex items-center justify-center text-sm text-gray-400">
      {props.children}
    </div>
  );
}
