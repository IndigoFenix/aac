// src/types/board-ir.ts

export type ActionIR =
  | { type: "speak"; text: string }
  | ActionLinkIR
  | { type: "back"; }
  | { type: "bookmark"; }
  | { type: "home"; }
  | { type: "youtube"; videoId: string; title: string };

export type ActionLinkIR = { type: "link"; toPageId: string; };

export interface ButtonIR {
  id: string;
  row: number;
  col: number;
  label: string;
  spokenText?: string;
  color?: string;
  iconRef?: string;
  symbolPath?: string; // Path to Mulberry symbol SVG

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
    symbolPath: string; // e.g. "[sstix#]50026.emf"
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
    symbolPath: string; // e.g. "[sstix#]50026.emf"
    backgroundColor?: string; // e.g. "#D6FFF6FF"
  };
}