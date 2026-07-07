// Ambient typings for Electron's <webview> tag, used by the in-app browser
// (ElectronBrowserApp). @types/electron isn't in this client's `types`, so we
// declare just the subset of WebviewTag the eyegaze overlay drives.
//
// The <webview> element exposes its guest's webContents methods directly in the
// renderer — crucially `executeJavaScript`/`sendInputEvent` run INSIDE the
// guest's context, so scrolling/clicking/typing a cross-origin site is not a
// cross-origin operation. That is the whole reason Tier 1 uses <webview> over an
// iframe.

import type { DetailedHTMLProps, HTMLAttributes } from "react";

export interface WebviewTag extends HTMLElement {
  src: string;
  /** Run JS inside the guest page and resolve with its result. */
  executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>;
  /** Inject a synthetic input event (mouse/keyboard) into the guest. */
  sendInputEvent(event: Record<string, unknown>): Promise<void>;
  insertCSS(css: string): Promise<string>;
  getWebContentsId(): number;
  getURL(): string;
  getTitle(): string;
  reload(): void;
  stop(): void;
  goBack(): void;
  canGoBack(): boolean;
  loadURL(url: string): Promise<void>;
}

type WebviewAttributes = {
  src?: string;
  partition?: string;
  allowpopups?: string;
  useragent?: string;
  webpreferences?: string;
};

declare global {
  namespace JSX {
    interface IntrinsicElements {
      webview: DetailedHTMLProps<HTMLAttributes<HTMLElement>, HTMLElement> & WebviewAttributes;
    }
  }
}
