// client/src/features/call/IframeQuestSurface.tsx
//
// THE clinician surface for an iframe world game (CallGame.engine
// "iframe-quest", e.g. the Dollhouse) — the SAME component and the SAME layout
// whether the game was opened from the call panel's game room or attached to a
// live call. A game must not look like a different program depending on how it
// was reached, so the call's own chrome (peer tiles, call controls) is passed
// in as OVERLAY slots rather than laid out around the surface.
//
// It is the platform side of the games bridge:
//
//   - ferries opaque world payloads between the iframe and the call
//     transports (unreliable `world_data` via the mesh world channel,
//     reliable `world_cmd` via the call data channel),
//   - computes the multiplayer role (owner/follower) from the game's nominated
//     host + the MESH-CONNECTED peer set, and (re)sends `world_session`,
//   - shows the game's pinned board options as a real AAC-button dock
//     (clicks are voiced locally and reported back as `board_option_selected`),
//   - hosts an engine-driven sentence builder (builder_state → builder_surface,
//     Play → glyph_input) — no LLM path on the clinician: an unparsable
//     sentence is simply cleared.
//
// GEOMETRY LAW: the iframe's box NEVER changes for the life of the session. The
// game re-lays-out its whole 3D canvas on resize, so chrome that appears and
// disappears (the board dock arriving when the game pins options, the builder
// panel growing as words are added) reads on screen as a flicker. Hence: the
// dock keeps its width whether or not it has options, and the builder is an
// absolutely-positioned overlay with a fixed height.
//
// The clinician has NO gaze — mouse input reaches the iframe natively, so
// there is no gaze forwarding and no dwell anywhere in this UI.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Delete, Loader2, MessageSquarePlus, Play, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useLanguage } from "@/contexts/LanguageContext";
import { cn } from "@/lib/utils";
import { Glyph } from "@/components/Glyph";
import { useClinicianBoardDeps } from "@/components/syntAACx/use-clinician-board-deps";
import { BoardButtonVisual } from "@client-shared/board/BoardButtonVisual";
import { createBridgeBuilderBackend, type BridgeBuilderBackend } from "@client-shared/game/engine-builder";
import { resolveWorldOwner } from "@shared/social-world/npc-conversation-logic";
import type { CallGame } from "@shared/realtime-events";
import type { BoardOption, BuilderSurface, BuilderWord, GameMessage } from "@shared/games-bridge";
import type { WorldNetMessage } from "@shared/world-engine/index";
import { useCall } from "./CallContext";
import CallGameEmbed, { type CallGameEmbedHandle } from "./CallGameEmbed";

/** App language code → BCP-47 tag for speechSynthesis (mirrors CallContext /
 *  useTextToSpeech — each keeps its own copy of this small map). */
const SPEECH_LANG: Record<string, string> = {
  en: "en-US", he: "he-IL", ar: "ar-SA", es: "es-ES", fr: "fr-FR", de: "de-DE",
  ru: "ru-RU", zh: "zh-CN", ko: "ko-KR", yue: "zh-HK", pt: "pt-BR",
};

// The engine's identity palette (deep import — pure module, no three/GL):
// the SAME color tints this peer's spark light in-world, so tiles and sparks
// match. Re-exported under the old name for existing call sites.
export { colorHexForId as colorForPeerId } from "@shared/world-engine/peer-colors";

/** Debounce for builder_state requests — matches the AAC builder's cadence. */
const SURFACE_DEBOUNCE_MS = 150;

/** How long the game may take to say `ready` before we tell the user it looks
 *  stuck rather than slow. Generous: the dollhouse is a ~2 MB bundle and a cold
 *  first load on a tablet is genuinely slow. */
const GAME_SLOW_MS = 20_000;

interface Props {
  game: CallGame;
  /** Detach the game (back to plain video), or close the solo preview. */
  onExit?: () => void;
  /**
   * False for a SOLO preview outside a call (the call-panel game room's "open by
   * myself"): the multiplayer identity is never announced, so the game stays in
   * its single-player path. The transport ferry below stays wired either way —
   * with no peers on the mesh it simply carries nothing.
   */
  multiplayer?: boolean;
  /** Call controls, rendered in the surface's own top bar beside the builder
   *  and exit buttons. Overlay chrome: it never reflows the game. */
  controls?: ReactNode;
  /** Peer video tiles, floated over the start edge of the game. */
  peers?: ReactNode;
}

export default function IframeQuestSurface({ game, onExit, multiplayer = true, controls, peers }: Props) {
  const { t, language } = useLanguage();
  const {
    selfPersonId,
    participants,
    remoteStreams,
    sendWorld,
    sendData,
    worldHub,
    worldCmdHub,
  } = useCall();
  const boardDeps = useClinicianBoardDeps();

  const embedRef = useRef<CallGameEmbedHandle | null>(null);
  const [ready, setReady] = useState(false);
  // A packaged game is a multi-megabyte bundle behind a licensed static route:
  // it can be slow, and it can fail outright (unbuilt game, expired license,
  // blocked iframe) — in which case the embed is just a black rectangle. Say
  // which of the two is happening instead of leaving a blank screen.
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (ready) return;
    const timer = setTimeout(() => setSlow(true), GAME_SLOW_MS);
    return () => clearTimeout(timer);
  }, [ready]);

  // Board dock: the options the game pinned via set_board_options.
  const [boardOptions, setBoardOptions] = useState<BoardOption[] | null>(null);
  const [boardPrompt, setBoardPrompt] = useState<string | undefined>(undefined);

  // Sentence builder state.
  const [builderOpen, setBuilderOpen] = useState(false);
  const [builderWords, setBuilderWords] = useState<BuilderWord[]>([]);
  const [surface, setSurface] = useState<BuilderSurface | null>(null);
  const [category, setCategory] = useState<string | undefined>(undefined);
  const [playing, setPlaying] = useState(false);

  // Builder transport — correlates builder_state/glyph_input with their
  // answers; created once, fed every game message below.
  const backendRef = useRef<BridgeBuilderBackend | null>(null);
  if (!backendRef.current) {
    backendRef.current = createBridgeBuilderBackend((msg) => embedRef.current?.send(msg));
  }

  // Local TTS — the clinician voices board presses / built sentences in the
  // game's locale (= the clinician UI language, which the embed sends as init
  // locale).
  const speakText = useCallback((text: string) => {
    const trimmed = text.trim();
    if (!trimmed || typeof window === "undefined" || !("speechSynthesis" in window)) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(trimmed);
    utterance.lang = SPEECH_LANG[language] ?? language;
    window.speechSynthesis.speak(utterance);
  }, [language]);

  // ── Transport ferry ────────────────────────────────────────────────────────

  // Inbound peer world state (mesh "world" channel) → into the iframe.
  useEffect(() => {
    return worldHub.subscribe((fromId, msgs) => {
      embedRef.current?.send({ type: "world_data", fromId, msgs });
    });
  }, [worldHub]);

  // Inbound reliable world-cmd envelopes → into the iframe. Drop commands for
  // other games and commands addressed to a different peer.
  useEffect(() => {
    return worldCmdHub.subscribe((fromId, m) => {
      if (m.gameId !== game.appId) return;
      if (m.toId && m.toId !== selfPersonId) return;
      embedRef.current?.send({ type: "world_cmd", fromId, cmd: m.cmd });
    });
  }, [worldCmdHub, game.appId, selfPersonId]);

  // Game → platform: outbound world payloads onto the call transports, plus
  // every message into the builder backend's correlation maps.
  const handleGameMessage = useCallback((msg: GameMessage) => {
    backendRef.current?.handleGameMessage(msg);
    if (msg.type === "world_data") {
      sendWorld(msg.msgs as WorldNetMessage[]);
    } else if (msg.type === "world_cmd") {
      sendData({
        k: "world-cmd",
        gameId: game.appId,
        cmd: msg.cmd,
        ...(msg.toId ? { toId: msg.toId } : {}),
        at: Date.now(),
      });
    }
  }, [sendWorld, sendData, game.appId]);

  // ── Multiplayer session identity ───────────────────────────────────────────

  // The game's nominated host owns the sim when they're in the call (normally
  // the clinician who started the game room); otherwise the role falls back to
  // an election over the MESH-CONNECTED set ([self, ...remoteStreams]) — a set
  // that exists symmetrically on every client (the conversation roster does NOT
  // reach AAC peers), so all peers converge on the same owner. A brief
  // dual-owner window while streams are still connecting is fine.
  const peerIds = useMemo(() => [...remoteStreams.keys()].sort(), [remoteStreams]);
  const hostPersonId = game.hostPersonId;

  useEffect(() => {
    if (!multiplayer || !ready || !selfPersonId) return;
    const role = resolveWorldOwner(selfPersonId, peerIds, hostPersonId) === selfPersonId ? "owner" : "follower";
    const peers = peerIds.map((id) => {
      const name = participants.find((p) => p.personId === id)?.name;
      return { id, ...(name ? { name } : {}) };
    });
    embedRef.current?.send({ type: "world_session", selfId: selfPersonId, role, peers });
  }, [multiplayer, ready, selfPersonId, peerIds, participants, hostPersonId]);

  // ── Board dock ─────────────────────────────────────────────────────────────

  const handleBoardOptions = useCallback((options: BoardOption[] | null, prompt?: string) => {
    setBoardOptions(options);
    setBoardPrompt(options ? prompt : undefined);
  }, []);

  const pressOption = useCallback((opt: BoardOption) => {
    // The platform voices the press; `voiced: true` tells the game to only
    // execute it (same contract as the AAC's student-voice path).
    speakText(opt.spokenText || opt.label);
    embedRef.current?.send({ type: "board_option_selected", id: opt.id, voiced: true });
  }, [speakText]);

  // ── Sentence builder ───────────────────────────────────────────────────────

  // Composed working sentence: canonical engine keys joined by "+" (the
  // grammar the game's parser splits on).
  const glyphString = useMemo(() => builderWords.map((w) => w.key).join("+"), [builderWords]);

  // Debounced surface request per builder change. Monotonic sequence so a late
  // answer can't clobber a newer one; null (timeout/absent game) clears the
  // grid rather than hanging.
  const surfaceSeqRef = useRef(0);
  useEffect(() => {
    if (!builderOpen || !ready) return;
    const seq = ++surfaceSeqRef.current;
    const timer = setTimeout(() => {
      void backendRef.current?.requestSurface(glyphString, category).then((s) => {
        if (surfaceSeqRef.current !== seq) return; // stale answer
        setSurface(s);
      });
    }, SURFACE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [builderOpen, ready, glyphString, category]);

  const addWord = useCallback((w: BuilderWord) => {
    setBuilderWords((cur) => [...cur, w]);
  }, []);

  const backspace = useCallback(() => {
    setBuilderWords((cur) => cur.slice(0, -1));
  }, []);

  const clearSentence = useCallback(() => {
    setBuilderWords([]);
  }, []);

  const playSentence = useCallback(async () => {
    const glyph = glyphString;
    if (!glyph || playing) return;
    setPlaying(true);
    try {
      const result = await backendRef.current?.play(glyph);
      // Parsed: voice the engine's own rendering. Unparsed / no answer: no LLM
      // fallback on the clinician — just clear and move on.
      if (result?.parsed && result.spokenText) speakText(result.spokenText);
    } finally {
      setPlaying(false);
      setBuilderWords([]);
    }
  }, [glyphString, playing, speakText]);

  const categories = surface?.categories ?? [];

  return (
    <div className="flex h-full w-full min-h-0 bg-black">
      {/* The game. Its box is fixed for the session — every piece of chrome
          below is an overlay inside it, or the constant-width dock beside it. */}
      <div className="relative flex-1 min-w-0">
        <CallGameEmbed
          ref={embedRef}
          gameId={game.appId}
          src={game.src ?? `/games/${game.appId}/`}
          onMessage={handleGameMessage}
          onBoardOptions={handleBoardOptions}
          onClose={() => onExit?.()}
          onReady={() => setReady(true)}
          className="h-full w-full bg-black"
        />

        {/* Until the game says `ready` the iframe is a black rectangle — name
            what is happening, and after a while say it looks stuck. */}
        {!ready && (
          <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-black px-6 text-center">
            <Loader2 className="h-8 w-8 animate-spin text-white/70" aria-hidden="true" />
            <div className="text-sm text-white/80">
              {game.name ?? t("socialWorld.title")}
            </div>
            <div className="text-xs text-white/50" role="status">
              {slow ? t("socialWorld.gameStuck") : t("common.loading")}
            </div>
          </div>
        )}

        {/* Peer video, floated over the start edge (in a call; nothing solo). */}
        {peers && <div className="absolute top-2 start-2 z-10 w-28">{peers}</div>}

        {/* Top-end bar: the call's own controls, then the builder toggle and
            exit. One bar, same place, in a call or alone. */}
        <div className="absolute top-2 end-2 z-10 flex items-center gap-2">
          {controls}
          <button
            type="button"
            onClick={() => setBuilderOpen((o) => !o)}
            aria-pressed={builderOpen}
            aria-label={t("socialWorld.builderTitle")}
            className={cn(
              "flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-semibold text-white shadow",
              builderOpen ? "bg-amber-500/90 text-gray-900" : "bg-white/15 hover:bg-white/25",
            )}
            data-testid="game-builder-toggle"
          >
            <MessageSquarePlus className="h-4 w-4" aria-hidden="true" />
            {t("socialWorld.builderTitle")}
          </button>
          {onExit && (
            <button
              type="button"
              onClick={onExit}
              className="rounded-lg bg-red-600/90 px-3 py-2 text-sm font-semibold text-white shadow hover:bg-red-600"
            >
              {t("socialWorld.exit")}
            </button>
          )}
        </div>

        {/* Sentence builder — an OVERLAY at a fixed height, so composing a
            sentence never resizes the game underneath it. */}
        {builderOpen && (
          <div className="absolute inset-x-0 bottom-0 z-10 flex h-[45%] flex-col gap-2 border-t border-white/10 bg-black/80 p-2 text-white">
          {/* Composed sentence strip + actions. */}
          <div className="flex items-center gap-2">
            <div className="flex min-h-[3rem] flex-1 flex-wrap items-center gap-1 rounded-lg bg-white/10 px-2 py-1">
              {builderWords.length === 0 ? (
                <span className="text-sm text-white/50">{t("socialWorld.builderEmpty")}</span>
              ) : (
                builderWords.map((w, i) => (
                  <span
                    key={`${w.key}-${i}`}
                    className="flex items-center gap-1 rounded bg-white/15 px-1.5 py-0.5 text-sm"
                  >
                    {w.glyph && (
                      <span className="inline-block h-6 w-6">
                        <Glyph glyph={w.glyph} noBackground ariaLabel={w.label} />
                      </span>
                    )}
                    {w.label}
                  </span>
                ))
              )}
            </div>
            <Button
              type="button"
              size="icon"
              variant="secondary"
              onClick={backspace}
              disabled={builderWords.length === 0}
              aria-label={t("socialWorld.builderBackspace")}
            >
              <Delete className="h-4 w-4" />
            </Button>
            <Button
              type="button"
              size="icon"
              variant="secondary"
              onClick={clearSentence}
              disabled={builderWords.length === 0}
              aria-label={t("socialWorld.builderClear")}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
            <Button
              type="button"
              variant={surface?.complete ? "default" : "secondary"}
              onClick={() => { void playSentence(); }}
              disabled={builderWords.length === 0 || playing}
              aria-label={t("socialWorld.builderPlay")}
            >
              <Play className="me-1.5 h-4 w-4" aria-hidden="true" />
              {t("socialWorld.builderPlay")}
            </Button>
          </div>

          {/* Category chips (engine-advertised buckets; labels are the engine's
              own language-invariant category names). */}
          {categories.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                onClick={() => setCategory(undefined)}
                aria-pressed={category === undefined}
                className={cn(
                  "rounded-full px-3 py-1 text-xs font-medium transition",
                  category === undefined ? "bg-amber-400 text-gray-900" : "bg-white/15 hover:bg-white/25",
                )}
              >
                {t("socialWorld.builderAll")}
              </button>
              {categories.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setCategory((cur) => (cur === c ? undefined : c))}
                  aria-pressed={category === c}
                  className={cn(
                    "rounded-full px-3 py-1 text-xs font-medium transition",
                    category === c ? "bg-amber-400 text-gray-900" : "bg-white/15 hover:bg-white/25",
                  )}
                >
                  {c}
                </button>
              ))}
            </div>
          )}

          {/* Word grid — ranked engine surface for the current partial sentence.
              It SCROLLS inside the panel's fixed height; a longer or shorter
              surface must never change the panel's size. */}
          <div className="flex min-h-0 flex-1 flex-wrap content-start gap-2 overflow-y-auto">
            {(surface?.buttons ?? []).map((w) => (
              <button
                key={w.key}
                type="button"
                onClick={() => addWord(w)}
                className={cn(
                  "flex w-24 flex-col items-center gap-1 rounded-lg bg-white/10 p-2 text-xs hover:bg-white/20",
                  w.present && "ring-2 ring-emerald-400/80",
                )}
              >
                {w.glyph ? (
                  <span className="block h-10 w-10">
                    <Glyph glyph={w.glyph} noBackground ariaLabel={w.label} />
                  </span>
                ) : null}
                <span className="max-w-full truncate">{w.label}</span>
              </button>
            ))}
          </div>
          </div>
        )}
      </div>

      {/* Board dock — the game's pinned options as a real AAC-button grid (up
          to 8, 2×4). ALWAYS mounted at a constant width: the dollhouse clears
          and re-pins its board as the focus moves, and a dock that came and
          went with it resized the game on every change. Empty is a state, not
          an absence. */}
      <div
        className="flex w-64 shrink-0 flex-col gap-1 bg-black/40 p-2"
        aria-label={t("socialWorld.boardDock")}
      >
        <div className="truncate px-1 text-center text-xs text-white/70">
          {(boardOptions && boardOptions.length > 0 && boardPrompt) || t("socialWorld.boardDock")}
        </div>
        <div
          className="grid min-h-0 flex-1 grid-cols-2 gap-2"
          style={{ gridTemplateRows: "repeat(4, minmax(0, 1fr))" }}
        >
          {(boardOptions ?? []).slice(0, 8).map((opt) => (
            <BoardButtonVisual
              key={opt.id}
              button={{ label: opt.label, glyph: opt.glyph }}
              deps={boardDeps}
              variant="board"
              onClick={() => pressOption(opt)}
              iconFontSize="2.25rem"
              textFontSize="0.8rem"
            />
          ))}
        </div>
      </div>
    </div>
  );
}
