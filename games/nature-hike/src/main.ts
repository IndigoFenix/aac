/**
 * Nature Hike — the shipped planet-hike game (/games/nature-hike/).
 *
 * The bundled `game.spec.json` (an `aivota-world` document — planet scope, a
 * body root, avatar `true`) loads through the engine's manifest gate and boots
 * a WALKER on the ground: the planet is built and rendered from its own
 * geology/radius/rain, a wilderness chunk is anchored at a deterministic spawn
 * site, and the quest host runs open country there — talkable creatures,
 * gatherable resources, and a floating-origin chart that re-anchors under the
 * walker instead of fencing them in (quest-boot.ts).
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
import { parseWorldCommand } from "@shared/world-engine/net";
import {
  anchorControl, assignControl, handoverControl, parseSessionControl,
  type SessionAnchor,
} from "@shared/world-engine/interaction/quest/session-control";
import type { SessionAssignment } from "@shared/world-engine/interaction/quest/session-split";
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
import {
  bootPlanetHike, sessionMembershipOf,
  type BoardHandlers, type HandoverRefusalView, type QuestBoot, type SessionMembership,
  type SharedBoard,
} from "./quest-boot";
import { onPortraitsBaked, requestPortraits } from "./portraits";
import specJson from "./game.spec.json";

const GAME_ID = "nature-hike";
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
const PAGE_OPTION_ID = "__nature_hike_page";
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
/** ⑫ — the fellow members of the player's own conversation, as spoken words.
 *  Two or more means a crowd, where a request has to say WHOM it is for. */
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
        // Out of the scene right now (grazing off over the ridge) — faded, as
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
    // travels to the owner is the ENGINE's rule (every input resolves to one
    // PlayerAction and meets one gate inside the host — quest-host
    // `performPlayerAction`); this game just presses and speaks.
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
// flip) reboots the world — the planet is deterministic from the bundled spec,
// so a reboot is the sanctioned role-change path. Heartbeat repeats are no-ops.
// A world_session GAP is NOT a downgrade: once multiplayer, only
// `request_close`/reload ends it (never mere silence).
//
// `peers` (roster membership/names) travels separately from identity: a
// peers-only change forwards the fresh roster into the LIVE boot
// (QuestBoot.setPeers) WITHOUT a reboot — only a selfId/role change reboots.
//
// ⚠️ PHASE 2 ships SINGLE-PLAYER: nothing registers this game for a shared
// session yet, so this path is wired but never exercised. The later phases own
// it (and the reboot-is-a-full-rebuild consequence: nothing survives one).
type MpSession = { selfId: string; role: "owner" | "follower" };
type MpPeer = { id: string; name?: string };
let mpTarget: MpSession | null = null; // the latest identity the platform sent
let peersTarget: MpPeer[] = []; // the latest roster the platform sent (default: none)
let bootedMp: MpSession | null = null; // what the LIVE quest was booted with
let closed = false; // request_close received — never boot again

/** Order-insensitive roster equality by id+name — a heartbeat that neither
 *  changed identity NOR reshuffled the roster (same members, same names,
 *  regardless of array order) must stay a complete no-op. */
function peersEqual(a: readonly MpPeer[], b: readonly MpPeer[]): boolean {
  if (a.length !== b.length) return false;
  const key = (p: MpPeer): string => JSON.stringify([p.id, p.name ?? ""]);
  const as = a.map(key).sort();
  const bs = b.map(key).sort();
  return as.every((v, i) => v === bs[i]);
}

// ── SESSION SPLIT — THE GAME'S HALF (stage N6b-g) ───────────────────────────
// The engine's coordinator (owner-side, ~1 Hz) clusters everyone's planet
// presence and announces the roster on the reliable pipe; its INBOUND half is
// store-only by law — the engine never boots or tears worlds, because world
// construction is the game's. So this file reacts, in four places:
//   • ROUTING: a session-control envelope is tried FIRST and above the owner
//     guard (`world_cmd` below) — it is addressed to every MEMBER, and a
//     follower is precisely who has to hear that it now owns a session.
//   • BOOT IDENTITY: which session I am in, my role INSIDE it, and whose sim I
//     replicate join selfId/platform-role in the identity a reboot compares
//     against. A change rides the EXISTING reboot serialization.
//   • REPLAY: the roster in force is fed into each new boot — a reboot builds a
//     brand-new host whose session book is empty, and the coordinator
//     re-announces only when the epoch moves, so without this the fresh world
//     would forget which session it belongs to.
//   • RECEIVERS FILTER: peers outside my session are somewhere else on the
//     planet. Their mesh traffic and their relayed commands are dropped, and
//     they never reach `setPeers`, so no body of theirs spawns here.
//
// ⚖️ WHAT TRAVELS (stage N6c-g, below): a reboot still rebuilds the WORLD from
// seed, but the session's live state no longer dies with it — a departing
// cluster's wild stock and carried stacks are handed to its new authority
// before the teardown, and the `anchor` envelopes this game announces are
// APPLIED by the next boot instead of merely stored.
let liveAssign: SessionAssignment | null = null; // the roster in force
let sessionTarget: SessionMembership | null = null; // my place in it (null ⇒ never assigned)
let bootedSession: SessionMembership | null = null; // what the LIVE quest was built with

/** The part of a membership that is BOOT IDENTITY. Session-mates are NOT part
 *  of it: someone joining or leaving my session re-filters the roster through
 *  `setPeers`, exactly as a platform roster change does, without rebuilding
 *  the world (the N5a law). */
const sessionIdentity = (m: SessionMembership | null): string =>
  m ? `${m.sessionId}|${m.role}|${m.authority}` : "";

/** The roster as MY SESSION sees it: the platform roster intersected with my
 *  session's members, so avatars spawn only for the people actually standing
 *  here. No assignment ⇒ the whole roster, unchanged. */
function sessionPeers(): MpPeer[] {
  const m = sessionTarget;
  return m ? peersTarget.filter((p) => m.members.includes(p.id)) : peersTarget;
}

/** Is this peer in my session? No assignment ⇒ everyone is (today's behavior,
 *  byte-identical). */
function inMySession(peerId: string): boolean {
  const m = sessionTarget;
  return !m || m.members.includes(peerId);
}

/** ⚖️ PRESENCE CROSSES SESSIONS. Everything a peer OUTSIDE my session streams
 *  — its avatars, its speech, its claims, its spark — belongs to another
 *  world and is dropped here; its `loc` beacon is kept, and is the one
 *  deliberate exception to the batch filter.
 *
 *  WHY: the beacon is the COORDINATOR'S INPUT, and coordination is inherently
 *  cross-session — it is how two parties that walked apart are seen to have
 *  walked back together. Dropping it wholesale would make a split PERMANENT:
 *  after one, each peer hears only itself, every coordinator falls below its
 *  two-located-members gate, and no merge could ever be computed again. */
function sessionScopedInbound(fromId: string, msgs: unknown[]): unknown[] | null {
  if (inMySession(fromId)) return msgs;
  const presence = msgs.filter(
    (m) => !!m && typeof m === "object" && (m as { t?: unknown }).t === "loc",
  );
  return presence.length ? presence : null;
}

/** Adopt a roster — from the wire, or from the engine's own coordinator via
 *  the boot's readback (a coordinating peer never receives its own
 *  announcement; it self-applies it inside the host) — and react to what it
 *  says about ME. */
function adoptAssignment(next: SessionAssignment): void {
  if (liveAssign && next.epoch < liveAssign.epoch) return; // stale re-delivery
  const prevMine = sessionTarget; // MY PLACE UNDER THE OLD WORD — the donor's half needs it
  const self = mpTarget?.selfId;
  const m = self ? sessionMembershipOf(next, self) : null;
  // A roster that does not name me is NO NEWS — my presence simply hadn't
  // reached the coordinator when it spoke. The last word stands; it never
  // collapses to "unassigned" and reboots the world over a late beacon. (And
  // nothing is donated on one either: a word that says nothing about me says
  // nothing about who left me.)
  if (!m) {
    liveAssign = next;
    return;
  }
  const reboot = sessionIdentity(m) !== sessionIdentity(sessionTarget);
  // ⚖️ DONATE FIRST, IN THIS TICK. Everything below only QUEUES work
  // (`requestWorldReboot` chains onto `bootTask`; `setPeers` despawns the
  // bodies of members who left), and the assemble has to run against the world
  // as it stands, with those members still in it. So the donor's half goes
  // here — after the comparison that detects the change, before anything acts
  // on it, and synchronously, so no frame of play can happen in between.
  if (self && prevMine) donateDepartures(prevMine, next, self, !reboot);
  liveAssign = next;
  sessionTarget = m;
  forgetDeadSessions(next);
  // A membership-only move (a session-mate joined or left) is a ROSTER change,
  // not an identity one: re-filter and forward, exactly as a platform roster
  // change does, with no rebuild.
  if (reboot) requestWorldReboot();
  else quest?.setPeers(sessionPeers());
}

// ── SESSION HANDOVER — THE GAME'S HALF (stage N6c-g) ────────────────────────
// The engine assembles and applies the payload; THIS file decides who gives it
// to whom, and when. Three books are kept here rather than in the host, for the
// same reason the assignment is replayed into every fresh boot: a reboot builds
// a brand-new host whose session book is EMPTY, and an `anchor` or a `handover`
// is announced ONCE. Keeping the envelopes here is what lets the next world be
// built with them (they are re-filed into it and read back through the engine's
// own door — this file never treats its copy as the truth).
type AnchorNote = { epoch: number; loc: SessionAnchor; from: string };
const anchorsBySession = new Map<string, AnchorNote>(); // latest per session
const handoversBySession = new Map<string, { from: string; to: string; payload: unknown }>();
/** Where I was standing when the last world came down (planet frame) — the
 *  fallback datum a fresh AUTHORITY stands its chart on (quest-boot ⑧). */
let carriedLoc: SessionAnchor | null = null;
/** One donation per (epoch, from-session, to-session): the same assignment can
 *  reach this file twice — once off the wire, once through the boot's own
 *  readback — and assembling twice would fold the wild twice. */
const donatedKeys = new Set<string>();
let handoversSent = 0;
let handoversLate = 0;
const seenRefusals: HandoverRefusalView[] = [];

/** A session that is no longer in the roster is GONE, and so is everything
 *  stated about it. This is the concrete half of the staleness rule below:
 *  a dead session's anchor can never reach a boot, because it stops being
 *  stored the moment the roster that killed it arrives. */
function forgetDeadSessions(next: SessionAssignment): void {
  const live = new Set(next.sessions.map((s) => s.id));
  for (const id of [...anchorsBySession.keys()]) if (!live.has(id)) anchorsBySession.delete(id);
  for (const id of [...handoversBySession.keys()]) if (!live.has(id)) handoversBySession.delete(id);
}

/** Store an `anchor` envelope. Epoch-monotonic per session, the same rule the
 *  engine's own book applies — a re-delivered older anchor must not drag a
 *  session back to where its members no longer are. `from` is the bridge's
 *  `world_cmd.fromId`: the envelope itself does not carry a sender, and WHO
 *  said it is half of whether it may be believed. */
function noteAnchor(sessionId: string, epoch: number, loc: SessionAnchor, from: string): void {
  const prev = anchorsBySession.get(sessionId);
  if (prev && epoch < prev.epoch) return;
  anchorsBySession.set(sessionId, { epoch, loc, from });
}

/**
 * ⚖️ THE ANCHOR STALENESS RULE — may this stored anchor stand a fresh boot's
 * chart? All four, or the boot computes its own datum:
 *
 *  1. IT NAMES THE SESSION I AM BOOTING INTO. Session ids are only carried
 *     forward by the coordinator's overlap match, so "same id" means "the same
 *     session, continued"; and a session that died lost its id from the roster,
 *     which `forgetDeadSessions` has already turned into a deleted entry. That
 *     pair is what "the anchor's era" means here — not an age in epochs.
 *  2. ITS SENDER IS THAT SESSION'S AUTHORITY. Only the peer that hosts a
 *     session may say where its chart stands. This also answers "and I am not
 *     the peer that announced it": when the sender is me, I am the authority,
 *     and my own word is not news to my own boot.
 *  3. ITS EPOCH IS NOT AHEAD OF THE ROSTER I AM BOOTING AGAINST. An anchor
 *     stamped with a word I have not adopted belongs to a future boot, not this
 *     one; it stays stored and the next boot will meet it as its own present.
 *  4. NO AGE BOUND, deliberately. An epoch bumps whenever the topology moves
 *     ANYWHERE on the planet, so a quiet session's datum does not go stale
 *     because strangers on the far side split; it is superseded only by a
 *     newer anchor for the same session, which (1) + monotonicity handle.
 *
 * ⚠️ ACCEPTED HOLE, stated: a peer that joined late and never heard the
 * authority's last re-anchor boots on an OLDER datum of the same session (or
 * on the seed site). Its chart is then offset from the authority's until the
 * next re-anchor announcement is met by its next boot — the same drift N2
 * recorded, narrowed but not closed.
 */
function anchorEnvelopeFor(m: SessionMembership): unknown | null {
  const note = anchorsBySession.get(m.sessionId);
  if (!note) return null;
  if (note.from !== m.authority) return null;
  if (note.epoch > m.epoch) return null;
  return anchorControl(m.sessionId, note.epoch, note.loc);
}

/**
 * ⚖️ THE DONOR'S COMPARISON — who is leaving my authority, derived from the
 * game's stored PREVIOUS assignment against the new one.
 *
 * It is the peer-local half of the engine's own `diffAssignments` handover
 * grouping, restricted to the groups whose donor is me: every member of MY
 * previous session whose SESSION ID changed is grouped by the session it
 * changed to, and each group goes to that session's new authority. Deliberately
 * the same rule, so the two can never disagree about who owes whom:
 *   • a member who stayed in my session is not a departure, whatever else moved;
 *   • a member who vanished from the roster entirely is in no group (nobody to
 *     hand them to — loss-tolerant v1, the engine's rule verbatim);
 *   • a session id that survives while its AUTHORITY changes is an
 *     `authority-change`, NOT a handover, and the engine emits no payload for
 *     it — so neither does this. (Wiring one would be inventing a decision the
 *     coordinator never made.)
 *
 * Both shapes the plan names fall out of the one rule: a SPLIT is a group whose
 * destination is new, a MERGE THAT DISSOLVES MY SESSION is the group that
 * contains everyone including me. When that group's new authority IS me (a
 * merge my session dissolves into but that I still host), nothing goes on the
 * wire — the payload is stashed for MY OWN next boot, which is the same
 * receiver door read from the other end.
 */
function donateDepartures(
  prevMine: SessionMembership,
  next: SessionAssignment,
  self: string,
  keepPlaying: boolean,
): void {
  const q = quest;
  // Only an AUTHORITY has anything to hand over: a follower's world is a
  // replica, and the state that matters lives on the peer that hosts the sim.
  // And it must be THE world that is losing these members — during a reboot
  // window the live host can still be the previous session's (or a replica of
  // someone else's), and donating that one would hand over a world nobody was
  // hosting. The state the departing cluster wanted does not exist locally in
  // that window; saying so is better than shipping a stand-in.
  if (!q || prevMine.role !== "owner") return;
  if (!bootedSession || bootedSession.role !== "owner" || bootedSession.sessionId !== prevMine.sessionId) return;
  const groups = new Map<string, { authority: string; members: string[] }>();
  for (const id of prevMine.members) {
    const dest = sessionMembershipOf(next, id);
    if (!dest || dest.sessionId === prevMine.sessionId) continue;
    let g = groups.get(dest.sessionId);
    if (!g) {
      g = { authority: dest.authority, members: [] };
      groups.set(dest.sessionId, g);
    }
    g.members.push(id);
  }
  for (const [destId, g] of groups) {
    const key = `${next.epoch}|${prevMine.sessionId}>${destId}`;
    if (donatedKeys.has(key)) continue;
    donatedKeys.add(key);
    const donated = q.donateHandover([...g.members].sort(), { keepPlaying });
    if (!donated) continue; // no live session, or an engine that predates the surface
    seenRefusals.push(...donated.refusals);
    if (g.authority === self) {
      // TO MYSELF: my session dissolved into one I still host. The payload
      // rides my own reboot instead of the wire (`buildWorld` hands it in).
      handoversBySession.set(destId, { from: self, to: self, payload: donated.payload });
      continue;
    }
    sendToParent({ type: "world_cmd", cmd: handoverControl(destId, self, g.authority, donated.payload) });
    handoversSent++;
  }
}

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
// sweeps the aim across the scene and drags the follow camera into a spin.
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
        // THE CLIENT'S GRID BUDGET, never ours. Dropping it leaves the surfacer
        // on its own default of 16, so the platform's board could never page —
        // the same sentence offering three pages of words out-of-game and one
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
    case "world_session": {
      const peers = msg.peers ?? [];
      const identityChanged =
        !mpTarget || mpTarget.selfId !== msg.selfId || mpTarget.role !== msg.role;
      if (identityChanged) {
        // A new identity (first arrival, or a selfId/role flip) reboots the
        // world — unchanged dollhouse law. The fresh roster rides along; the
        // post-boot forward in buildWorld() delivers it to the new host.
        mpTarget = { selfId: msg.selfId, role: msg.role };
        peersTarget = peers;
        requestWorldReboot();
        break;
      }
      // Identity unchanged: the ~3 s heartbeat is a complete no-op UNLESS the
      // roster itself moved (join/leave/rename) — then forward the fresh
      // roster into the LIVE boot WITHOUT rebooting.
      if (peersEqual(peersTarget, peers)) break;
      peersTarget = peers;
      // SESSION-SCOPED: the host is handed my session's members only (the whole
      // roster while no coordinator has spoken).
      quest?.setPeers(sessionPeers());
      break;
    }
    case "world_data": {
      // Inbound mesh packets — the host validates/filters; a boot without
      // multiplayer deps (or no boot yet) drops them (applyNetInbound no-ops).
      // Ahead of that, the RECEIVERS FILTER: a peer outside my session is
      // hiking somewhere else on the planet, and only its planet-presence
      // beacon crosses that line (see sessionScopedInbound).
      const msgs = sessionScopedInbound(msg.fromId, msg.msgs);
      if (msgs) quest?.applyNetInbound(msgs);
      break;
    }
    case "world_cmd": {
      // SESSION CONTROL FIRST, and ABOVE the owner guard: an assign / anchor /
      // handover envelope is addressed to every MEMBER — a follower is exactly
      // who has to hear that it now owns a session — and it comes from the
      // coordinator, which after a split is typically not even in my session.
      // So neither the owner guard nor the receivers filter may stand in its
      // way. The ordering is safe BY CONSTRUCTION: the three envelope kinds on
      // this wire carry three different discriminants (`sc` / `kind` / `t`), so
      // a WorldCommand can never half-parse as session control and vice versa
      // (N6a's mutual null-safety law).
      const sc = parseSessionControl(msg.cmd);
      if (sc) {
        quest?.applySessionControl(msg.cmd);
        // React here too, not only through the boot's readback: this covers the
        // window before the first boot has finished (there is no host to store
        // it in yet) and saves the poll interval when there is.
        if (sc.sc === "assign") adoptAssignment({ epoch: sc.epoch, sessions: sc.sessions });
        // A stated chart datum, kept for the boot that will stand on it (a
        // fresh host's book is empty). WHO said it rides along — the envelope
        // carries no sender, and the staleness rule needs one.
        if (sc.sc === "anchor") noteAnchor(sc.sessionId, sc.epoch, sc.loc, msg.fromId);
        if (sc.sc === "handover" && sc.to === mpTarget?.selfId) {
          // ADDRESSED, unlike the rest of this wire: an `assign` is news for
          // every member and an `anchor` is a fact about a session, but a
          // handover names the peer that is to INSTALL it. Overhearing someone
          // else's is not an invitation to install another cluster's world.
          handoversBySession.set(sc.sessionId, { from: sc.from, to: sc.to, payload: sc.payload });
          // IS IT FOR THE WORLD THAT IS ALREADY UP? On a split the donor's
          // payload chases the assignment that caused the reboot, and it can
          // land either side of it. The boot applies whatever was in force when
          // it was built; anything that arrives afterwards is offered to the
          // LIVE world here, which takes it only while nobody has played it
          // yet (the descent) and logs-and-drops it after that.
          if (bootedSession && bootedSession.role === "owner" && bootedSession.sessionId === sc.sessionId) {
            const outcome = quest?.applyStoredHandover() ?? "unavailable";
            if (outcome === "applied" || outcome === "late" || outcome === "declined") {
              handoversBySession.delete(sc.sessionId); // consumed, or refused — never re-applied later
            }
            if (outcome === "late") handoversLate++;
          }
        }
        break;
      }
      // Reliable relayed command — the OWNER injects it; follower/solo ignore.
      // Plus the RECEIVERS FILTER: after a split there are several owners, and
      // a command from outside my session is addressed to another one's world.
      if (!quest || quest.multiplayerRole() !== "owner" || !inMySession(msg.fromId)) break;
      const cmd = parseWorldCommand(msg.cmd);
      if (cmd) quest.applyRemoteCommand(cmd);
      break;
    }
    case "request_close":
      closed = true;
      mpTarget = null;
      bootedMp = null;
      liveAssign = null;
      sessionTarget = null;
      bootedSession = null;
      // Nothing survives a close: a stored payload or datum belongs to a
      // session this device has left, and the next run is a new arrival.
      anchorsBySession.clear();
      handoversBySession.clear();
      donatedKeys.clear();
      carriedLoc = null;
      quest?.dispose();
      quest = null;
      sendToParent({ type: "session_end", reason: "quit" });
      break;
    default:
      break;
  }
});
sendToParent({ type: "ready", gameId: GAME_ID, version: VERSION });

// DEBUG READBACK, hidden — no GUI (ruling 4), the same pattern as the boot's
// `__hikePeers` handle: `__hikeSession()` in the iframe console tells a
// two-window split pass what this peer believes its session is, which roster it
// is actually forwarding, and what the LIVE world was built with (the two
// differ exactly while a reboot is in flight).
// The HANDOVER half of the same readback (N6c-g): what this peer sent, what its
// live world accepted, and — the point of the exercise — everything that STAYED
// BEHIND. Refusals are counted AND listed: a split that left a promise standing
// with the donor is the one thing a two-window pass cannot see from the screen.
(window as unknown as Record<string, unknown>).__hikeSession = (): {
  self: string | null;
  platformRole: "owner" | "follower" | null;
  epoch: number | null;
  session: SessionMembership | null;
  booted: SessionMembership | null;
  roster: MpPeer[];
  forwarded: MpPeer[];
  handover: {
    sent: number;
    lateDropped: number;
    refusals: number;
    refusalDetail: HandoverRefusalView[];
    stashed: string[];
    anchors: Array<{ sessionId: string; epoch: number; from: string }>;
    carriedLoc: SessionAnchor | null;
    world: ReturnType<QuestBoot["handoverStatus"]> | null;
  };
} => {
  const world = quest?.handoverStatus() ?? null;
  const refusalDetail = [...seenRefusals, ...(world?.refusals ?? [])];
  return {
    self: mpTarget?.selfId ?? null,
    platformRole: mpTarget?.role ?? null,
    epoch: liveAssign?.epoch ?? null,
    session: sessionTarget,
    booted: bootedSession,
    roster: peersTarget,
    forwarded: sessionPeers(),
    handover: {
      sent: handoversSent,
      lateDropped: handoversLate + (world?.late ?? 0),
      refusals: refusalDetail.length,
      refusalDetail,
      stashed: [...handoversBySession.keys()],
      anchors: [...anchorsBySession].map(([sessionId, a]) => ({ sessionId, epoch: a.epoch, from: a.from })),
      carriedLoc,
      world,
    },
  };
};

// ── THE WILD'S VOICE, ANNOUNCED ─────────────────────────────────────────────
// One voice for every boot (a reboot disposes the host, not the speaker), built
// here rather than inside the host because THIS file owns the bridge: each
// utterance edge goes out as `game_speech` so the AAC can gate its microphone
// while the world talks. Without it the mic hears an NPC line, the recogniser
// hands it over as the student's own words, and the assistant answers a
// sentence nobody said. Standalone play sends into the void — `sendToParent`
// no-ops with no parent.
const worldVoice = createNpcVoice({
  onSpeaking: (speaking, ms) => sendToParent({ type: "game_speech", speaking, ms }),
});

/** Embedded: give the platform a beat to deliver `init` (locale) before the
 *  world builds — the world's lang layer is chosen at build time. Standalone
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

/** Load + validate the bundled spec. Returns null after reporting a
 *  packaging error. */
function loadSpec(): LoadedWorld | null {
  // The spec ships in the bundle. `init.locale` (when embedded) is SESSION
  // state, held in `initLocale` and read directly by every bridge answer —
  // it must NEVER be written into `game.world`: the manifest gate validates
  // the world block against its physical fields (topology, geology, …) and
  // rejects unknown keys, so smuggling the locale there aborted the whole
  // boot with session_end("error") exactly and only when a platform `init`
  // had arrived (caught live in the clinician call surface, 2026-08-16).
  // Standalone runs keep languageFor()'s en fallback.
  const raw = structuredClone(specJson) as Record<string, unknown>;
  const loaded = loadWorldManifest(raw, [ECONOMY_MODULE]);
  if (!loaded.game) {
    setStatus("document has no `game` settings — nothing to run", true);
    return null;
  }
  // The one route this game ships: a PLANET walked as an embodied WALKER
  // (`avatar: true` — manifest.ts avatarKind). Anything else in the spec is a
  // packaging error, not a mode.
  if (loaded.game.scope !== "planet" || avatarKind(loaded.game) !== "walker") {
    setStatus(
      `game.spec.json must be a planet-scope walker world (got scope "${loaded.game.scope}", avatar "${String(loaded.game.avatar)}")`,
      true,
    );
    return null;
  }
  return loaded;
}

/** (Re)build the world SYNCHRONOUSLY against the CURRENT multiplayer target —
 *  the initial boot and every world_session reboot go through here. The planet
 *  is deterministic from the bundled spec, so owner and follower build the
 *  same world; a role change simply rebuilds with the other half of the
 *  engine's multiplayer seam. */
function buildWorld(): void {
  // WHERE THE PLAYER WAS STANDING outlives the world that knew it: the planet
  // frame is the one thing a rebuild cannot recompute (the planet is
  // deterministic, the walk is not). Read it off the dying boot before it goes.
  carriedLoc = quest?.planetLoc() ?? carriedLoc;
  quest?.dispose();
  quest = null;
  bootedMp = null;
  bootedSession = null;
  const snapshot = mpTarget ? { ...mpTarget } : null;
  // MY ROLE IS MY SESSION'S ROLE, once a coordinator has spoken: the platform
  // elects ONE host for the whole call, and a split hands each cluster its own
  // authority — so a platform follower that walked away with a cluster boots as
  // the OWNER of that world. `localId` never moves with it: a peer is the same
  // peer in whichever session it stands in (its created body keeps its id).
  const sessionSnap = sessionTarget ? { ...sessionTarget } : null;
  // THE ENVELOPES THIS WORLD IS BUILT WITH (N6c-g). The anchor stands its
  // chart; the handover is applied right after the host starts. Both are
  // re-filed into the fresh host by the boot and read back through the
  // engine's own door — the freshness judgement is made HERE, because only
  // this file saw who sent what, against which roster.
  const replayControl: unknown[] = [];
  if (sessionSnap) {
    const anchorEnv = anchorEnvelopeFor(sessionSnap);
    if (anchorEnv) replayControl.push(anchorEnv);
    // Only an AUTHORITY may install a handover: it is a whole session's state,
    // and a follower does not host one.
    const ho = sessionSnap.role === "owner" ? handoversBySession.get(sessionSnap.sessionId) : undefined;
    if (ho) replayControl.push(handoverControl(sessionSnap.sessionId, ho.from, ho.to, ho.payload));
  }
  try {
    const loaded = loadSpec();
    if (!loaded) return;
    quest = bootPlanetHike(
      viewEl, loaded, setStatus, sharedBoard,
      snapshot
        ? {
            localId: snapshot.selfId,
            role: sessionSnap ? sessionSnap.role : snapshot.role,
            // Outbound engine wire messages → the platform's unreliable
            // world channel (fanned out verbatim to every peer).
            net: { send: (msgs: unknown[]) => sendToParent({ type: "world_data", msgs }) },
            // Outbound COMMANDS → the platform's reliable pipe. The engine
            // sends a follower's gaze instructions (the world-mutating cells of
            // the dwell table) here; board presses and built sentences take the
            // same pipe.
            sendCommand: (cmd) => sendToParent({ type: "world_cmd", cmd }),
            // Outbound SESSION CONTROL → the same reliable pipe (the platform
            // fans it out to every peer). Two senders share it: the engine's
            // session coordinator (owner-side — and its absence is what makes
            // that coordinator inert, so wiring it is what turns splitting on)
            // and the boot's own anchor announce. Harmless on a peer that hosts
            // nothing: neither one has anything to say there.
            sendControl: (sc) => sendToParent({ type: "world_cmd", cmd: sc }),
            // …but only the PLATFORM's elected host coordinates sessions. My
            // role INSIDE a session says who hosts that cluster's sim; the
            // platform's role says who clusters the call. After a split every
            // authority is an "owner", and handing the engine's coordinator to
            // each of them would put two of them on one planet (see
            // `coordinates` in quest-boot.ts).
            coordinates: snapshot.role === "owner",
            // The engine's session book moved under this boot (a coordinator
            // spoke, or this peer's own coordinator self-applied its roster).
            onSession: (assignment) => adoptAssignment(assignment),
            // WHICH SESSION this world is being built for, what was already
            // said about it, and where its player was standing a moment ago —
            // the three facts a boot needs before its first poll could answer
            // (quest-boot ⑧/⑨).
            session: sessionSnap,
            ...(replayControl.length ? { replayControl } : {}),
            ...(carriedLoc ? { carriedLoc } : {}),
          }
        : undefined,
      worldVoice,
    );
    bootedMp = snapshot;
    bootedSession = sessionSnap;
    // A payload the fresh boot ACCEPTED is spent: keeping it would let a later
    // reboot into the same session re-install a snapshot of a world that has
    // since been played. One that was declined is dropped for the same reason
    // (this engine cannot read it, and it will not read it later either).
    if (sessionSnap) {
      const got = quest.handoverStatus().received;
      if (got === "applied" || got === "declined") handoversBySession.delete(sessionSnap.sessionId);
    }
    // REPLAY the roster in force into the fresh host. A reboot builds a whole
    // new host, whose session book starts empty, and the coordinator announces
    // only when the epoch MOVES — so without this the new world forgets which
    // session it belongs to, and on the coordinating peer its own next pass
    // would mint a fresh epoch-0 roster (new session ids) and reboot it again.
    if (liveAssign) quest.applySessionControl(assignControl(liveAssign.epoch, liveAssign.sessions));
    // Forward the latest roster right after boot — covers a world_session
    // (peers-only OR identity) that raced this build and landed while it was
    // still in flight; peersTarget already holds whatever arrived meanwhile.
    // Session-scoped, so a reboot never spawns a peer this world can't see.
    quest.setPeers(sessionPeers());
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
    // …AND the same place in the session book: session id + my role inside it +
    // whose sim I replicate (N6b-g). Session-mates are not identity — they
    // re-filter the roster instead (adoptAssignment).
    const sessionMatches = sessionIdentity(bootedSession) === sessionIdentity(sessionTarget);
    if (closed || (matches && sessionMatches)) return;
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
