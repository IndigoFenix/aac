// Shared types for AAC board generation

export interface AACSuggestion {
  label: string;
  spokenText: string;
  color: string;
  iconRef: string;
  category: string;
  symbolFilename?: string;
  symbolPath?: string;
}

export interface ParsedBoardData {
  name: string;
  grid: { rows: number; cols: number };
  pages: Array<{
    id: string;
    name: string;
    description?: string;
    buttons: Array<{
      id: string;
      row: number;
      col: number;
      label: string;
      spokenText?: string;
      color?: string;
      iconRef?: string;
      symbolPath?: string;
      selfClosing?: boolean;
      action?: {
        type: string;
        text?: string;
        toPageId?: string;
        toBoardId?: string;
        videoId?: string;
        title?: string;
      };
    }>;
    videoPlayers?: Array<{
      id: string;
      row: number;
      col: number;
      rowSpan: number;
      colSpan: number;
      videoId: string;
      title: string;
    }>;
    layout: { rows: number; cols: number };
  }>;
}

// Internal spec for AI generation
export interface GeneratedButtonSpec {
  label: string;
  spokenText?: string;
  color?: string;
  iconRef?: string;
  row?: number;
  col?: number;
  pageId: string;          // Which page this button goes on
  selfClosing?: boolean;
  linkPageId?: string;     // If this button links to another page
}

export interface GeneratedPageSpec {
  id: string;              // AI picks its own ID
  name: string;
}

export interface GeneratedBoardUpdate {
  summary: string;
  newPages: GeneratedPageSpec[];
  newButtons: GeneratedButtonSpec[];
  deletedPageIds?: string[];        // Pages to delete
  deletedButtonIds?: string[];      // Buttons to delete (by ID)
  editedButtons?: EditedButtonSpec[]; // Buttons to modify
}

export interface EditedButtonSpec {
  id: string;                       // Which button to edit
  label?: string;
  spokenText?: string;
  color?: string;
  iconRef?: string;
  row?: number;
  col?: number;
  pageId?: string;                  // Move to different page
  selfClosing?: boolean;
  linkPageId?: string;
}