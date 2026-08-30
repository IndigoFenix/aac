/**
 * Dollhouse — the shipped spirit-dollhouse game (/games/dollhouse/).
 *
 * The spirit-dollhouse boot path ported out of world-lab: the bundled
 * `game.spec.json` (an `aivota-world` document — town scope, `initial_focus`
 * house, four defined creatures + items, avatar "spirit") loads through the
 * engine's manifest gate and boots the living-town quest host with the SPIRIT
 * LADDER over the flat provider, starting at the structure rung — the
 * dollhouse cutaway camera on the focus house (quest-boot.ts).
 *
 * Runs standalone (plain mouse/pointer) or embedded in the platform
 * (games-bridge): `ready` on boot, `init` for locale, inbound `gaze` fed into
 * the SAME aim pipeline the mouse drives, `pause`/`resume`, `request_close`.
 *
 * EMBEDDED, NOTHING renders beside the stage — the viewscreen fills the whole
 * iframe (the screen edge is the AAC's, reserved for its sidebar / video-chat
 * tiles). The engine's response board moves onto the AAC's 8-button sidebar:
 * board views go up as `set_board_options` (paged 7+More when they overflow),
 * presses come back as `board_option_selected`, and outside sentences arrive
 * as `glyph_input` (answered with a `glyph_result` parse verdict). The
 * Family/City/Pocket data the standalone side panel draws goes up as generic
 * `world_hud` sections for the AAC to render over its own button sidebar.
 * Standalone keeps the whole panel in-iframe, unchanged.
 */
import { avatarKind, loadWorldManifest, type LoadedWorld } from "@shared/world-engine/kernel/manifest";
import { applyWorldCreatureMods } from "@shared/world-engine/creatures/world-mods";
import { parseWorldCommand } from "@shared/world-engine/net";
import { ECONOMY_MODULE } from "@shared/world-engine/kernel/modules/economy/index";
import type { CityHudChip, FamilyHudEntry, PocketEntry, QuestBoardView } from "@shared/world-engine/interaction/quest/quest-host";
import { familyStateGlyph } from "@shared/world-engine/interaction/quest/family-hud";
import { parseSentence, type IntentKind } from "@shared/world-engine/interaction/intent/parse-intent";
import { builderSurfaceFor, type BuilderNounEntry, type BuilderSurfaceOpts } from "@shared/world-engine/interaction/intent/builder-surface";
import { languageFor, translateGlyph } from "@shared/world-engine/interaction/lang/index";
import { baseWord } from "@shared/world-engine/interaction/lang/core";
import {
  onPlatformMessage, sendToParent,
  type BoardOption, type GameMessageInput, type PlatformMessage,
} from "@shared/games-bridge";
import { createNpcVoice } from "@shared/world-engine/npc-voice";
import { GazeSmoother } from "@shared/gaze-kit";
import { mountBoardIsland, type BoardIsland, type NounEntry } from "./board-island";
import { bootLivingTown, type QuestBoot, type SharedBoard, type BoardHandlers } from "./quest-boot";
import { onPortraitsBaked, requestPortraits } from "./portraits";
import specJson from "./game.spec.json";

const GAME_ID = "dollhouse";
const VERSION = "1.0.0";

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const viewEl = $<HTMLDivElement>("view");
const statusEl = $<HTMLSpanElement>("status");

const embedded = window.parent !== window;
if (embedded) document.body.classList.add("embedded"); // hides the debug status bar

// ── THE BUTTON BOARD — the AAC's own chrome.
// STANDALONE: a `.quest-boardpanel` sibling of the viewscreen, mounted ONCE and
// always visible (mirrors the real AAC layout on a dev bench).
// EMBEDDED: NO panel is mounted at all — `#view` fills the whole iframe; that
// screen edge belongs to the AAC (its sidebar / video-chat tiles). The island
// goes HEADLESS instead (see mountIsland below). ─────────────────────────────
let boardHandlers: BoardHandlers | null = null;

// ── EMBEDDED sidebar takeover: the engine's response board leaves the iframe
// for the AAC's 8-button sidebar.
const PAGE_OPTION_ID = "__dollhouse_page";
const SIDEBAR_CAP = 8; // the AAC sidebar holds 8 buttons
const PER_PAGE = SIDEBAR_CAP - 1; // overflow pages show 7 options + the More pager

let bridgeView: QuestBoardView | null = null; // the view currently on the sidebar
let bridgePage = 0; // paging cursor — per view (reset when a new view arrives)

/** The current page of `view` as sidebar options. A view that fits (≤8) goes
 *  whole; an overflowing one pages 7-at-a-time with an 8th "More" pager slot
 *  (the registry's canonical `more` glyph — the same key the footer speaks). */
function sidebarOptions(view: QuestBoardView): BoardOption[] {
  const toOption = (o: QuestBoardView["options"][number]): BoardOption => ({
    id: o.id,
    label: o.label,
    ...(o.glyph ? { glyph: o.glyph } : {}),
    spokenText: o.spokenText ?? o.label,
  });
  if (view.options.length <= SIDEBAR_CAP) return view.options.map(toOption);
  const pages = Math.ceil(view.options.length / PER_PAGE);
  const page = bridgePage % pages; // wraps — More on the last page returns to the first
  const slice = view.options.slice(page * PER_PAGE, (page + 1) * PER_PAGE);
  // The pager wears the `more` lexeme, not the English word: every other button
  // on this sidebar arrives localized, and one that doesn't is the odd one out.
  const more = baseWord(languageFor(initLocale), "more");
  return [...slice.map(toOption), { id: PAGE_OPTION_ID, label: more, glyph: "more", spokenText: more }];
}

/** Push a board view (or a clear) to the AAC sidebar — the embedded island's
 *  `set`. Repeated `board()` calls each deliver a fresh view object, so paging
 *  resets exactly when a new view arrives. */
function pushSidebarBoard(view: QuestBoardView | null): void {
  if (!view || view.options.length === 0) {
    bridgeView = null;
    bridgePage = 0;
    sendToParent({ type: "clear_board_options" });
    return;
  }
  if (view !== bridgeView) bridgePage = 0;
  bridgeView = view;
  sendToParent({
    type: "set_board_options",
    options: sidebarOptions(view),
    prompt: view.promptText || undefined,
  });
}

// ── Island data captured for the bridge: the live noun list the host pushes
// (builder_state answers rank by it), the family strip (its `present` flags
// mark in-scene people; world_hud draws it), pocket + city (world_hud).
// Captured by wrapping/replacing the island setters — the host stays unaware
// of the bridge. ─────────────────────────────────────────────────────────────
let knownNouns: NounEntry[] = [];
/** ⑫ — the fellow members of the child's own conversation, as spoken words. Two
 *  or more means a crowd, where a request has to say WHOM it is for. */
let convoAddressees: string[] = [];
let familyMembers: FamilyHudEntry[] = [];
let pocketItems: PocketEntry[] = [];
let cityChips: CityHudChip[] = [];

// ── CREATURE PORTRAITS: the picture a NAMED creature's button wears, baked from
// that creature's own body (portraits.ts). Two facts have to meet — the host
// says which BODY each member has (FamilyHudEntry species/outfit), the noun list
// says which names are actually offered as WORDS — and either can arrive first,
// so the intersection is recomputed whenever one of them lands. A word already
// drawn (or queued) is never re-requested, so this is cheap to call on every
// push. ──────────────────────────────────────────────────────────────────────
function refreshPortraits(): void {
  if (!familyMembers.length || !knownNouns.length) return;
  const bodyByName = new Map<string, FamilyHudEntry>();
  for (const m of familyMembers) if (m.species) bodyByName.set(m.label.toLowerCase(), m);
  const reqs: Array<{ symbol: string; speciesId: string; outfit?: number }> = [];
  for (const n of knownNouns) {
    if (n.kind !== "creature") continue;
    const body = bodyByName.get(n.symbol.toLowerCase());
    if (!body?.species) continue;
    reqs.push({
      symbol: n.symbol.toLowerCase(),
      speciesId: body.species,
      ...(body.outfit !== undefined ? { outfit: body.outfit } : {}),
    });
  }
  if (reqs.length) requestPortraits(reqs);
}

// ── world_hud: what the standalone side panel DISPLAYS (family chips, city
// chips, pocket stacks), re-mapped into the bridge's generic sections for the
// AAC to render over its own button sidebar. Re-sent WHOLE on any actual data
// change (JSON signature guard — the host already de-dupes its pushes, this
// guard makes per-frame spam impossible by construction); empty sections
// clear the strip. Labels/notes are localized game-side via the engine's lang
// layer (family names and pocket labels arrive already localized). ───────────
type WorldHudSections = Extract<GameMessageInput, { type: "world_hud" }>["sections"];
let lastHudSig = "";
function pushWorldHud(): void {
  const lang = languageFor(initLocale);
  // Section order + `layout` mirror the standalone side panel top-to-bottom
  // (city ribbon → family cards → pocket items), so the AAC strip reads like
  // the lab bench.
  const sections: WorldHudSections = [];
  if (cityChips.length) {
    sections.push({
      id: "city",
      layout: "chips",
      items: cityChips.map((c) => ({
        id: String(c.district),
        // The chip's label is a WORD (a zone category, "town", "city") — the
        // pure HUD builder has no locale, so it is localized here, beside the
        // family chips' state words.
        label: baseWord(lang, c.label),
        glyph: c.glyph,
        emoji: c.emoji, // the aggregated wellbeing face
        note: `👥 ${c.population}`,
      })),
    });
  }
  if (familyMembers.length) {
    sections.push({
      id: "family",
      layout: "cards",
      items: familyMembers.map((m) => ({
        id: m.id,
        label: m.label,
        glyph: familyStateGlyph(m.state, m.emoji),
        emoji: m.emoji,
        // The state word through the lang lexicon (localized where the lexicon
        // has it — hungry/tired/lonely/…; the raw key otherwise).
        note: baseWord(lang, m.state),
        ...(m.selected ? { active: true } : {}),
        // Out of the scene right now (working/shopping/walking) — faded, as
        // the standalone strip dims them, never dropped.
        ...(m.present ? {} : { dim: true }),
      })),
    });
  }
  if (pocketItems.length) {
    sections.push({
      id: "pocket",
      layout: "items",
      items: pocketItems.map((it) => ({
        id: it.glyph,
        label: it.label,
        glyph: it.icon ?? it.glyph,
        count: it.count,
        ...(it.selected ? { active: true } : {}),
      })),
    });
  }
  const sig = JSON.stringify(sections);
  if (sig === lastHudSig) return;
  lastHudSig = sig;
  sendToParent({ type: "world_hud", sections });
}

/** STANDALONE: mount the real React island into a `.quest-boardpanel` sibling
 *  of the viewscreen. EMBEDDED: no DOM at all — a HEADLESS island whose
 *  setters stay live (the host's data flow is unchanged) but render nothing:
 *  board views route to the AAC sidebar, family/pocket/city go up as
 *  `world_hud`, and the noun list feeds `builder_state` answers. */
function mountIsland(): BoardIsland {
  if (!embedded) {
    const panel = document.createElement("div");
    panel.className = "quest-boardpanel";
    viewEl.insertAdjacentElement("afterend", panel);
    const raw = mountBoardIsland(
      panel,
      (id) => boardHandlers?.select(id),
      (sentence) => boardHandlers?.speak(sentence),
      (entityId) => boardHandlers?.selectPocket(entityId),
      (memberId) => boardHandlers?.selectFamilyMember(memberId),
    );
    return {
      ...raw,
      setNouns: (nouns) => { knownNouns = nouns; raw.setNouns(nouns); refreshPortraits(); },
      setFamily: (members) => { familyMembers = members; raw.setFamily(members); refreshPortraits(); },
      setAddressees: (list) => { convoAddressees = list; raw.setAddressees?.(list); },
    };
  }
  return {
    set: (view) => pushSidebarBoard(view),
    setNouns: (nouns) => { knownNouns = nouns; refreshPortraits(); },
    setPocket: (items) => { pocketItems = items; pushWorldHud(); },
    setFamily: (members) => { familyMembers = members; pushWorldHud(); refreshPortraits(); },
    setCity: (chips) => { cityChips = chips; pushWorldHud(); },
    setAddressees: (list) => { convoAddressees = list; },
    dispose: () => {},
  };
}
const island: BoardIsland = mountIsland();

// A finished portrait has to reach the board it belongs to. EMBEDDED: the
// platform's builder holds the buttons — the pictures go up as `word_images`,
// keyed by the same word the surfacer offered. STANDALONE: the island draws
// them, and the WORDS didn't change (only their faces), so the list is re-pushed
// by identity to make React look again.
onPortraitsBaked((added) => {
  if (embedded) {
    sendToParent({ type: "word_images", images: added.map((a) => ({ key: a.symbol, image: a.url })) });
  } else {
    island.setNouns([...knownNouns]);
  }
});

const sharedBoard: SharedBoard = {
  island,
  claim(handlers) {
    // Handed straight through. Whether a press or a sentence acts here or
    // travels to the owner is the ENGINE's rule now — every input resolves to
    // one PlayerAction and meets one gate inside the host (see
    // quest-host `performPlayerAction`). This game used to answer that question
    // a second time, in its own vocabulary, which is how a follower's
    // glyphless presses came to be silently dropped.
    const wrapped = handlers;
    boardHandlers = wrapped;
    return () => {
      if (boardHandlers !== wrapped) return; // a newer claim took over
      boardHandlers = null;
      sharedBoard.island.set(null);
      sharedBoard.island.setNouns([]);
      sharedBoard.island.setPocket([]);
      sharedBoard.island.setFamily([]);
      sharedBoard.island.setCity([]);
    };
  },
};

// Debug-only status line (hidden when embedded); errors surface here too.
const setStatus = (text: string, error = false): void => {
  statusEl.textContent = text;
  statusEl.classList.toggle("error", error);
  statusEl.title = text;
};

// ── Loading veil — a compositor-driven spinner that keeps turning while the
// synchronous world build freezes the main thread. ──────────────────────────
if (getComputedStyle(viewEl).position === "static") viewEl.style.position = "relative";
const veilEl = document.createElement("div");
veilEl.className = "lab-veil";
const veilSpin = document.createElement("div");
veilSpin.className = "lab-spin";
const veilLabel = document.createElement("div");
veilLabel.textContent = "building world…";
veilEl.append(veilSpin, veilLabel);
viewEl.appendChild(veilEl);
const hideVeil = (): void => veilEl.classList.add("hidden");
const paint = (): Promise<void> => new Promise((r) => setTimeout(r, 30));

// ── Bridge state ────────────────────────────────────────────────────────────
let quest: QuestBoot | null = null;
let initLocale: string | undefined;
let resolveInit: (() => void) | null = null;

// ── MULTIPLAYER session (world_session) ─────────────────────────────────────
// The platform re-sends `world_session` every ~3 s and on roster change; it is
// NEVER sent in solo play. A new identity (first arrival, or a selfId/role
// flip) reboots the world — the town is deterministic from the bundled spec,
// so a reboot is the sanctioned role-change path. Heartbeat repeats are no-ops.
// A world_session GAP is NOT a downgrade: once multiplayer, only
// `request_close`/reload ends it (never mere silence).
type MpSession = { selfId: string; role: "owner" | "follower" };
let mpTarget: MpSession | null = null; // the latest identity the platform sent
let bootedMp: MpSession | null = null; // what the LIVE quest was booted with
let closed = false; // request_close received — never boot again

// (The follower command relay that used to live here is GONE. It answered
// "does this act here or at the owner?" a second time, in the game's own
// vocabulary — resolving presses off the sidebar view, relaying them as
// sentences, and dropping any option that had no glyph. That question has one
// answer now, in the engine: every input resolves to a PlayerAction and passes
// `performPlayerAction`. The game just presses and speaks.)

// EYEGAZE smoothing only — a mouse-mode sample is already deliberate. Matches
// the goal-tree player's tuning. (After reset() the first sample SEEDS the
// smoother — gaze-kit snaps, it never eases from an origin.)
const smoother = new GazeSmoother({ timeConstantMs: 80, snapDistance: 220 });
// Forwarded-clear debounce: a DATA-LOSS ("off") stretch must last this long
// before it clears a forwarded-owned aim (blinks and single dropped frames
// hold the last aim instead). A known look-away (`away` — the eyes are on the
// AAC's sidebar) clears at once; there is nothing to wait for.
const GAZE_OFF_CLEAR_MS = 250;
let lastGazeInFrameMs = -Infinity;
// SACCADE GATE: only a FIXATION aims. Above this speed the eyes are in flight
// (a dart to the sidebar crosses the whole stage in a frame or two), and every
// point along the way is a place the child never looked — feeding them in
// swept the aim across the scene and dragged the follow camera into a spin.
// In flight the spark simply goes out; it reappears where the eyes land.
// ~3000 px/s ≈ 100 px between 33 ms samples — well above tracker jitter and
// well below a real saccade.
const SACCADE_SPEED_PX_S = 3000;
let lastRawGaze: { x: number; y: number; t: number } | null = null;

onPlatformMessage((msg: PlatformMessage) => {
  switch (msg.type) {
    case "init":
      // dwellMs: the engine's dwell timings are host constants (quest-host.ts
      // SHORT/LONG_DWELL_MS) — no per-session input to hand it to yet.
      if (typeof msg.locale === "string" && msg.locale) initLocale = msg.locale;
      resolveInit?.();
      resolveInit = null;
      break;
    case "gaze": {
      if (!quest) break;
      // The forwarded stream is ONE of two aim sources — the iframe's own
      // native pointermove is the other. quest-boot ARBITRATES (sticky native
      // ownership): a native pointer inside the stage owns the aim — a resting
      // cursor keeps it indefinitely; quest.aim drops forwarded points and
      // quest.clearAim never clears a native aim (the platform spams
      // mode:"off" ~30/s whenever it has no position).
      //
      // Three kinds of "not aiming here", each with its own answer:
      //   off + away — the eyes are on the AAC's own chrome. KNOWN look-away:
      //                drop the aim now (never aim at the stage edge, which
      //                would drag the follow camera into a continuous turn).
      //   off        — no data (blink, dropped frame). Hold the last aim for
      //                GAZE_OFF_CLEAR_MS — the same grace the engine's gaze
      //                interpreter gives a null pointer — then drop it.
      //   in flight  — a fast sample between two fixations (SACCADE gate). Aim
      //                goes out for the flight and returns on the landing.
      const now = performance.now();
      const onStage =
        msg.mode !== "off" &&
        msg.x >= 0 && msg.y >= 0 &&
        msg.x <= window.innerWidth && msg.y <= window.innerHeight;
      if (!onStage) {
        smoother.reset();
        lastRawGaze = null;
        if (msg.away || now - lastGazeInFrameMs >= GAZE_OFF_CLEAR_MS) quest.clearAim();
      } else if (msg.mode === "eyegaze") {
        lastGazeInFrameMs = now;
        const prev = lastRawGaze;
        lastRawGaze = { x: msg.x, y: msg.y, t: now };
        const dt = prev ? (now - prev.t) / 1000 : 0;
        const speed = prev && dt > 0 ? Math.hypot(msg.x - prev.x, msg.y - prev.y) / dt : 0;
        if (speed > SACCADE_SPEED_PX_S) {
          // In flight: no aim, and RESET the smoother so the landing fixation
          // SNAPS to where the eyes stopped instead of easing along the path.
          smoother.reset();
          quest.clearAim();
        } else {
          const p = smoother.update({ x: msg.x, y: msg.y }, now);
          quest.aim(p.x, p.y);
        }
      } else {
        lastGazeInFrameMs = now;
        lastRawGaze = null; // pointer samples are deliberate — never saccade-gated
        quest.aim(msg.x, msg.y); // mouse: already deliberate, unsmoothed
      }
      break;
    }
    case "board_option_selected":
      // The pager is board CHROME, never speech: advance (wrapping) and re-send.
      if (msg.id === PAGE_OPTION_ID) {
        if (bridgeView) {
          bridgePage += 1; // sidebarOptions wraps modulo the page count
          sendToParent({
            type: "set_board_options",
            options: sidebarOptions(bridgeView),
            prompt: bridgeView.promptText || undefined,
          });
        }
        break;
      }
      // Exactly what an island tap runs. `voiced` = the platform already spoke
      // the student's line, so the host yields (spokenExternally) instead of
      // voicing it twice.
      boardHandlers?.select(msg.id, { spokenExternally: msg.voiced === true });
      break;
    case "glyph_input": {
      // An outside sentence (LLM board button / sentence builder) executes
      // through the SAME path as the island's Speak menu.
      boardHandlers?.speak(msg.glyph, { spokenExternally: msg.voiced === true });
      // Parse authority is the vendored engine's own parser; "unclear" is the
      // one unparsable IntentKind. Reply ALWAYS — even unparsed, even with no
      // host to drive (the platform's builder flow waits on the verdict).
      // `spokenText` is the engine's own rendering of the student's statement —
      // the same first-person text `speakPlayerStatement` voices in-game
      // (translateGlyph glosses even an unparsable sentence, so the fallback
      // path still gets speakable words rather than raw glyph keys).
      const parsed = parseSentence(msg.glyph).kind !== "unclear";
      sendToParent({
        type: "glyph_result",
        glyph: msg.glyph,
        parsed,
        spokenText: translateGlyph(msg.glyph, initLocale, { firstPerson: true }),
        ...(msg.requestId !== undefined ? { requestId: msg.requestId } : {}),
      });
      break;
    }
    case "builder_state": {
      // The platform's sentence builder asks the ENGINE what to offer next.
      // Answer unconditionally from the pure surfacer (no world mutation, no
      // host needed — before boot the noun list is simply empty and the core
      // LEXICON starters still surface). Family `present` flags mark in-scene
      // people the same way the Family strip dims absent ones.
      const presentByName = new Map(familyMembers.map((m) => [m.label.toLowerCase(), m.present] as const));
      const nouns: BuilderNounEntry[] = knownNouns.map((n) => {
        const head = (n.symbol.split(".")[0] ?? n.symbol).toLowerCase();
        const present = n.kind === "creature"
          ? presentByName.get(head) ?? presentByName.get((n.label ?? "").toLowerCase())
          : undefined;
        return { ...n, ...(present !== undefined ? { present } : {}) };
      });
      const surface = builderSurfaceFor(msg.glyph, {
        nouns,
        ...(initLocale !== undefined ? { locale: initLocale } : {}),
        ...(msg.category !== undefined ? { category: msg.category } : {}),
        // `group` is being added to the shared surfacer; the vendored engine
        // snapshot may predate it — pass it through forward-compatibly (an
        // older surfacer simply ignores the extra opt; the final engine
        // re-sync makes it live).
        ...(msg.group !== undefined ? { group: msg.group } : {}),
        // THE CLIENT'S GRID BUDGET, never ours. Dropping it left the surfacer
        // on its own default of 16, so the platform's board could never page —
        // the same sentence offered three pages of words out-of-game and one
        // in it. The in-iframe Speak menu keeps its own 16; this is the
        // PLATFORM's board asking.
        ...(msg.capacity !== undefined ? { capacity: msg.capacity } : {}),
        // The student's learned layer + a tapped sentence-type chip: platform-
        // owned, passed straight through, never stored here.
        ...(msg.recency ? { recency: msg.recency } : {}),
        ...(msg.seedKind ? { seedKind: msg.seedKind as IntentKind } : {}),
        // ⑫ — in a crowd the builder opens an ADDRESSEE slot so a request can
        // name whom it is for. Same forward-compatibility note as `group`: an
        // older vendored surfacer ignores the extra opt.
        ...(convoAddressees.length ? { addressees: convoAddressees } : {}),
      } as BuilderSurfaceOpts);
      sendToParent({ type: "builder_surface", requestId: msg.requestId, surface });
      break;
    }
    case "pause":
      quest?.setPaused(true);
      break;
    case "resume":
      quest?.setPaused(false);
      break;
    case "world_session":
      // The ~3 s heartbeat: an identical identity is a no-op.
      if (mpTarget && mpTarget.selfId === msg.selfId && mpTarget.role === msg.role) break;
      mpTarget = { selfId: msg.selfId, role: msg.role };
      requestWorldReboot();
      break;
    case "world_data":
      // Inbound mesh packets — the host validates/filters; a boot without
      // multiplayer deps (or no boot yet) drops them (applyNetInbound no-ops).
      quest?.applyNetInbound(msg.msgs);
      break;
    case "world_cmd": {
      // Reliable relayed command — the OWNER injects it; follower/solo ignore.
      if (!quest || quest.multiplayerRole() !== "owner") break;
      const cmd = parseWorldCommand(msg.cmd);
      if (cmd) quest.applyRemoteCommand(cmd);
      break;
    }
    case "request_close":
      closed = true;
      mpTarget = null;
      bootedMp = null;
      quest?.dispose();
      quest = null;
      sendToParent({ type: "session_end", reason: "quit" });
      break;
    default:
      break;
  }
});
sendToParent({ type: "ready", gameId: GAME_ID, version: VERSION });

// ── THE TOWN'S VOICE, ANNOUNCED ─────────────────────────────────────────────
// One voice for every boot (a reboot disposes the host, not the speaker), built
// here rather than inside the host because THIS file owns the bridge: each
// utterance edge goes out as `game_speech` so the AAC can gate its microphone
// while the town talks. Without it the mic hears an NPC line, the recogniser
// hands it over as the student's own words, and the assistant answers a
// sentence nobody said ("I'm going home." → "You're going home? Nice.").
// Standalone play sends into the void — `sendToParent` no-ops with no parent.
const townVoice = createNpcVoice({
  onSpeaking: (speaking, ms) => sendToParent({ type: "game_speech", speaking, ms }),
});

/** Embedded: give the platform a beat to deliver `init` (locale) before the
 *  world builds — the town's lang layer is chosen at build time. Standalone
 *  boots immediately. */
function waitForInit(timeoutMs: number): Promise<void> {
  if (!embedded) return Promise.resolve();
  return new Promise((resolve) => {
    resolveInit = resolve;
    setTimeout(() => {
      resolveInit = null;
      resolve();
    }, timeoutMs);
  });
}

/** Load + validate the bundled spec (locale override applied). Returns null
 *  after reporting a packaging error. */
function loadSpec(): LoadedWorld | null {
  // The spec ships in the bundle; `init.locale` (when embedded) overrides its
  // authored locale — languageFor() resolves any BCP-47 tag with en fallback.
  const raw = structuredClone(specJson) as Record<string, unknown>;
  const game = raw.game as { world?: Record<string, unknown> } | undefined;
  if (initLocale) {
    if (game?.world) game.world.locale = initLocale;
  } else if (typeof game?.world?.locale === "string" && game.world.locale) {
    // Standalone / no init: adopt the spec's authored locale, so the bridge
    // answers (builder_surface labels, glyph_result.spokenText) always speak
    // the SAME language the booted world does.
    initLocale = game.world.locale;
  }
  const loaded = loadWorldManifest(raw, [ECONOMY_MODULE]);
  if (!loaded.game) {
    setStatus("document has no `game` settings — nothing to run", true);
    return null;
  }
  // The one route this game ships (dispatch.ts law): a town watched as a
  // spirit. Anything else in the spec is a packaging error, not a mode.
  if (loaded.game.scope !== "town" || avatarKind(loaded.game) !== "spirit") {
    setStatus(
      `game.spec.json must be a town-scope spirit world (got scope "${loaded.game.scope}", avatar "${String(loaded.game.avatar)}")`,
      true,
    );
    return null;
  }
  // CREATURE MODS before anything builds a body: the mods reshape the species
  // registry (deriving rows) and set the world's appearance transform, and a
  // body baked before they land would be cached un-modded for the session.
  applyWorldCreatureMods(loaded.game.mods);
  return loaded;
}

/** (Re)build the world SYNCHRONOUSLY against the CURRENT multiplayer target —
 *  the initial boot and every world_session reboot go through here. The town
 *  is deterministic from the bundled spec, so owner and follower build the
 *  same world; a role change simply rebuilds with the other half of the
 *  engine's multiplayer seam. */
function buildWorld(): void {
  quest?.dispose();
  quest = null;
  bootedMp = null;
  const snapshot = mpTarget ? { ...mpTarget } : null;
  try {
    const loaded = loadSpec();
    if (!loaded) return;
    quest = bootLivingTown(
      viewEl, loaded, setStatus, sharedBoard,
      snapshot
        ? {
            localId: snapshot.selfId,
            role: snapshot.role,
            // Outbound engine wire messages → the platform's unreliable
            // world channel (fanned out verbatim to every peer).
            net: { send: (msgs: unknown[]) => sendToParent({ type: "world_data", msgs }) },
            // Outbound COMMANDS → the platform's reliable pipe. The engine
            // sends a follower's gaze instructions (the world-mutating cells of
            // the dwell table) here; board presses and built sentences take the
            // same pipe through wrapHandlersForMultiplayer above.
            sendCommand: (cmd) => sendToParent({ type: "world_cmd", cmd }),
          }
        : undefined,
      townVoice,
    );
    bootedMp = snapshot;
  } catch (e) {
    setStatus((e as Error).message, true);
    sendToParent({ type: "session_end", reason: "error", summary: (e as Error).message });
  }
}

async function boot(): Promise<void> {
  setStatus("building world…");
  await waitForInit(1500);
  await paint(); // one painted frame so the veil is visible through the build lump
  try {
    if (!closed) buildWorld(); // reads mpTarget — a world_session that beat the boot applies directly
  } finally {
    hideVeil();
  }
}

// ── (Re)boot serialization: every boot chains here, so a reboot in progress is
// never re-entered; rapid role flips collapse (each queued pass re-reads
// mpTarget and no-ops when the live boot already matches). ──────────────────
let bootTask: Promise<void> = boot();

function requestWorldReboot(): void {
  bootTask = bootTask.then(async () => {
    const matches =
      (!bootedMp && !mpTarget) ||
      (!!bootedMp && !!mpTarget && bootedMp.selfId === mpTarget.selfId && bootedMp.role === mpTarget.role);
    if (closed || matches) return;
    setStatus("rebuilding world…");
    veilEl.classList.remove("hidden");
    await paint();
    try {
      buildWorld();
    } finally {
      hideVeil();
    }
  });
}
