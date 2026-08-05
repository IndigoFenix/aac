// shared/world-engine/interaction/text/types.ts
//
// THE CLOSED CONTRACT of world-engine TEXT MODE (planning-docs/games/world-engine/
// text-mode.md §2). Everything the projection produces is a `TextEvent`; every
// command an AI/driver issues parses to a `TextCommand`. Lines are a RENDERING of
// events (render.ts), never the other way round — later drivers (net co-player,
// aria-live accessibility) consume events and never see a line.
//
// HOST-FREE by construction: type-only imports of the engine/view/quest-host
// shapes, no React, no DOM, no games-bridge. The boot (shared/world-engine/
// headless/) is written against `TextSessionDeps`, so the shapes below are a
// published seam — change them and the boot changes with them.

import type { WorldState } from "../../engine.js";
import type { RenderIntent } from "../../world-view.js";
import type { QuestPresenter } from "../quest/quest-host.js";
import type { Cardinal, Proximity } from "../dialogue/directions.js";
import type { BuilderNounEntry } from "../intent/builder-surface.js";

// ---------------------------------------------------------------------------
// §2 — the tag set. TAGS ARE PROTOCOL: uppercase ASCII English in every locale;
// only PAYLOADS go through the lang layer.
// ---------------------------------------------------------------------------

/** Stream tags — things that HAPPENED in the world while time ran.
 *
 *  `STOCK` is §6's sixth watch delta ("`WEAR`, `OPEN`, gated `STOCK`"), which
 *  §2's tag list — written before the delta table existed — does not carry. The
 *  set is closed, so this is the one place it can be reconciled: the producer
 *  lands with its step (⑩), and the tag lands with the producer. */
export type TextStreamTag =
  | "SAY"
  | "SILENT"
  | "TURN"
  | "ENTER"
  | "EXIT"
  | "DOING"
  | "MOVED"
  | "HOLD"
  | "WEAR"
  | "OPEN"
  | "STOCK"
  | "TOAST"
  | "GOAL"
  | "WON"
  | "POCKET"
  | "BOARD"
  | "CLOSE"
  | "TICK";

/** Answer tags — a reply to a question the driver asked. */
export type TextAnswerTag = "SCENE" | "LOOK" | "SELF" | "WHERE" | "WHO" | "WATCH" | "BUILDER" | "HELP";

/** Control tags — the harness talking about itself. */
export type TextControlTag = "OK" | "ERR" | "ASK" | "NOTE" | "CHEAT";

export type TextTag = TextStreamTag | TextAnswerTag | TextControlTag;

/** Width the tag column is padded to before the single separating space, so a
 *  payload always starts at column 7 and transcript diffs align. */
export const TAG_WIDTH = 6;

// ---------------------------------------------------------------------------
// Scene vocabulary (§2 API sketch, §3 visibility, §6 crowds)
// ---------------------------------------------------------------------------

/** What kind of thing a visible subject is. `place` is a landmark (a building
 *  outline), never an enumerable body — see §3 "places are landmarks". */
export type SubjectKind = "creature" | "object" | "place";

/** One thing the local viewer can see, in the words text mode narrates it with.
 *  Produced by visibility.ts (geometry + the filter) and stamped with a latched
 *  `textId` by scene-index.ts. */
export interface VisibleSubject {
  /** SIM id — the `state.avatars` / `state.objects` / `spec.buildings` key. */
  id: string;
  kind: SubjectKind;
  /** The latched session id the driver types (`mara`, `chair-3`). */
  textId: string;
  /** Known proper name, when the session has one for this body. */
  name?: string;
  /** Species id (creatures) / fixture kind or glyph head (objects). */
  species?: string;
  /** THE LEXICON HEAD `word` was resolved from — carried so a bucket can ask
   *  the lang layer for the plural and the article instead of guessing them
   *  back out of the rendered word. */
  head: string;
  /** The locale WORD for that species/kind — what a group line counts. */
  word: string;
  /** §3 proximity band, from directions.ts' vocabulary. */
  band: Proximity;
  cardinal: Cardinal;
  /** THE RAW BEARING from the viewer, degrees (atan2, y-down like the cardinal
   *  vocabulary). Carried because §6's `MOVED` hysteresis is stated in DEGREES
   *  ("cardinal swing ≥90°") and a four-word vocabulary cannot express it: a
   *  body drifting 2° across the north/east boundary changes its cardinal WORD
   *  without moving. Optional so a hand-built fixture need not compute one. */
  bearing?: number;
  /** Straight-line metres from the viewer. */
  distance: number;
  /** Building id the subject stands in, or null outdoors. */
  space: string | null;
  /** Rounded storey (the §3 same-storey clause). */
  floor: number;
  /** APPEARANCE SIGNATURE (§6) — only fields the renderer actually dresses the
   *  body from, so "visibly distinct" means *drawn* differently. */
  appearance: string[];
  /** THE DRESS, worded (§6 "two women in red draw water") — the garment colour
   *  the body is actually drawn in, when it wears an outfit override. Absent =
   *  the factory default, which distinguishes nothing and so is never said. */
  dress?: string;
  /** What it is doing, when the host supplied an `activityOf`. */
  activity?: { verb: string; object?: string };
  /** Sim ids of objects this body carries (`carriedBy`) — never `carryOf()`,
   *  which merges unseen bag contents (§6). */
  holding: string[];
  /** Places only: the building's wall colour word, and whether its interior is
   *  currently revealed (a landmark shows an outline; contents need a reveal). */
  color?: string;
  revealed?: boolean;
  /** Places only: does a door of this building stand physically open? One of
   *  the four things that make a place NOTABLE enough for its own line. */
  doorOpen?: boolean;
  /** Objects only: the eased LID swing, 0 (shut) → 1 (open). Renderer-visible
   *  (the lid is drawn), and the gate on a container's `contains` (§6: STOCK is
   *  narrated only while the box is open AND in view). */
  open?: number;
  /** Objects only, and only while the lid is open: the sim ids the container
   *  visibly holds. A shut box has no `contains` — the eye reads the lid. */
  contains?: string[];
}

/** Everything §3's filter admits this frame, plus who is looking. */
export interface VisibleScene {
  /** The viewer: the local avatar (or the spirit's parked stand-in). */
  me: { id: string; x: number; y: number; floor: number; space: string | null } | null;
  /** Bodies and objects in view (§3's four clauses, all four). */
  subjects: VisibleSubject[];
  /** Buildings within `closeR` — outline landmarks, not contents. */
  places: VisibleSubject[];
  /** Building ids whose interior is revealed to the viewer this frame. */
  revealed: ReadonlySet<string>;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/** One numbered button as text mode prints it — EXACTLY the page the presenter
 *  was handed, chrome numbered in (law ④). */
export interface TextBoardOption {
  /** 1-based press number, counting chrome. */
  n: number;
  /** The `select()` id (may be `board:more` / `board:back`). */
  id: string;
  label: string;
  glyph?: string;
  /** Printed quoted only when it differs from `label` (§7). */
  spokenText?: string;
  /** Set for the two chrome buttons so `more`/`back` can find them. */
  chrome?: "more" | "back";
  /** BUILDER only: this row is a MODIFIER — pressing it composes onto the head
   *  with a "." instead of adding a word (the SpeakMenu's own rail rule). */
  modifier?: boolean;
}

/** One sub-category chip on a BUILDER screen, as text mode prints it. `count`
 *  is how many EXEMPLAR faces the chip carries — the surface's own measure of
 *  how much lives behind it, and therefore of what a tap on it costs. */
export interface TextBuilderGroup {
  id: string;
  label: string;
  count: number;
}

/** One line of a SCENE block. `subject` = a NAMED individual, `group` = a crowd
 *  bucket (§6), `place` = a NOTABLE landmark's own line (§3), `place-group` =
 *  the rest of the skyline, counted rather than enumerated (law ⑤ applies to
 *  places too — see summarize.ts). */
export interface SceneEntry {
  kind: "subject" | "group" | "place" | "place-group";
  /** Named entries only. */
  textId?: string;
  /** Group entries only — how many bodies/places the bucket holds. */
  count?: number;
  /** Already pluralized by the caller when `count > 1` (the lang layer owns
   *  plurals; the formatter never appends an "s"). */
  word: string;
  /** The indefinite article for a SINGLETON bucket ("a chair, here east") —
   *  supplied by the caller because articles are grammar, not formatting.
   *  Absent ⇒ the word stands bare. */
  article?: string;
  band: Proximity;
  cardinal: Cardinal;
  /** Already-worded activity phrase ("eating an apple"), locale-resolved. */
  activity?: string;
  /** Extra facts (appearance words, door state) as short phrases. */
  detail?: string[];
  /** `place-group` only: this bucket is the COLLAPSED remainder — everything
   *  left of its kind, in every band ("81 more houses ring the town"). */
  collapsed?: boolean;
}

/**
 * THE UNIT OF OUTPUT. A discriminated union on `tag`; tests assert on these,
 * transcripts persist their rendering. Tags not yet produced by phase 1 are
 * declared anyway (the set is CLOSED, §2) so steps ⑧–⑪ add producers, never
 * protocol.
 */
export type TextEvent =
  // ── stream ───────────────────────────────────────────────────────────────
  /** A creature/player line, COPIED byte-for-byte off the bubble (law ②). */
  | { tag: "SAY"; who: string | null; text: string; glyph?: string }
  /** A `style:"thought"` bubble — visible silence is an EVENT (law ③). */
  | { tag: "SILENT"; who: string | null; text?: string; glyph?: string }
  /** A body turned away from the viewer. */
  | { tag: "TURN"; who: string; away: boolean }
  /** A TRACKED subject came into view (§6: a watch never grants visibility, but
   *  it re-fires this on return). `where` is the band + cardinal it appeared at. */
  | { tag: "ENTER"; who: string; where?: string }
  /** A tracked subject left view. `via` is the VISIBLE TRANSIT when the exit was
   *  a doorway ("into the blue house") — the whole trailing phrase, because
   *  "into" and "out of" are grammar and this layer's formatter knows none. */
  | { tag: "EXIT"; who: string; where?: string; via?: string }
  /** A watched body's (verb, object) changed. */
  | { tag: "DOING"; who: string; activity: string }
  /** Hysteretic band / space / cardinal-swing delta (§6). */
  | { tag: "MOVED"; who: string; band: Proximity; cardinal: Cardinal }
  /** Hands changed — from `carriedBy`, never `carryOf` (§6). */
  | { tag: "HOLD"; who: string; what: string | null }
  /** The renderer-visible dress changed (the live change of clothes). */
  | { tag: "WEAR"; who: string; what: string }
  /** A fixture's lid flipped. */
  | { tag: "OPEN"; what: string; open: boolean }
  /** §6's gated delta: what an OPEN, in-view container holds changed. */
  | { tag: "STOCK"; what: string; items: string[] }
  | { tag: "TOAST"; text: string; kind?: string }
  | { tag: "GOAL"; text: string; locked?: boolean }
  | { tag: "WON" }
  | { tag: "POCKET"; items: { label: string; glyph: string; count: number; selected: boolean }[] }
  | {
      tag: "BOARD";
      nodeId: string;
      board: "choice" | "acts";
      posedBy: string;
      /** The poser's line, TRANSLATED (never re-composed). */
      promptText: string;
      /** …and its composed glyph, printed beside it (a garble is the finding). */
      prompt?: string;
      options: TextBoardOption[];
    }
  | { tag: "CLOSE" }
  /** Exactly ONE per command (§5). `arrived`/`walking` close a TRAVEL settle
   *  (step ⑨); `metres` is how far the standing aim still has to go. */
  | {
      tag: "TICK";
      reason: "quiet" | "waited" | "capped" | "arrived" | "walking";
      seconds: number;
      metres?: number;
    }
  // ── answers ──────────────────────────────────────────────────────────────
  /** `count` = THINGS in view (bodies + objects); `places` = landmarks around
   *  you. Two counts, not one: a town is 13 things standing in a ring of 82
   *  houses, and a single number that says "95 in view" above eight printed
   *  lines is a lie about both. */
  | { tag: "SCENE"; place: string; count: number; places: number; entries: SceneEntry[] }
  | { tag: "LOOK"; textId: string; word: string; facts: string[] }
  | { tag: "SELF"; where: string; facts: string[] }
  /** Where a subject is, as directions. */
  | { tag: "WHERE"; textId: string; band: Proximity; cardinal: Cardinal; distance: number }
  /** The roster of the conversation the view publishes. */
  | { tag: "WHO"; members: string[] }
  /** One watch toggled, or (the `list` arm) the whole roster of watches. */
  | { tag: "WATCH"; textId: string; on: boolean }
  | { tag: "WATCH"; list: string[] }
  /**
   * ONE SENTENCE-BUILDER SCREEN, exactly as `builderSurfaceFor` served it at the
   * real grid budget (law ④). `partial` is the composition so far, `preview` its
   * TRANSLATION (never a re-composition), `complete` the surfacer's own verdict.
   * Numbered words carry `[glyph]` only where the drawn face differs from the
   * pressed key — a place is one word that draws as a composed icon.
   */
  | {
      tag: "BUILDER";
      partial: string;
      preview: string;
      complete: boolean;
      options: TextBoardOption[];
      groups?: TextBuilderGroup[];
      tabs?: string[];
      /** The tab / group chip currently open, when the view is filtered. */
      tab?: string;
      group?: string;
      /** 1-based page of the active listing, and how many it pages into. */
      page?: number;
      pages?: number;
    }
  | { tag: "HELP"; commands: string[] }
  // ── control ──────────────────────────────────────────────────────────────
  | { tag: "OK"; text: string }
  | { tag: "ERR"; text: string }
  | { tag: "ASK"; question: string; options: string[] }
  | { tag: "NOTE"; text: string }
  /** TODO step ⑪ (cheat channel) — every use MUST leave this marker (law ⑦). */
  | { tag: "CHEAT"; text: string };

/**
 * Events plus the lines they render to — what `command()` hands back.
 *
 * `cheatLines` IS A DIFFERENT CHANNEL (law ⑦): the cheat channel's output never
 * joins `lines`, so a transcript keeps its shape and a reviewer can still see —
 * from the one `CHEAT` marker that DOES land in the stream — that the tester
 * peeked. A driver that concatenates the two has chosen to; nothing here does.
 */
export interface TextFrame {
  events: TextEvent[];
  lines: string[];
  cheatLines?: string[];
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/** The `build …` sub-grammar (step ⑧). One verb, six operations. */
export type BuildOp = "show" | "word" | "tab" | "group" | "undo" | "clear" | "play";

export type TextCommand =
  /** No target = the whole scene. `look chair 2` is accepted shorthand (§4). */
  | { kind: "look"; target?: string }
  | { kind: "scene" }
  | { kind: "self" }
  | { kind: "board" }
  /** Words are joined with " + " into one composed glyph sentence. */
  | { kind: "say"; words: string[] }
  /** By 1-based number OR by label; chrome is pressable either way. */
  | { kind: "press"; index?: number; label?: string }
  | { kind: "more" }
  | { kind: "back" }
  /** Steps EXACTLY this many sim-seconds (§5). */
  | { kind: "wait"; seconds: number }
  | { kind: "help" }
  // ── step ⑧: the sentence builder ────────────────────────────────────────
  | { kind: "builder" }
  | { kind: "build"; op: BuildOp; arg?: string }
  // ── step ⑨: movement (the pointer path, and nothing else) ───────────────
  /** `approach` aims at `approachAim`'s stop-short point; `go` at the thing. */
  | { kind: "go"; target: string; approach?: boolean }
  | { kind: "stop" }
  /** Parsed, deliberately unwired — see session.ts `sendEvents`. */
  | { kind: "send"; creature: string; target: string }
  | { kind: "where"; target: string }
  | { kind: "who" }
  // ── step ⑩: watching ───────────────────────────────────────────────────
  | { kind: "watch"; target: string }
  /** `unwatch all` arrives as `target: "all"`. */
  | { kind: "unwatch"; target: string }
  | { kind: "watching" }
  // ── step ⑪: the cheat channel (a DIFFERENT prefix, law ⑦) ───────────────
  | { kind: "cheat"; name: string; arg?: string };

/** What `parseCommand` returns when the input isn't a command. */
export interface TextParseError {
  error: string;
}

export type TextParseResult = TextCommand | TextParseError;

export function isParseError(r: TextParseResult): r is TextParseError {
  return (r as TextParseError).error !== undefined;
}

// ---------------------------------------------------------------------------
// The boot seam — the shapes shared/world-engine/headless/ is written against
// ---------------------------------------------------------------------------

/** One frame's worth of what a RENDERER is given (law ①): nothing here is
 *  readable that a GL frame does not consume. */
export interface TextViewProbe {
  state: WorldState | null;
  intent: RenderIntent | null;
  dt: number;
  worldToScreen(p: { x: number; y: number }): { x: number; y: number };
}

/** The headless view, seen from the projection side. */
export interface TextViewLike {
  probe(): TextViewProbe;
}

/**
 * THE CHEAT HOST (law ⑦) — a DIFFERENT OBJECT from `host`, wired separately and
 * gated separately, so the ordinary command path structurally cannot reach it.
 * Every method optional: a boot that hands over none still runs the harness,
 * which is the point of building this last.
 */
export interface TextCheatHost {
  conversationAudit?(): unknown;
  scopeTree?(): unknown;
  stockAudit?(): unknown;
  carryOf?(cid: string): unknown;
  debugProbe?(): string;
}

/**
 * Everything `createTextModeSession` needs from the boot. STRUCTURAL on purpose:
 * `host` is the quest-host entry points the command set reaches (law ⑥ — no new
 * sim path), typed by shape so this module never value-imports quest-host.
 */
export interface TextSessionDeps {
  host: {
    speak(sentence: string, opts?: { targetId?: string }): void;
    select(id: string): void;
  };
  view: TextViewLike;
  /** Advance EXACTLY one fixed frame. The boot owns the clock (§5). */
  stepFrame(): void;
  /** Seconds per frame (1/60 in the boot). */
  frameDt: number;
  /** Register a presenter that FANS OUT beside the real one — never replaces it. */
  addPresenterTap(p: Partial<QuestPresenter>): void;
  locale?: string;
  /** Builder grid budget — the REAL capacity `builderSurfaceFor` ranks into, and
   *  the page size a tab listing pages at (law ④). */
  grid?: number;
  settle?: { quietS?: number; capS?: number };
  /** "What is X doing" — host-side `creatureActivity`, injected structurally. */
  activityOf?: (cid: string) => { verb: string; object?: string } | undefined;
  /** A body's known proper name, when the session knows one (§4 text ids). */
  nameOf?: (cid: string) => string | undefined;
  /** WHOM THE PLAYER IS ADDRESSING — the host's own resolved addressee (rank ⓪
   *  of law ⑤ alongside a conversation member). The host is the authority; this
   *  layer never re-derives it. */
  addresseeOf?: () => string | null | undefined;
  // ── step ⑨: movement. THE POINTER PATH AND NOTHING ELSE (law ⑥) ─────────
  /** Feed the gaze/pointer at a WORLD point. The text view's `screenToWorld` is
   *  the identity, so a world point IS the client pixel — same smoother, same
   *  dwell, same aim arbitration as GL. */
  look?: (worldX: number, worldY: number) => void;
  clearLook?: () => void;
  /** SPIRIT SCOPE: the player is a bodiless observer, so `go`/`approach` have
   *  nothing to walk. Declared here rather than sniffed, because "am I embodied"
   *  is a fact about the SESSION, not about the frame. */
  spirit?: boolean;
  travel?: { arriveR?: number; capS?: number };
  // ── step ⑧: the builder's noun library ─────────────────────────────────
  /** The host's speakable nouns (the presenter's `nouns` push). Absent ⇒
   *  `builderSurfaceFor`'s own curated fallback, which is what an out-of-game
   *  builder offers. */
  nouns?: BuilderNounEntry[];
  // ── step ⑩ ─────────────────────────────────────────────────────────────
  watchCap?: number;
  // ── step ⑪: the cheat channel ──────────────────────────────────────────
  cheatHost?: TextCheatHost;
  /** OFF by default. `--cheats` on the CLI is the only thing that turns it on. */
  cheats?: boolean;
}

/** The law-④ measurement: what reaching an utterance actually COST. */
export interface TextSessionStats {
  /** Driver lines that parsed and executed. */
  commands: number;
  /** Taps on a word — every `build …` and every `press …`. */
  presses: number;
  /** Screens shown — every BOARD and every BUILDER block. */
  screens: number;
}

/** The live text session. */
export interface TextModeSession {
  /** Parse + execute + settle. Always ends with exactly one TICK on success. */
  command(input: string): TextFrame;
  /** Execute an already-parsed command (the same path `command` takes). */
  perform(cmd: TextCommand): TextFrame;
  /** Take whatever the world produced since the last drain WITHOUT stepping. */
  drain(): TextFrame;
  /** The board currently open, as text mode last printed it. */
  currentBoard(): TextEvent | null;
  /** Sim id ⇄ text id, for a driver that wants to address bodies directly. */
  textIdOf(simId: string): string | undefined;
  simIdOf(textId: string): string | undefined;
  /** The running cost of this session (the CLI's footer). */
  sessionStats(): TextSessionStats;
  /** Text ids currently watched (§6), in the order they were added. */
  watching(): string[];
}

/** Default settle policy (§5). */
export const SETTLE_QUIET_S = 0.75;
export const SETTLE_CAP_S = 8;
/** `wait` with no argument. */
export const WAIT_DEFAULT_S = 5;
/** Named individuals per scene before the rest become crowd buckets (law ⑤). */
export const NAMED_CAP = 6;
/** Crowd buckets printed before the remainder collapses into one line. Without
 *  it a town of many species/activities trades one flood for another. */
export const GROUP_CAP = 8;
/** TOTAL place lines a scene may print — notable landmarks plus their buckets.
 *  A skyline is context, not a roll-call: 82 houses must never out-shout the 13
 *  things actually standing in front of you. */
export const PLACE_LINE_CAP = 8;
/** Law ⑤'s cap, under the name the build order uses. */
export const NAME_CAP = NAMED_CAP;
/** A travel settle runs to ARRIVAL, capped here (§5). */
export const TRAVEL_CAP_S = 60;
/** "Arrived" — how near the standing aim's own point the driven body must get
 *  before the walk is over. One body's length, not a stopping DISTANCE: for
 *  `approach` the aim point is already `approachAim`'s stop-short spot, so the
 *  same number means "reached conversation distance" there. */
export const ARRIVE_R = 1.5;
/** Watches held at once (§6). The 9th is refused, by name. */
export const WATCH_CAP = 8;
/** A cardinal SWING this wide is a `MOVED` (§6's hysteresis): the vocabulary has
 *  four words, so one step around the compass is exactly 90°. */
export const MOVED_SWING_DEG = 90;
