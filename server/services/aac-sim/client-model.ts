/**
 * client-model.ts — THE VIRTUAL DEVICE (harness design ④).
 *
 * The board a child looks at is not held by the server. The server sends DELTAS
 * (`board`, `board_patch`, `set_board`, `symbol_update`, `context_button_*`,
 * `ai_button_press`) and the CLIENT accumulates them — then hands its result
 * back on every press, in `button_press.board`. So a headless driver has to keep
 * that same state, or it is pressing a board nobody is looking at.
 *
 * ONE OWNER, NOT A SECOND IMPLEMENTATION. Every rule here comes from the same
 * pure modules the real AAC renders from — `board-history`, `board-slots`,
 * `page-nav`, `context-sidebar`, `quick-actions`, `pageGrid`. This file is
 * wiring: which message calls which rule. If a rule is missing, it belongs in
 * `shared/aac/`, where the component will pick it up too, and NOT here.
 *
 * COVERAGE, stated honestly:
 *   ✅ the AI dynamic board, its pages, patches, symbol updates, More/Back
 *   ✅ the context sidebar, the quick-action row, board history + pause
 *   ✅ the Word Finder — its suggestions arrive AS board buttons
 *      (`buttonType: "suggestion"`), so it rides the board surface for free
 *   ✅ binary-choice overlays, app open/close, the heard-speech log
 *   ⛔ the SENTENCE BUILDER surface. It is a separate overlay driven by the
 *      engine surfacer (`createTextBuilder`); this model only records that it
 *      is open. Wiring it is its own step.
 */

import type { BoardButton, ParsedBoardData } from "@shared/schema";
import { pageGrid } from "@shared/board-grid";
import {
  canGoBack as historyCanGoBack,
  canGoForward as historyCanGoForward,
  currentBoard as historyCurrentBoard,
  emptyBoardHistory,
  goBack as historyGoBack,
  goForward as historyGoForward,
  receiveBoard,
  type BoardHistory,
} from "@shared/aac/board-history";
import {
  applyBoardPatch,
  applySymbolUpdate,
  layoutSlots,
  resolveFades,
  type SlotState,
} from "@shared/aac/board-slots";
import {
  canGoBackPage,
  emptyPageNav,
  initPageNav,
  pageNavReducer,
  resolvePage,
  type PageNav,
} from "@shared/aac/page-nav";
import {
  addContextButton,
  applyContextSymbolUpdate,
  removeContextButton,
  type ContextButton,
} from "@shared/aac/context-sidebar";
import { quickActionSlots, type QuickActionSlot } from "@shared/aac/quick-actions";
import { applyAiTextChunk } from "@shared/aac/ai-caption";
import type { OutboundMessage } from "./headless-socket.js";

/**
 * How long the student's board loading bar takes to fade out (home.tsx's
 * `transition-opacity duration-500` on the `board-busy-ripple`). Within this
 * window the bar is still on screen, so the board still reads as busy.
 */
export const BOARD_BAR_FADE_MS = 500;

/** The AAC board's own last-resort grid — DynamicBoard's, not the shared default. */
const DEFAULT_GRID = { rows: 3, cols: 4 } as const;

/** Something the child heard or read: the AI speaking, or a person transcribed. */
export interface HeardLine {
  /** "ai" = the companion spoke; "person" = someone in the room was transcribed;
   *  "self" = the child's own utterance voiced back. */
  source: "ai" | "person" | "self";
  text: string;
  /** ms since the model was created — the harness's clock for latency. */
  at: number;
  /** Who the transcript was attributed to, when the server said. */
  speaker?: string;
}

export interface BinaryChoice {
  options: BoardButton[];
  escapeKind?: "maybe" | "neither";
}

export class SimClientModel {
  // ── board ───────────────────────────────────────────────────────────────
  private history: BoardHistory = emptyBoardHistory();
  private nav: PageNav = emptyPageNav();
  private slots: SlotState[] = [];
  private paused = false;
  /** A loaded pre-built board (set_board) shown instead of the AI's. */
  private loadedBoard: { board: ParsedBoardData; name: string; boardId: string } | null = null;

  // ── chrome ──────────────────────────────────────────────────────────────
  private context: ContextButton[] = [];
  private tier: "home" | "context" | "latest" = "latest";
  private activeApp: string | null = null;
  private guessing = false;
  private builderOpen = false;
  private binaryChoice: BinaryChoice | null = null;

  // ── what the child perceives besides the board ──────────────────────────
  readonly heard: HeardLine[] = [];
  /** Server-side busy signals, for the latency the child actually waits. */
  private busy = { speaker: false, board: false, interpret: false };
  private sleepState: string | null = null;
  /** When the board cue last went false, for the client's fade window. */
  private boardClearedAt: number | null = null;
  /** The AI turn being streamed right now, and where it sits in `heard`. */
  private aiCaption = "";
  private aiTurnIndex: number | null = null;

  private readonly startedAt = Date.now();
  /** Injectable so a test can assert timings without a real clock. */
  constructor(private readonly now: () => number = () => Date.now()) {}

  private stamp(): number {
    return this.now() - this.startedAt;
  }

  // ── ingest ──────────────────────────────────────────────────────────────

  /** Fold one server message into the device's state. Unknown types are
   *  ignored rather than thrown on — the server's vocabulary grows, and a
   *  harness that dies on an unrecognised envelope is worse than one that
   *  quietly does not model it yet. */
  apply(msg: OutboundMessage): void {
    switch (msg.type) {
      case "board":
        this.receive(msg.data as ParsedBoardData);
        return;

      case "board_patch": {
        const patch = msg.data as { add?: unknown[]; remove?: string[] };
        this.slots = applyBoardPatch(this.slots, {
          add: (patch.add ?? []) as never[],
          remove: patch.remove ?? [],
        });
        // The real board holds a vacated cell for the fade, then releases it.
        // A text driver has no animation to wait for, so the hand-off happens
        // immediately — the child never sees the intermediate frame anyway.
        this.slots = resolveFades(this.slots);
        return;
      }

      case "set_board": {
        const d = msg.data as { board: ParsedBoardData; name: string; boardId: string };
        this.loadedBoard = d;
        this.tier = "context";
        this.nav = initPageNav(d.board);
        this.relayout();
        return;
      }

      case "unload_board":
        this.loadedBoard = null;
        this.tier = "latest";
        this.nav = initPageNav(this.aiBoard());
        this.relayout();
        return;

      case "symbol_update": {
        const u = msg.data as { buttonLabel: string; symbolPath: string };
        this.slots = applySymbolUpdate(this.slots, u);
        this.context = applyContextSymbolUpdate(this.context, u);
        return;
      }

      case "context_button_add":
        this.context = addContextButton(this.context, msg.data as ContextButton);
        return;

      case "context_button_remove":
        this.context = removeContextButton(this.context, String((msg.data as { label?: string })?.label ?? ""));
        return;

      case "ai_button_press": {
        // The AI navigated the board for the child; the surface must follow.
        const d = msg.data as { action: string; targetPageId?: string };
        const action =
          d.action === "link" && d.targetPageId
            ? ({ type: "to", pageId: d.targetPageId } as const)
            : d.action === "back"
              ? ({ type: "back" } as const)
              : d.action === "home"
                ? ({ type: "home" } as const)
                : null;
        if (action) {
          this.nav = pageNavReducer(this.nav, this.board(), action).nav;
          this.relayout();
        }
        return;
      }

      case "guessing_mode":
        this.guessing = msg.active === true;
        return;

      case "binary_choice":
      case "ask_binary_choice": {
        const d = msg.data as { options?: BoardButton[]; escapeKind?: "maybe" | "neither" };
        this.binaryChoice = { options: d.options ?? [], escapeKind: d.escapeKind };
        return;
      }

      case "app_open":
        this.activeApp = String((msg.data as { appId?: string })?.appId ?? "app");
        return;

      case "app_close":
        this.activeApp = null;
        return;

      // The AI's own voice. `speak` is the companion talking TO the child;
      // `utterance` is the child's composed sentence voiced back at them, which
      // they DO hear and which is not the same event.
      case "speak":
        this.endAiTurn();
        this.pushHeard("ai", String(msg.text ?? ""));
        return;

      // THE LIVE MODEL'S SPEECH, streamed. It arrives as many `text` chunks
      // rather than one `speak`, which is how the native-audio Speaker talks —
      // a model that only handled `speak` would show a child who heard nothing
      // while the AI was talking to them. Leak-guards live in the shared rule.
      case "text": {
        const r = applyAiTextChunk(this.aiCaption, String(msg.data ?? ""));
        if (r.kind === "append") this.aiCaption += r.text;
        else if (r.kind === "restart") this.aiCaption = r.text;
        else return;
        this.updateAiCaption();
        return;
      }

      // The turn is over; the next `text` starts a new caption.
      case "complete":
        this.endAiTurn();
        return;
      case "utterance":
        this.pushHeard("self", String(msg.text ?? ""));
        return;
      case "transcript":
        this.pushHeard("person", String(msg.data ?? ""), String(msg.speaker ?? "") || undefined);
        return;

      case "processing": {
        const a = String(msg.activity ?? "");
        if (a === "speaker" || a === "board" || a === "interpret") {
          const active = msg.active === true;
          // The BOARD cue is what the student's loading bar reads, and the real
          // client fades it over 500ms — deliberately, so the Board Manager's
          // sub-second busy flickers are absorbed and the bar reads as one
          // continuous "still working" (home.tsx ~:2592, `duration-500`).
          // Stamp the moment it drops so `boardVisiblyBusy` can model that.
          if (a === "board") this.boardClearedAt = active ? null : this.now();
          this.busy = { ...this.busy, [a]: active };
        }
        return;
      }

      case "sleep_state_change":
        this.sleepState = String((msg.data as { state?: string })?.state ?? "") || null;
        return;

      default:
        return;
    }
  }

  /** Fold a whole batch, oldest first. */
  applyAll(msgs: Iterable<OutboundMessage>): void {
    for (const m of msgs) this.apply(m);
  }

  // ── the child's own actions, reflected locally ──────────────────────────

  /** Step back through boards already seen (the quick row's Back). */
  goBack(): boolean {
    if (!historyCanGoBack(this.history)) return false;
    this.history = historyGoBack(this.history);
    this.onBoardShown();
    return true;
  }

  goForward(): boolean {
    if (!historyCanGoForward(this.history)) return false;
    this.history = historyGoForward(this.history);
    this.onBoardShown();
    return true;
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
  }

  /** Navigate within the shown board (a link button, Back, Home). */
  navigate(action: { type: "to"; pageId: string } | { type: "back" } | { type: "home" }): boolean {
    const { nav, landed } = pageNavReducer(this.nav, this.board(), action);
    this.nav = nav;
    this.relayout();
    return landed !== null;
  }

  setBuilderOpen(open: boolean): void {
    this.builderOpen = open;
  }

  /** An answered overlay is gone from the screen. */
  clearBinaryChoice(): void {
    this.binaryChoice = null;
  }

  // ── reads ───────────────────────────────────────────────────────────────

  /** The board actually on screen: a loaded pre-built one, else the AI's. */
  board(): ParsedBoardData | null {
    return this.loadedBoard?.board ?? this.aiBoard();
  }

  aiBoard(): ParsedBoardData | null {
    return historyCurrentBoard(this.history);
  }

  page() {
    return resolvePage(this.board(), this.nav);
  }

  grid() {
    return pageGrid(this.board(), this.page(), DEFAULT_GRID);
  }

  /** The cells, in reading order. Blanks included — an empty cell is part of
   *  what the child sees, and where a new button can land. */
  cells(): readonly SlotState[] {
    return this.slots;
  }

  contextButtons(): readonly ContextButton[] {
    return this.context;
  }

  overlay(): BinaryChoice | null {
    return this.binaryChoice;
  }

  /** The fixed bottom row, from the same rule the real one draws from. */
  quickActions(isRTL = false): QuickActionSlot[] {
    return quickActionSlots(
      {
        boardMode: this.loadedBoard ? "db" : "ai",
        hasActiveApp: !!this.activeApp,
        currentTier: this.tier,
        isGuessingMode: this.guessing,
        inSentenceBuilder: this.builderOpen,
        showSpeakSlot: true,
        worldEngineGame: false,
        canGoBack: historyCanGoBack(this.history),
        canGoForward: historyCanGoForward(this.history),
        boardPaused: this.paused,
      },
      isRTL,
    );
  }

  /**
   * Is the board's LOADING BAR still showing?
   *
   * Not the same question as `busy.board`. The student never sees the raw flag —
   * they see a bar that fades out over 500ms, which by design swallows the
   * short false-blips between a failed Board Manager beat and its corrective
   * retry. A child looking at the screen during one of those sees an unbroken
   * "still working" bar, so the harness must too, or it will let the simulated
   * child react to a board the real one would still be waiting on.
   */
  boardVisiblyBusy(fadeMs = BOARD_BAR_FADE_MS): boolean {
    if (this.busy.board) return true;
    if (this.boardClearedAt === null) return false;
    return this.now() - this.boardClearedAt < fadeMs;
  }

  status() {
    return {
      guessing: this.guessing,
      builderOpen: this.builderOpen,
      activeApp: this.activeApp,
      paused: this.paused,
      tier: this.tier,
      loadedBoardName: this.loadedBoard?.name ?? null,
      busy: { ...this.busy },
      sleepState: this.sleepState,
      canGoBack: historyCanGoBack(this.history),
      canGoForward: historyCanGoForward(this.history),
      canGoBackPage: canGoBackPage(this.nav),
    };
  }

  /** What `button_press` must carry back up — the client's own board. */
  boardForPress(): ParsedBoardData | null {
    return this.board();
  }

  // ── internals ───────────────────────────────────────────────────────────

  private receive(board: ParsedBoardData): void {
    this.history = receiveBoard(this.history, board, { paused: this.paused });
    // While paused the arriving board is STORED, not shown, so the surface must
    // not move. `receiveBoard` already parked it ahead of the cursor; relaying
    // out here would draw a board the child asked to hold still.
    if (!this.paused) this.onBoardShown();
  }

  private onBoardShown(): void {
    if (!this.loadedBoard) this.nav = initPageNav(this.aiBoard());
    this.relayout();
  }

  private relayout(): void {
    const page = this.page();
    this.slots = layoutSlots(page?.buttons ?? [], this.grid());
  }

  private pushHeard(source: HeardLine["source"], text: string, speaker?: string): void {
    if (!text) return;
    this.heard.push({ source, text, at: this.stamp(), ...(speaker ? { speaker } : {}) });
  }

  /**
   * Keep the in-progress AI caption as ONE heard line that grows, rather than a
   * line per streamed chunk — a child hears one sentence, not seven fragments,
   * and a per-chunk log would make every turn look like a stutter.
   */
  private updateAiCaption(): void {
    if (!this.aiCaption.trim()) return;
    if (this.aiTurnIndex === null) {
      this.aiTurnIndex = this.heard.length;
      this.heard.push({ source: "ai", text: this.aiCaption, at: this.stamp() });
      return;
    }
    this.heard[this.aiTurnIndex] = { ...this.heard[this.aiTurnIndex], text: this.aiCaption };
  }

  private endAiTurn(): void {
    this.aiCaption = "";
    this.aiTurnIndex = null;
  }
}
