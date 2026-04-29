// src/features/custom-app/editor-state.ts
//
// Local UI state for the custom-app editor: which item is selected, whether
// the user has armed a class for placement, and whether we're in edit or play
// mode. The shared GameDefinition itself lives in useCustomAppStore.

export type EditorMode = "edit" | "play";

export type Selection =
  | { kind: "none" }
  | { kind: "class"; classId: string }
  | { kind: "room"; roomId: string }
  | { kind: "entity"; roomId: string; index: number }
  | { kind: "button"; buttonId: string };

export interface EditorState {
  mode: EditorMode;
  selection: Selection;
  /** When set, a click on a room cell will place a new entity of this class. */
  placementClassId: string | null;
  /** When true, placement stays armed after a placement (set by Shift-click). */
  stickyPlacement: boolean;
  /** Bumped each time the user presses Play, used as a remount key. */
  playSession: number;
}

export type EditorAction =
  | { type: "selectNone" }
  | { type: "selectClass"; classId: string }
  | { type: "selectRoom"; roomId: string }
  | { type: "selectEntity"; roomId: string; index: number }
  | { type: "selectButton"; buttonId: string }
  | { type: "armPlacement"; classId: string; sticky: boolean }
  | { type: "cancelPlacement" }
  | { type: "enterPlay" }
  | { type: "exitPlay" };

export const initialEditorState: EditorState = {
  mode: "edit",
  selection: { kind: "none" },
  placementClassId: null,
  stickyPlacement: false,
  playSession: 0,
};

export function editorReducer(state: EditorState, action: EditorAction): EditorState {
  switch (action.type) {
    case "selectNone":
      return { ...state, selection: { kind: "none" }, placementClassId: null };
    case "selectClass":
      return {
        ...state,
        selection: { kind: "class", classId: action.classId },
        placementClassId: null,
      };
    case "selectRoom":
      return {
        ...state,
        selection: { kind: "room", roomId: action.roomId },
        placementClassId: null,
      };
    case "selectEntity":
      return {
        ...state,
        selection: { kind: "entity", roomId: action.roomId, index: action.index },
      };
    case "selectButton":
      return {
        ...state,
        selection: { kind: "button", buttonId: action.buttonId },
        placementClassId: null,
      };
    case "armPlacement":
      return {
        ...state,
        placementClassId: action.classId,
        stickyPlacement: action.sticky,
      };
    case "cancelPlacement":
      return { ...state, placementClassId: null, stickyPlacement: false };
    case "enterPlay":
      return { ...state, mode: "play", playSession: state.playSession + 1 };
    case "exitPlay":
      return { ...state, mode: "edit" };
  }
}
