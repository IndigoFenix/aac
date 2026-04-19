// src/types/board-ir.ts

export type ActionIR =
  | { type: "speak"; text: string }
  | ActionLinkIR
  | ActionNavigateIR
  | { type: "back"; }
  | { type: "bookmark"; }
  | { type: "home"; }
  | { type: "exit"; text?: string }
  | { type: "youtube"; videoId: string; title: string }
  | { type: "open_website"; url: string; label?: string };

export type ActionLinkIR = { type: "link"; toPageId: string; toBoardId?: string; };
export type ActionNavigateIR = { type: "navigate"; toPageId: string; };

export interface ButtonIR {
  id: string;
  row: number;
  col: number;
  rowSpan?: number;  // Number of rows this button spans (default 1)
  colSpan?: number;  // Number of columns this button spans (default 1)
  label: string;
  spokenText?: string;
  color?: string;
  iconRef?: string;
  symbolPath?: string; // Path to Mulberry symbol SVG or custom symbol API URL
  rebusKey?: string;   // Widgit Rebus concept name for Grid3 export (e.g. "happy", "mum", "ice cream")
  imageKey?: string;   // Auto-generated symbol key (e.g. "drinking_water") — used to look up or generate symbol images

  /**
   * When true, this button will automatically "jump back"
   * after its action is triggered (used for pop‑up style boards).
   */
  selfClosing?: boolean;

  action?: ActionIR;
}

export interface VideoPlayerIR {
  id: string;
  row: number;
  col: number;
  rowSpan: number;
  colSpan: number;
  videoId: string;
  title: string;
}

export interface PageIR {
  id: string;
  name: string;
  description?: string;
  buttons: ButtonIR[];
  videoPlayers?: VideoPlayerIR[];
  layout?: { rows: number; cols: number };
}

export interface BoardIR {
  name: string;
  grid: { rows: number; cols: number };
  pages: PageIR[];
  assets?: { [key: string]: Blob | string };
  coverImage?: {
    iconRef?: string;      // Emoji or icon reference (e.g. "🏠")
    imageKey?: string;     // Auto-generated symbol key (e.g. "communication_board")
    symbolPath?: string;   // Resolved symbol path (e.g. "[sstix#]50026.emf" or "/api/symbols/...")
    backgroundColor?: string; // e.g. "#D6FFF6FF"
  };
}

// Modifies the current board based on the response to a prompt
export interface BoardModifier {
  name?: string;
  addPages?: PageIR[];
  updatePages?: { id: string; name?: string; buttons?: ButtonIR[] }[];
  removePageIds?: string[];
  assets?: { [key: string]: Blob | string };
  coverImage?: {
    iconRef?: string;
    imageKey?: string;
    symbolPath?: string;
    backgroundColor?: string;
  };
}