// shared/world-engine/interaction/text/session.ts
//
// THE PROJECTION, DRIVEN. `createTextModeSession` wires the pure pieces —
// visibility (§3), the scene index (§4), the bubble diff (laws ②/③), the board
// printer and the builder (law ④), the crowd pass (law ⑤), the watch book (§6),
// the cheat channel (law ⑦) — to a boot that owns the host, the view and the
// clock (`TextSessionDeps`, types.ts).
//
// Four rules shape everything here:
//
//   • BYPASS THE PIXELS, NEVER THE SIM (law ⑥). Every act reaches the world
//     through the host's existing inputs — `speak`, `select`, and (for movement)
//     the POINTER, fed at a world point because the text view's screen map is
//     the identity. There is no text-only simulation path, and this file must
//     never grow one.
//   • EVERY COMMAND ENDS WITH A SETTLE (§5). Step until quiet (0.75 s with no
//     new event AND no standing aim still un-arrived) capped at 8 s, and close
//     with EXACTLY ONE `TICK`. `wait n` steps exactly n sim-seconds; a TRAVEL
//     settle runs to arrival, capped at 60 s.
//   • A CROWD IS SUMMARIZED, AN INDIVIDUAL IS NAMED (law ⑤) — and that governs
//     the STREAM as much as the scene, which is why `ENTER`/`EXIT` are diffed
//     over the TRACKED set (watch.ts's header states the whole rule).
//   • THE CHEAT CHANNEL IS A DIFFERENT CHANNEL (law ⑦): its output goes to
//     `TextFrame.cheatLines`, and only a `CHEAT` marker joins the transcript.
//
// The presenter tap FANS OUT: `addPresenterTap` registers a partial presenter
// beside the real one, so board pushes, toasts and the CITY HUD are recorded
// without the AAC board ever losing them.

import type { WorldState } from "../../engine.js";
import { approachAim, type InteractKind } from "../../interact.js";
import type { QuestBoardView } from "../quest/quest-host.js";
import type { BuildOverlayView } from "../quest/build-overlay-3d.js";
import type { Cardinal, Proximity } from "../dialogue/directions.js";
import { baseWord } from "../lang/core.js";
import { languageFor } from "../lang/index.js";
import { boardEvents, findBoardOption, findChrome, textBoardOptions } from "./board.js";
import { createTextBuilder, type TextBuilder } from "./builder.js";
import { CHEATS_DISABLED, runCheat } from "./cheats.js";
import { parseCommand, TEXT_COMMANDS } from "./parse.js";
import { renderEvents } from "./render.js";
import { createSceneIndex } from "./scene-index.js";
import { diffBubbles, EMPTY_BUBBLES, type BubbleSnapshot } from "./speech.js";
import { summarizePlaces, summarizeScene } from "./summarize.js";
import { createWatchBook } from "./watch.js";
import {
  bandOf,
  cardinalFrom,
  indefiniteArticle,
  inViewSet,
  singularWord,
  spaceOf,
  visibleSubjects,
  wordFor,
} from "./visibility.js";
import {
  ARRIVE_R,
  LOOK_SETTLE_QUIET_S,
  SETTLE_CAP_S,
  SETTLE_QUIET_S,
  TRAVEL_CAP_S,
  WAIT_DEFAULT_S,
  WATCH_CAP,
  isParseError,
  type SceneEntry,
  type TextBoardOption,
  type TextCommand,
  type TextEvent,
  type TextFrame,
  type TextModeSession,
  type TextSessionDeps,
  type TextSessionStats,
  type TextSiteEntry,
  type TextSpotEntry,
  type VisibleScene,
  type VisibleSubject,
} from "./types.js";

/** The head of a composed glyph ("home.color_blue" → "home"). */
function headOf(glyph: string): string {
  return glyph.split(".")[0]!;
}

/**
 * WHOSE EYES. GL's reveal rule keys on the view's construction-time `localId`
 * (render3d `revealedInteriors(state, this.localId, …)`) — the spark's own body,
 * even while it drives another. Text mode matches that so the two renderers
 * cannot disagree about what is revealed (law ①); it falls back to the driven
 * body only when the spark has no body at all.
 */
function viewerIdOf(state: WorldState): string {
  if (state.avatars[state.localId]) return state.localId;
  return state.drivenId;
}

/** The body-id spellings a quest ENTITY id may wear once it is embodied
 *  (quest-host `avatarIdOf`) — the same ladder speech.ts attributes through. */
function bodyCandidates(entityId: string): string[] {
  return [entityId, `npc_${entityId}`, `resident_${entityId}`, `pet_${entityId}`];
}

/** THE CITY HUD, structurally — the only shape this layer reads off a `city`
 *  push. Never population.ts (law ①: a cohort is a statistic, not a body). */
interface CityChipLike {
  district: number | "city";
  population: number;
}

export function createTextModeSession(deps: TextSessionDeps): TextModeSession {
  const lang = languageFor(deps.locale);
  const quietS = deps.settle?.quietS ?? SETTLE_QUIET_S;
  const capS = deps.settle?.capS ?? SETTLE_CAP_S;
  const travelCapS = deps.travel?.capS ?? TRAVEL_CAP_S;
  const arriveR = deps.travel?.arriveR ?? ARRIVE_R;
  const watchCap = deps.watchCap ?? WATCH_CAP;
  const index = createSceneIndex({
    ...(deps.nameOf ? { nameOf: deps.nameOf } : {}),
    // A crowd line prints the ruleset's plural, so the ruleset is what turns it
    // back into the stem the ids are latched under.
    singularOf: (word) => singularWord(lang, word),
  });

  /** Events the presenter tap recorded since the last drain. */
  const pending: TextEvent[] = [];
  let bubbles: BubbleSnapshot = EMPTY_BUBBLES;
  let boardView: QuestBoardView | null = null;
  let boardBlock: TextEvent | null = null;
  let boardButtons: TextBoardOption[] = [];
  let lastScene: VisibleScene | null = null;
  let lastState: WorldState | null = null;

  /** ACQUAINTANCE (law ⑤ rank ②, "previously met"). A body whose board you have
   *  opened, or whom you have HEARD SPEAK in front of you — text mode narrates a
   *  line only when the speaker passes the §3 filter, so hearing one IS meeting
   *  them. Session-local: the world never told us a name for these. */
  const met = new Set<string>();

  /** The CITY HUD, once it has shown (law ⑤'s mirror line). */
  let cityChips: CityChipLike[] = [];
  /** THE DOLLHOUSE FAMILY HUD, as last pushed (see the `family` tap). */
  let familyChips: {
    cid: string;
    label: string;
    state: string;
    present: boolean;
    selected: boolean;
  }[] = [];

  // ── step ⑧ ────────────────────────────────────────────────────────────────
  const builder: TextBuilder = createTextBuilder({
    ...(deps.locale ? { locale: deps.locale } : {}),
    ...(deps.grid !== undefined ? { grid: deps.grid } : {}),
    ...(deps.nouns ? { nouns: deps.nouns } : {}),
  });
  /** Is the BUILDER the surface `more`/`back` page, or the board? */
  let builderOpen = false;
  /** Law ④'s measurement. `compo` marks where the CURRENT composition began. */
  let commands = 0;
  let presses = 0;
  let screens = 0;
  let compo: { presses: number; screens: number } | null = null;

  // ── step ⑨ ────────────────────────────────────────────────────────────────
  /** THE STANDING AIM: the subject the pointer is re-fed at every frame until
   *  the body arrives. Null = the pointer is wherever it was last left. */
  let aim: { simId: string; approach: boolean } | null = null;
  /** §4's coupling note — printed ONCE, the first time it could bite. */
  let steeringNoted = false;

  // ── ⑦ the build overlay's own diff (see `buildDeltas`) ───────────────────
  let lastSpotSig = "";
  let lastSiteSig = "";

  // ── step ⑩ ────────────────────────────────────────────────────────────────
  const watchBook = createWatchBook({
    label: (id) => index.textIdOf(id) ?? id,
    activityPhrase: (a) => activityPhrase(a),
    cap: watchCap,
  });

  // ── the presenter tap — fans out, never replaces ──────────────────────────
  deps.addPresenterTap({
    board(view) {
      boardView = view;
      builderOpen = false; // a real board owns the screen while it is up
      boardButtons = textBoardOptions(view.options);
      // A BOARD OPENING IS AN INTRODUCTION: from here on this creature is
      // somebody you have met, and law ⑤ names them in a crowd.
      for (const id of bodyCandidates(view.posedByEntityId)) met.add(id);
      const evs = boardEvents(view, { posedByLabel: (id) => index.textIdOf(id) ?? id });
      boardBlock = evs[0] ?? null;
      pending.push(...evs);
    },
    clearBoard() {
      boardView = null;
      boardBlock = null;
      boardButtons = [];
      pending.push({ tag: "CLOSE" });
    },
    toast(text, kind) {
      pending.push({ tag: "TOAST", text, ...(kind ? { kind } : {}) });
    },
    objectives(list) {
      for (const o of list) pending.push({ tag: "GOAL", text: o.nodeId, locked: o.locked });
    },
    pocket(items) {
      pending.push({
        tag: "POCKET",
        items: items.map((i) => ({
          label: i.label,
          glyph: i.glyph,
          count: i.count,
          selected: i.selected,
        })),
      });
    },
    family(members) {
      // RECORDED, NOT STREAMED. The chips re-push whenever any member's state
      // changes, which is constantly; a line per push would drown the
      // transcript. `family` prints them, and the SCENE mirrors nothing —
      // exactly how a HUD behaves for a sighted player.
      familyChips = members.map((m) => ({
        cid: m.id,
        label: m.label,
        state: m.state,
        present: m.present,
        selected: m.selected,
      }));
    },
    city(chips) {
      // RECORDED, NEVER ENUMERATED (law ⑤). The cohorts behind these numbers are
      // statistics; the scene mirrors the HUD's single line and nothing more.
      cityChips = chips.map((c) => ({ district: c.district, population: c.population }));
    },
    won() {
      pending.push({ tag: "WON" });
    },
  });

  // ── wording helpers (payloads are locale-aware, tags never are) ───────────
  function activityPhrase(a: { verb: string; object?: string } | undefined): string | undefined {
    if (!a) return undefined;
    const verb = baseWord(lang, a.verb);
    return a.object ? `${verb} ${baseWord(lang, headOf(a.object))}` : verb;
  }

  const placeLabel = (space: string | null): string =>
    space ? (index.textIdOf(space) ?? space) : "outdoors";

  /** A BUILDING, in the words a transit is narrated with ("the blue house"). */
  function placePhrase(buildingId: string): string {
    const p = lastScene?.places.find((q) => q.id === buildingId);
    if (!p) return index.textIdOf(buildingId) ?? buildingId;
    return p.color ? `the ${p.color} ${p.word}` : `the ${p.word}`;
  }

  const entryOf = (s: VisibleSubject): SceneEntry => {
    const detail: string[] = [];
    if (s.dress) detail.push(`in ${s.dress}`);
    if (s.holding.length) {
      detail.push(`holding ${s.holding.map((h) => index.textIdOf(h) ?? h).join(", ")}`);
    }
    const activity = activityPhrase(s.activity);
    return {
      kind: "subject",
      textId: s.textId,
      word: s.word,
      band: s.band,
      cardinal: s.cardinal,
      ...(activity ? { activity } : {}),
      ...(detail.length ? { detail } : {}),
    };
  };

  // ── the frame drain: probe → speech diff → watch deltas → presenter ───────
  /** THE TRACKED SET (watch.ts's header): watched, the travel target, and
   *  everyone law ⑤ would already have named. Anonymous crowd stays crowd. */
  function trackedSet(scene: VisibleScene, conversation: readonly string[]): Set<string> {
    const t = new Set<string>(watchBook.set());
    if (aim) t.add(aim.simId);
    for (const m of conversation) t.add(m);
    for (const s of scene.subjects) {
      if (s.name || met.has(s.id) || index.isReferenced(s.id)) t.add(s.id);
    }
    return t;
  }

  /** THE VISIBLE TRANSIT behind an `EXIT` — a doorway the viewer could read.
   *  A body that simply walked out of range gets no `via`, and says so. */
  function transitOf(simId: string, prevSpace: string | null): string | undefined {
    const state = lastState;
    const body = state?.avatars[simId];
    if (!state || !body) return undefined;
    const now = spaceOf(state, body);
    if (now === prevSpace) return undefined;
    if (now) return `into ${placePhrase(now)}`;
    if (prevSpace) return `out of ${placePhrase(prevSpace)}`;
    return undefined;
  }

  /** Read the view exactly as a renderer would, and turn the frame into events. */
  function drainFrame(): TextEvent[] {
    const probe = deps.view.probe();
    const state = probe.state;
    if (!state) return pending.splice(0);
    lastState = state;

    const viewer = viewerIdOf(state);
    const scene = visibleSubjects(state, viewer, {
      ...(deps.locale ? { locale: deps.locale } : {}),
      ...(deps.activityOf ? { activityOf: deps.activityOf } : {}),
      ...(deps.nameOf ? { nameOf: deps.nameOf } : {}),
    });
    index.assign(scene.subjects);
    index.assign(scene.places);
    lastScene = scene;

    const inView = inViewSet(scene);
    const { events, next, speakers } = diffBubbles(bubbles, state, {
      inView,
      textIdOf: (id) => index.textIdOf(id),
    });
    bubbles = next;
    // A LINE HEARD IN FRONT OF YOU IS AN INTRODUCTION (law ⑤ rank ②). Your own
    // bodies are not strangers, so they are never "met".
    for (const id of speakers) {
      if (id !== viewer && id !== state.drivenId) met.add(id);
    }

    const deltas = watchBook.step(scene, {
      tracked: trackedSet(scene, probe.intent?.conversation?.members ?? []),
      transitOf,
    });

    return [...events, ...deltas, ...buildDeltas(probe.build), ...pending.splice(0)];
  }

  // ── movement (§4/D3, law ⑥ — the pointer path and nothing else) ───────────
  /** The point the pointer is fed at THIS frame: the target's CURRENT position,
   *  or `approachAim`'s stop-short point when the driver said `approach`. */
  function aimPoint(): { x: number; y: number } | null {
    const state = lastState ?? deps.view.probe().state;
    const standing = aim;
    if (!state || !standing) return null;
    const me = state.avatars[state.drivenId] ?? state.avatars[viewerIdOf(state)];
    if (!me) return null;

    const to = subjectPoint(standing.simId);
    if (!to) return null;
    // `approach` runs the SAME `approachAim` the GL gaze does, so the body stops
    // at conversation distance and the host's own dwell opens the conversation.
    return standing.approach ? approachAim({ x: me.x, y: me.y }, to, to.kind) : { x: to.x, y: to.y };
  }

  /** Metres from the driven body to the aim POINT (not to the target: for
   *  `approach` the point already stands off at conversation distance). */
  function aimDistance(): number {
    const state = lastState;
    const p = aimPoint();
    if (!state || !p) return Infinity;
    const me = state.avatars[state.drivenId] ?? state.avatars[viewerIdOf(state)];
    if (!me) return Infinity;
    return Math.hypot(me.x - p.x, me.y - p.y);
  }

  /** RE-FEED THE STANDING AIM. Called before every stepped frame while an aim
   *  stands, which is what makes it STANDING: the target keeps walking, and the
   *  pointer keeps pointing at where it is now. */
  function feedAim(): boolean {
    if (!aim || !deps.look) return false;
    const p = aimPoint();
    if (!p) return false;
    deps.look(p.x, p.y);
    return true;
  }

  /** §5 — step until quiet, capped; exactly one TICK closes it. A standing aim
   *  that has not arrived is NOT quiet, so a walk started elsewhere keeps being
   *  driven by whatever command follows it. */
  function settle(quietFor: number = quietS): TextEvent[] {
    const out: TextEvent[] = [];
    let elapsed = 0;
    let quiet = 0;
    while (elapsed < capS) {
      feedAim();
      deps.stepFrame();
      elapsed += deps.frameDt;
      const evs = drainFrame();
      if (evs.length) {
        out.push(...evs);
        quiet = 0;
      } else {
        quiet += deps.frameDt;
      }
      if (aim && aimDistance() <= arriveR) aim = null;
      if (quiet >= quietFor && !aim) break;
    }
    out.push({ tag: "TICK", reason: quiet >= quietS && !aim ? "quiet" : "capped", seconds: elapsed });
    return out;
  }

  /** §5's TRAVEL settle: step to ARRIVAL, capped at 60 s. On arrival the world
   *  is given its ordinary quiet window before the tick closes — that is when a
   *  dwell fires and the conversation board arrives, which is the whole point of
   *  `approach`. */
  function settleTravel(): TextEvent[] {
    const out: TextEvent[] = [];
    let elapsed = 0;
    let arrived = false;
    let remaining = Infinity;

    while (elapsed < travelCapS) {
      if (!feedAim()) break;
      deps.stepFrame();
      elapsed += deps.frameDt;
      out.push(...drainFrame());
      remaining = aimDistance();
      if (remaining <= arriveR) {
        arrived = true;
        break;
      }
    }

    if (!arrived) {
      return [
        ...out,
        {
          tag: "TICK",
          reason: "walking",
          seconds: elapsed,
          metres: Number.isFinite(remaining) ? Math.round(remaining) : 0,
        },
      ];
    }

    // ARRIVED. The pointer is deliberately NOT cleared: in GL the gaze rests
    // where you walked to, and that resting IS the dwell that opens the talk.
    aim = null;
    const deadline = elapsed + capS;
    let quiet = 0;
    while (elapsed < deadline && quiet < quietS) {
      deps.stepFrame();
      elapsed += deps.frameDt;
      const evs = drainFrame();
      if (evs.length) {
        out.push(...evs);
        quiet = 0;
      } else {
        quiet += deps.frameDt;
      }
    }
    out.push({ tag: "TICK", reason: "arrived", seconds: elapsed });
    return out;
  }

  /** `wait n` — exactly n sim-seconds, no early exit (§5). */
  function stepExactly(seconds: number): TextEvent[] {
    const frames = Math.max(1, Math.round(seconds / deps.frameDt));
    const out: TextEvent[] = [];
    for (let i = 0; i < frames; i++) {
      feedAim();
      deps.stepFrame();
      out.push(...drainFrame());
      if (aim && aimDistance() <= arriveR) aim = null;
    }
    out.push({ tag: "TICK", reason: "waited", seconds: frames * deps.frameDt });
    return out;
  }

  /** ⏩ `warp <n>d` — the books jump n economy days, then the world settles.
   *
   *  The `# warp` comment is emitted whatever the answer, including a REFUSAL:
   *  a transcript that silently omitted a warp the harness declined would be
   *  lying about what the driver asked for. A refusal settles too (nothing
   *  moved, so the settle is the usual quiet one) — every command still ends
   *  with exactly one TICK. */
  function warpEvents(days: number): TextEvent[] {
    const warp = deps.host.advanceLedgerDays;
    if (!warp) {
      return [
        { tag: "ERR", text: "this boot has no clock warp (the host predates it)." },
        ...settle(),
      ];
    }
    const r = warp.call(deps.host, days);
    return [
      { tag: "WARP", ok: r.ok, days: r.days, edges: r.edges, text: r.note },
      ...settle(),
    ];
  }

  /** The current scene, re-probed without stepping (a query must not move time
   *  before it answers — the settle after it does that). */
  function currentScene(): VisibleScene | null {
    const probe = deps.view.probe();
    if (!probe.state) return lastScene;
    lastState = probe.state;
    const viewer = viewerIdOf(probe.state);
    const scene = visibleSubjects(probe.state, viewer, {
      ...(deps.locale ? { locale: deps.locale } : {}),
      ...(deps.activityOf ? { activityOf: deps.activityOf } : {}),
      ...(deps.nameOf ? { nameOf: deps.nameOf } : {}),
    });
    index.assign(scene.subjects);
    index.assign(scene.places);
    lastScene = scene;
    return scene;
  }

  // ── answers ──────────────────────────────────────────────────────────────
  /** The word a bucket of `count` is counted by, with its article at one. */
  function bucketWord(head: string, word: string, count: number): Pick<SceneEntry, "word" | "article"> {
    if (count !== 1) return { word: wordFor(lang, head, count) };
    const article = indefiniteArticle(lang, head);
    return { word, ...(article ? { article } : {}) };
  }

  /** THE CITY-HUD MIRROR LINE (law ⑤). The cohorts are statistics — they are not
   *  in view, they are not people the scene may enumerate, and this ONE trailing
   *  line is the only place they may surface. Read off the HUD push, never off
   *  population.ts (law ①). */
  function cityMirror(): TextEvent[] {
    if (!cityChips.length) return [];
    const city = cityChips.find((c) => c.district === "city");
    if (!city) return [];
    const districts = cityChips.filter((c) => c.district !== "city").length;
    return [
      {
        tag: "NOTE",
        text: `about ${city.population} more people live in this city (${districts} district${districts === 1 ? "" : "s"}).`,
      },
    ];
  }

  function sceneEvents(): TextEvent[] {
    const scene = currentScene();
    if (!scene?.me) return [{ tag: "NOTE", text: "no world is loaded yet." }];
    const probe = deps.view.probe();
    const addressee = deps.addresseeOf?.();
    const summary = summarizeScene(scene.subjects, {
      ...(probe.intent?.conversation ? { conversation: probe.intent.conversation } : {}),
      ...(addressee ? { addressee } : {}),
      watched: watchBook.set(),
      known: (id) => met.has(id),
    });

    const entries: SceneEntry[] = summary.named.map(entryOf);
    for (const g of summary.groups) {
      const detail: string[] = [];
      // §6: a signature shared by ≥2 LABELS the group ("2 people in red").
      if (g.dress) detail.push(`in ${g.dress}`);
      entries.push({
        kind: "group",
        count: g.count,
        ...bucketWord(g.head, g.word, g.count),
        band: g.band,
        cardinal: g.cardinal,
        ...(g.verb ? { activity: baseWord(lang, g.verb) } : {}),
        ...(detail.length ? { detail } : {}),
      });
    }

    // §3: places are LANDMARKS — outline only. Law ⑤ applies to them too: only
    // a NOTABLE place earns its own line, and the rest of the skyline is
    // counted. (Without this a town prints all 82 of its houses.)
    const places = summarizePlaces(scene.places, { referenced: (id) => index.isReferenced(id) });
    for (const p of places.notable) {
      const detail: string[] = [];
      if (p.color) detail.push(p.color);
      if (p.doorOpen) detail.push("door open");
      detail.push(p.revealed ? "you can see inside" : "shut to you");
      entries.push({
        kind: "place",
        textId: p.textId,
        word: p.word,
        band: p.band,
        cardinal: p.cardinal,
        detail,
      });
    }
    for (const g of places.groups) {
      const detail: string[] = [];
      if (g.color) detail.push(`all ${g.color}`);
      if (g.allShut) detail.push("all shut");
      entries.push({
        kind: "place-group",
        count: g.count,
        ...bucketWord(g.head, g.word, g.count),
        band: g.band,
        cardinal: g.cardinal,
        ...(g.collapsed ? { collapsed: true } : {}),
        ...(detail.length ? { detail } : {}),
      });
    }

    return [
      {
        tag: "SCENE",
        place: placeLabel(scene.me.space),
        count: scene.subjects.length,
        places: scene.places.length,
        entries,
      },
      ...cityMirror(),
      // ⑦ — WORK UNDER WAY IS PART OF THE SCENE. A GL player sees a staked
      // floor and a hauler feeding it; a text player used to see an unchanged
      // room and a toast that scrolled away. Sites ride the scene rather than
      // waiting for a command, because construction is something you notice.
      ...siteEvents(),
    ];
  }

  // ── ⑦ the lit ground and the live sites ──────────────────────────────────
  /**
   * TEXT IDS FOR GROUND. A spot is not a body — it has no record in `state`, so
   * the scene index (which latches subjects off the frame) cannot hold one.
   * Same law though: an id, once given, is that patch of ground's for the
   * session, so `look plot-2` means the same place on turn 40 as on turn 3.
   */
  const spotIndex = (() => {
    const byRaw = new Map<string, string>();
    const byText = new Map<string, string>();
    const counts = new Map<string, number>();
    return {
      idFor(rawId: string, stem: string): string {
        const had = byRaw.get(rawId);
        if (had) return had;
        const n = (counts.get(stem) ?? 0) + 1;
        counts.set(stem, n);
        const textId = `${stem}-${n}`;
        byRaw.set(rawId, textId);
        byText.set(textId, rawId);
        return textId;
      },
      rawOf: (textId: string): string | undefined => byText.get(textId),
    };
  })();

  /** Bearings from the viewer to a world rect's centre — the same band/cardinal
   *  vocabulary every other line uses, so a spot reads like a place does. */
  function bearingTo(r: { x: number; y: number; w: number; h: number }):
    | { band: Proximity; cardinal: Cardinal; distance: number }
    | null {
    const state = lastState ?? deps.view.probe().state;
    if (!state) return null;
    const body = state.avatars[viewerIdOf(state)];
    if (!body) return null;
    const to = { x: r.x + r.w / 2, y: r.y + r.h / 2 };
    const distance = Math.hypot(to.x - body.x, to.y - body.y);
    return { band: bandOf(distance), cardinal: cardinalFrom(body, to), distance };
  }

  /** WHAT A SPOT IS, in words — the tone the wash is drawn in, said out loud. */
  function spotWhat(sp: { kind?: string; word?: string }): string {
    switch (sp.kind) {
      case "lot":
        return "free ground";
      case "grow":
        return "room-shaped gap";
      case "room":
        return sp.word ? `the ${sp.word}` : "a room";
      case "site":
        return "work under way";
      case "building":
        return "the building";
      default:
        return "ground";
    }
  }

  /**
   * ⑦ — THE GROUND LIGHTING UP IS AN EVENT. In GL, pressing the build word
   * washes the ground and the player sees the offer without asking; a
   * projection that waited to be asked would hide the surface entirely (the
   * board deliberately says almost nothing — the lit ground IS the menu).
   *
   * Diffed, so a steady frame is silent: the SPOT set by id + which one the
   * spark holds, and each site by its visible STAGE (a floor going down is
   * news; the progress fraction creeping is not).
   */
  function buildDeltas(build: BuildOverlayView | null | undefined): TextEvent[] {
    const spotSig =
      (build?.spots ?? []).map((s) => s.id).join("|") +
      "/" +
      ((build?.spots ?? []).find((s) => s.focused)?.id ?? "");
    const siteSig = (build?.sites ?? []).map((s) => `${s.id}:${s.stage}`).join("|");
    const out: TextEvent[] = [];
    if (spotSig !== lastSpotSig) {
      const hadSpots = lastSpotSig !== "" && !lastSpotSig.startsWith("/");
      lastSpotSig = spotSig;
      // Ground going DARK is worth one line — but only when it was LIT, never
      // as a greeting on the first frame of a world that has no build word up.
      if (build?.spots.length) out.push(...spotEvents());
      else if (hadSpots) out.push({ tag: "NOTE", text: "the lit ground goes out." });
    }
    if (siteSig !== lastSiteSig) {
      const had = lastSiteSig;
      lastSiteSig = siteSig;
      if (had) out.push(...siteEvents());
    }
    return out;
  }

  /**
   * THE FAMILY HUD, and the ADDRESS it carries. Two things a dollhouse session
   * is entirely about and text mode could not see: what each member's state is
   * ("Mara is hungry" — the sentence the whole household loop exists to
   * produce), and WHOM a spoken order will reach. The chip is a real host
   * input (`selectFamilyMember`, law ⑥), so addressing here is the same act a
   * player performs by dwelling on the chip.
   */
  function familyEvents(who?: string): TextEvent[] {
    if (!familyChips.length) {
      return [{ tag: "NOTE", text: "there is no household here." }];
    }
    if (who) {
      const q = who.trim().toLowerCase();
      const hit =
        familyChips.find((c) => c.label.toLowerCase() === q) ??
        familyChips.find((c) => (index.textIdOf(c.cid) ?? "").toLowerCase() === q) ??
        familyChips.find((c) => c.label.toLowerCase().startsWith(q));
      if (!hit) {
        return [
          {
            tag: "ERR",
            text: `nobody in the household called "${who}". Try: ${familyChips.map((c) => c.label).join(", ")}.`,
          },
        ];
      }
      if (!deps.host.selectFamilyMember) {
        return [{ tag: "ERR", text: "this build has no family chip wired." }];
      }
      deps.host.selectFamilyMember(hit.cid);
      return [
        {
          tag: "OK",
          text: hit.selected ? `stopped addressing ${hit.label}.` : `addressing ${hit.label}.`,
        },
      ];
    }
    return [
      {
        tag: "FAMILY",
        entries: familyChips.map((c) => ({
          cid: c.cid,
          textId: index.textIdOf(c.cid) ?? c.label.toLowerCase(),
          label: c.label,
          state: c.state,
          present: c.present,
          addressed: c.selected,
        })),
      },
    ];
  }

  function spotEvents(): TextEvent[] {
    const build = deps.view.probe().build;
    const spots = build?.spots ?? [];
    const entries: TextSpotEntry[] = [];
    for (const sp of spots) {
      const b = bearingTo(sp);
      if (!b) continue;
      entries.push({
        textId: spotIndex.idFor(sp.id, sp.kind === "grow" || sp.kind === "lot" ? "plot" : "spot"),
        what: spotWhat(sp),
        ...(sp.offers?.length ? { offers: sp.offers.map((o) => baseWord(lang, o)) } : {}),
        band: b.band,
        cardinal: b.cardinal,
        distance: b.distance,
        ...(sp.focused ? { focused: true } : {}),
      });
    }
    const focused = spots.find((s) => s.focused);
    return [
      {
        tag: "SPOT",
        entries,
        ...(focused ? { focused: spotIndex.idFor(focused.id, "spot") } : {}),
      },
    ];
  }

  function siteEvents(): TextEvent[] {
    const sites = deps.view.probe().build?.sites ?? [];
    const entries: TextSiteEntry[] = [];
    for (const c of sites) {
      const b = bearingTo(c);
      // `word`, never `glyph`: the glyph is the drawn composition and speaking
      // it would put a picture in a sentence.
      if (!b || !c.word) continue;
      entries.push({
        textId: spotIndex.idFor(c.id, "site"),
        word: baseWord(lang, c.word),
        stage: c.stage,
        ...(c.progress !== undefined ? { progress: c.progress } : {}),
        // ④ #43 — the gather readout rides through verbatim; the head is a
        // stack head and is worded by the same lang layer as everything else.
        ...(c.gathering ? { gathering: c.gathering } : {}),
        band: b.band,
        cardinal: b.cardinal,
        distance: b.distance,
      });
    }
    return entries.length ? [{ tag: "SITE", entries }] : [];
  }

  function selfEvents(): TextEvent[] {
    const scene = currentScene();
    const probe = deps.view.probe();
    const state = probe.state;
    if (!state || !scene?.me) return [{ tag: "NOTE", text: "no world is loaded yet." }];

    const facts: string[] = [];
    const held = Object.values(state.objects)
      .filter((o) => o.carriedBy === scene.me!.id || o.carriedBy === state.drivenId)
      .map((o) => index.textIdOf(o.id) ?? o.id);
    facts.push(held.length ? `holding ${held.join(", ")}.` : "holding nothing.");

    // §3: `RenderIntent.cursor.hoverId` / `interactId` is what `self` reports as
    // "you are looking at X" — the renderer's own pick, not a re-derived guess.
    const looking = probe.intent?.cursor?.hoverId ?? probe.intent?.interactId;
    facts.push(looking ? `looking at ${index.textIdOf(looking) ?? looking}.` : "looking at nothing.");

    const conv = probe.intent?.conversation;
    if (conv?.members?.length) {
      const others = conv.members
        .filter((m) => m !== scene.me!.id)
        .map((m) => index.textIdOf(m) ?? m);
      facts.push(others.length ? `talking with ${others.join(", ")}.` : "in a conversation alone.");
    }
    if (scene.me.floor !== 0) facts.push(`on floor ${scene.me.floor}.`);
    if (aim) {
      facts.push(`walking to ${index.textIdOf(aim.simId) ?? aim.simId}.`);
    }
    if (deps.spirit) facts.push("you are a bodiless spirit here.");

    // "you are IN house-1", never "you are house-1" — the space is a location,
    // not an identity (outdoors has no container, so no preposition).
    const at = scene.me.space === null ? placeLabel(null) : `in ${placeLabel(scene.me.space)}`;
    return [{ tag: "SELF", where: `you are ${at}.`, facts }];
  }

  // ── §4: ambiguity is ASKED, never guessed ────────────────────────────────
  /** The discriminator ladder, in the design's own priority order: proximity
   *  band → cardinal → containing room → distinguishing appearance → activity.
   *  The FIRST rung that tells every candidate apart is the one printed. */
  const DISCRIMINATORS: readonly { of: (s: VisibleSubject) => string }[] = [
    { of: (s) => s.band },
    { of: (s) => s.cardinal },
    { of: (s) => placeLabel(s.space) },
    { of: (s) => s.dress ?? s.appearance.join(" ") },
    { of: (s) => activityPhrase(s.activity) ?? "" },
  ];

  function askOptions(ids: readonly string[]): string[] {
    const all = [...(lastScene?.subjects ?? []), ...(lastScene?.places ?? [])];
    const rows = ids.map((id) => ({ id, s: all.find((c) => c.id === id) }));
    for (const d of DISCRIMINATORS) {
      const vals = rows.map((r) => (r.s ? d.of(r.s) : ""));
      if (vals.every((v) => v) && new Set(vals).size === vals.length) {
        return rows.map((r, i) => `${index.textIdOf(r.id) ?? r.id} — ${vals[i]}`);
      }
    }
    // Nothing on the ladder separates them: say everything the ladder had.
    return rows.map((r) =>
      r.s
        ? `${index.textIdOf(r.id) ?? r.id} — ${r.s.band} ${r.s.cardinal}, ${placeLabel(r.s.space)}`
        : `${index.textIdOf(r.id) ?? r.id} — out of view`,
    );
  }

  type Resolved =
    | { ok: true; subject: VisibleSubject }
    | { ok: false; events: TextEvent[] };

  /** Resolve driver input to ONE subject in view, or the events that say why not. */
  function resolveTarget(query: string): Resolved {
    const scene = currentScene();
    if (!scene?.me) return { ok: false, events: [{ tag: "NOTE", text: "no world is loaded yet." }] };
    const hit = index.resolve(query);
    if (hit.kind === "none") {
      return { ok: false, events: [{ tag: "ERR", text: `nothing here called "${query}".` }] };
    }
    if (hit.kind === "many") {
      return {
        ok: false,
        events: [{ tag: "ASK", question: `which "${query}"?`, options: askOptions(hit.ids) }],
      };
    }
    const all = [...scene.subjects, ...scene.places];
    const s = all.find((c) => c.id === hit.id);
    if (!s) return { ok: false, events: [{ tag: "ERR", text: `${hit.textId} is not in view.` }] };
    return { ok: true, subject: s };
  }

  /**
   * ⑦ — LOOKING AT GROUND. A lit spot has no body to resolve against, so it
   * gets its own arm: the spark goes to the rect's centre, which is the exact
   * point `spotAt` tests, and the ordinary settle then lets the host's own long
   * dwell settle on it. This is the whole of "aim at a plot to build" — no new
   * sim path, just the pointer a GL player's eyes already feed (law ⑥).
   */
  function lookGroundEvents(query: string): TextEvent[] | null {
    const raw = spotIndex.rawOf(query);
    if (!raw || !deps.look) return null;
    const build = deps.view.probe().build;
    const rect =
      build?.spots.find((s) => s.id === raw) ?? build?.sites.find((s) => s.id === raw) ?? null;
    if (!rect) return [{ tag: "ERR", text: `${query} is not lit any more.` }];
    deps.look(rect.x + rect.w / 2, rect.y + rect.h / 2);
    const b = bearingTo(rect);
    return [
      {
        tag: "LOOK",
        textId: query,
        word: "ground",
        facts: b
          ? [`${b.band} ${b.cardinal}, ${Math.round(b.distance)} m away.`, "your gaze rests on it."]
          : ["your gaze rests on it."],
      },
    ];
  }

  function lookEvents(query: string): TextEvent[] {
    const ground = lookGroundEvents(query);
    if (ground) return ground;
    const r = resolveTarget(query);
    if (!r.ok) return r.events;
    const s = r.subject;
    // THE DRIVER NAMED IT, so it stops being scenery: a place they asked about
    // keeps its own SCENE line from here on instead of folding back into the
    // skyline the moment they look away.
    index.markReferenced(s.id);

    const facts: string[] = [`${s.band} ${s.cardinal}, ${Math.round(s.distance)} m away.`];
    if (s.kind === "place") {
      if (s.color) facts.push(`${s.color} walls.`);
      facts.push(s.revealed ? "you can see inside." : "you cannot see inside.");
    } else {
      facts.push(`${placeLabel(s.space)}.`);
      if (s.dress) facts.push(`dressed in ${s.dress}.`);
      const activity = activityPhrase(s.activity);
      if (activity) facts.push(`${activity}.`);
      if (s.holding.length) {
        facts.push(`holding ${s.holding.map((h) => index.textIdOf(h) ?? h).join(", ")}.`);
      }
    }

    const out: TextEvent[] = [{ tag: "LOOK", textId: s.textId, word: s.name ?? s.word, facts }];
    // §4 — LOOKING IS RESTING THE SPARK ON IT. The pointer is not a sibling of
    // the spark: `setPointer` IS the spark's input, and everything downstream
    // (the dwell, the highlight, `hoverTargetOf`, what a build spot answers)
    // reads the intent the gaze pipeline makes of it. A `look` that only
    // reported would be a SECOND attention channel the engine does not have —
    // the driver would be told it is looking at something the world does not
    // believe it is looking at, which is the one thing this harness must never
    // do. So the query feeds the gaze, exactly as a GL player's eyes do.
    lookAt(s);
    // …and in a walker scope that resting gaze also STEERS, so a standing walk
    // to somewhere ELSE is genuinely over — said once, rather than silently
    // fighting the aim on the next frame.
    if (aim && aim.simId !== s.id && !deps.spirit) {
      const was = index.textIdOf(aim.simId) ?? aim.simId;
      aim = null;
      out.push({
        tag: "NOTE",
        text: `a resting gaze STEERS in a walker scope, so looking at ${s.textId} called off the walk to ${was}.`,
      });
    } else if (!steeringNoted && !deps.spirit && deps.look) {
      steeringNoted = true;
      out.push({
        tag: "NOTE",
        text: "in a walker scope a resting gaze also STEERS you toward what it rests on — `look` feeds it, so looking is aiming.",
      });
    }
    return out;
  }

  /** Rest the spark on a subject/place — the ONE aiming primitive (law ⑥: the
   *  host's own pointer input, never a side door). A place is aimed at through
   *  its own centre, which is what a GL player's gaze lands on. */
  function lookAt(s: VisibleSubject): void {
    if (!deps.look) return;
    const at = subjectPoint(s.id);
    if (at) deps.look(at.x, at.y);
  }

  /** WHERE A THING IS, from the same records the renderer draws it from — a
   *  body, a loose object, else the building footprint's centre. ONE owner:
   *  both the spark (`lookAt`) and the walk (`aimPoint`) ask this. */
  function subjectPoint(simId: string): { x: number; y: number; kind: InteractKind } | null {
    const state = lastState ?? deps.view.probe().state;
    if (!state) return null;
    const body = state.avatars[simId];
    if (body) return { x: body.x, y: body.y, kind: "avatar" };
    const obj = state.objects[simId];
    if (obj) return { x: obj.x, y: obj.y, kind: "object" };
    const b = (state.spec.buildings ?? []).find((q) => q.id === simId);
    return b
      ? { x: b.footprint.x + b.footprint.w / 2, y: b.footprint.y + b.footprint.h / 2, kind: "object" }
      : null;
  }

  function whereEvents(query: string): TextEvent[] {
    const r = resolveTarget(query);
    if (!r.ok) return r.events;
    const s = r.subject;
    return [
      { tag: "WHERE", textId: s.textId, band: s.band, cardinal: s.cardinal, distance: s.distance },
    ];
  }

  function whoEvents(): TextEvent[] {
    const conv = deps.view.probe().intent?.conversation;
    const members = (conv?.members ?? []).map((m) => index.textIdOf(m) ?? m);
    return [{ tag: "WHO", members }];
  }

  function boardAnswer(): TextEvent[] {
    if (!boardBlock) return [{ tag: "NOTE", text: "no board is open." }];
    return [boardBlock];
  }

  function helpEvents(): TextEvent[] {
    return [
      {
        tag: "HELP",
        commands: [
          "look [thing]     — describe one thing (or the whole scene)",
          "scene            — everything in view",
          "self             — where you are, what you hold, what you look at",
          "where <thing>    — its band, direction and distance",
          "who              — who is in the conversation",
          "board            — reprint the buttons on screen",
          "spots            — the lit ground + what is being built (look <plot-n> aims at it)",
          "family [who]     — the household's states; with a name, address them",
          "say <words>      — compose and speak (words join with +)",
          "press <n|label>  — press a button by number or caption",
          "more / back      — page the board, or the builder listing",
          "builder          — reprint the sentence-builder screen",
          "build <word|n>   — tap a word (.word taps the modifier rail)",
          "build tab <name> / build group <id> / build undo / build clear",
          "build play       — speak what you composed",
          "go <thing>       — walk to it",
          "approach <who>   — walk to conversation distance and stop",
          "stop             — stop walking",
          "send <who> to <thing> — tell somebody to go to it",
          "watch <thing> / unwatch <thing|all> / watching",
          `wait [n]         — let ${WAIT_DEFAULT_S}s (or n) of world time pass`,
          "warp <n>d        — jump the BOOKS n economy days (no bodies move)",
          "help             — this list",
        ],
      },
    ];
  }

  // ── acts (law ⑥: through the host's own inputs) ───────────────────────────
  function pressOption(o: TextBoardOption): TextEvent[] {
    presses += 1;
    deps.host.select(o.id);
    return [{ tag: "OK", text: `pressed ${o.n}. ${o.label}` }];
  }

  /** Law ④'s counter: a screen is a screen whoever printed it. */
  function countScreens(events: readonly TextEvent[]): void {
    for (const e of events) if (e.tag === "BOARD" || e.tag === "BUILDER") screens += 1;
  }

  function frame(events: TextEvent[], cheatLines?: string[]): TextFrame {
    countScreens(events);
    return {
      events,
      lines: renderEvents(events),
      ...(cheatLines ? { cheatLines } : {}),
    };
  }

  // ── step ⑧: the builder ──────────────────────────────────────────────────
  /** The composition's cost is measured FROM ITS START, so the mark is taken the
   *  first time the driver touches the builder after a play/clear. */
  function beginComposition(): void {
    if (!compo) compo = { presses, screens };
  }

  function builderEvents(cmd: Extract<TextCommand, { kind: "build" }>): TextEvent[] {
    beginComposition();
    builderOpen = true;
    const arg = cmd.arg ?? "";

    switch (cmd.op) {
      case "show":
        return [builder.block()];
      case "play": {
        presses += 1;
        const sentence = builder.play();
        if (!sentence) {
          return [{ tag: "ERR", text: "nothing composed yet — press some words first." }];
        }
        // Law ⑥: the composition reaches the world through `speak`, exactly like
        // a `say`. The LINE that comes back is read off the bubble (law ②).
        deps.host.speak(sentence);
        const usedPresses = presses - (compo?.presses ?? presses);
        const usedScreens = screens - (compo?.screens ?? screens);
        compo = null;
        builderOpen = false;
        return [
          { tag: "OK", text: `said: ${sentence}` },
          // LAW ④'s MEASUREMENT. Reachability is the finding, so it is printed
          // with the utterance and not left for a reader to count.
          { tag: "NOTE", text: `reached in ${usedPresses} presses across ${usedScreens} screens.` },
        ];
      }
      case "word":
      case "tab":
      case "group":
      case "undo":
      case "clear": {
        presses += 1;
        const r =
          cmd.op === "word"
            ? builder.tap(arg)
            : cmd.op === "tab"
              ? builder.setTab(arg)
              : cmd.op === "group"
                ? builder.setGroup(arg)
                : cmd.op === "undo"
                  ? builder.undo()
                  : (builder.clear(), { ok: true as const });
        if (!r.ok) return [{ tag: "ERR", text: r.error ?? "that did nothing." }];
        return [builder.block()];
      }
    }
  }

  // ── step ⑨: movement ─────────────────────────────────────────────────────
  function goEvents(query: string, approach: boolean): { events: TextEvent[]; travel: boolean } {
    // A SPIRIT HAS NO FEET. Never a silent no-op: the driver must learn that the
    // scope, not the command, is what refused — and what to do instead.
    if (deps.spirit) {
      return {
        events: [
          {
            tag: "ERR",
            text: "you are a bodiless spirit here — act through a creature (family/send) or claim a body.",
          },
        ],
        travel: false,
      };
    }
    if (!deps.look) {
      return {
        events: [{ tag: "ERR", text: "this build has no pointer wired, so nothing can walk." }],
        travel: false,
      };
    }
    const r = resolveTarget(query);
    if (!r.ok) return { events: r.events, travel: false };
    const s = r.subject;
    index.markReferenced(s.id);
    aim = { simId: s.id, approach };
    return {
      events: [
        {
          tag: "OK",
          text: approach ? `approaching ${s.textId}.` : `walking to ${s.textId}.`,
        },
      ],
      travel: true,
    };
  }

  function stopEvents(): TextEvent[] {
    const was = aim;
    aim = null;
    deps.clearLook?.();
    return [{ tag: "OK", text: was ? `stopped walking to ${index.textIdOf(was.simId) ?? was.simId}.` : "not walking." }];
  }

  /**
   * `send <creature> to <id>` — THE SPIRIT'S ONE ACT (§4, law ⑥).
   *
   * A pointer player performs this by resting the gaze on somebody and then on
   * a place: the aim arbitration reads an ORDER out of the pair and the host
   * puts a `PlayerAction` through its gate (`parse-intent`'s `sendTo` /
   * `attendObject` / `attendCreature`). Text mode has no pointer to pair, so it
   * issues the very same three actions through the host's LOCAL COMMAND CHANNEL
   * (`QuestHost3D.perform`) — the same gate, the same executor, no text-only sim
   * path. What resolves to which:
   *
   *   creature → `attendCreature`  (go and attend that person)
   *   object   → `attendObject`    (at the object's own point)
   *   place    → `sendTo`          (at the building's FOOTPRINT CENTRE)
   *
   * The centre, not a doorstep, because it is what `subjectPoint` already gives
   * the spark and the walk — ONE owner for "where a thing is" — and because the
   * engine's routing is door-aware: a point inside a house is reached through
   * its door, which is exactly what "go to the blue house" means.
   *
   * SPIRIT SCOPES ARE THE POINT — a bodiless dollhouse spirit has nothing to
   * walk but everything to direct, so `send` is never gated on embodiment. And
   * it is never gated on the creature's WILLINGNESS either: refusing is the
   * willingness system's job, and its refusal (a line, or a pointed silence)
   * is the feedback the driver reads off the bubbles after the settle.
   */
  function sendEvents(creature: string, to: string): { events: TextEvent[]; sent: boolean } {
    const no = (text: string): { events: TextEvent[]; sent: boolean } => ({
      events: [{ tag: "ERR", text }],
      sent: false,
    });
    // FEATURE-DETECTED, NEVER THROWN AT: an older boot (a vendored snapshot
    // predating the channel) still runs the whole harness — it simply cannot
    // command, and says so.
    const issue = deps.host.perform?.bind(deps.host);
    if (!issue) {
      return no(`not wired yet (needs a host command channel — step ⑨ TODO): send ${creature} to ${to}.`);
    }
    const who = resolveTarget(creature);
    if (!who.ok) return { events: who.events, sent: false };
    const actor = who.subject;
    // ONLY A CREATURE CAN BE SENT. A chair has no legs and a house does not go
    // anywhere — and the action names the walker in `cid`, so this is what the
    // sim would reject anyway, answered here where the driver can read it.
    if (actor.kind !== "creature") {
      return no(`${actor.textId} is a ${actor.word} — only somebody with legs can be sent.`);
    }
    const target = resolveTarget(to);
    if (!target.ok) return { events: target.events, sent: false };
    const dest = target.subject;
    if (dest.id === actor.id) return no(`${actor.textId} is already there.`);
    const at = dest.kind === "creature" ? null : subjectPoint(dest.id);
    if (dest.kind !== "creature" && !at) return no(`nothing here can tell where ${dest.textId} is.`);
    // The driver named both, so neither folds back into the scenery (§4).
    index.markReferenced(actor.id);
    index.markReferenced(dest.id);
    issue(
      dest.kind === "creature"
        ? { kind: "attendCreature", cid: actor.id, id: dest.id }
        : dest.kind === "object"
          ? { kind: "attendObject", cid: actor.id, id: dest.id, x: at!.x, y: at!.y }
          : { kind: "sendTo", cid: actor.id, x: at!.x, y: at!.y },
    );
    return {
      events: [{ tag: "OK", text: `told ${actor.textId} to go to ${dest.textId}.` }],
      sent: true,
    };
  }

  // ── step ⑩: watching ─────────────────────────────────────────────────────
  function watchEvents(query: string): TextEvent[] {
    const r = resolveTarget(query);
    if (!r.ok) return r.events;
    const s = r.subject;
    const added = watchBook.add(s.id);
    if (added === "full") {
      return [
        {
          tag: "ERR",
          text: `already watching ${watchCap} things — the cap is ${watchCap}. Unwatch one first.`,
        },
      ];
    }
    index.markReferenced(s.id);
    if (added === "already") return [{ tag: "NOTE", text: `already watching ${s.textId}.` }];
    return [{ tag: "WATCH", textId: s.textId, on: true }];
  }

  function unwatchEvents(query: string): TextEvent[] {
    if (query === "all") {
      const n = watchBook.clear();
      return [{ tag: "OK", text: n ? `stopped watching ${n} thing(s).` : "nothing was being watched." }];
    }
    // UNWATCH RESOLVES OFF THE LATCH, not off the current view: the whole point
    // of a watch surviving an EXIT is that you can call it off while the body is
    // still out of sight.
    const hit = index.resolve(query);
    const simId = hit.kind === "one" ? hit.id : undefined;
    if (!simId || !watchBook.has(simId)) {
      return [{ tag: "ERR", text: `not watching "${query}".` }];
    }
    watchBook.remove(simId);
    return [{ tag: "WATCH", textId: index.textIdOf(simId) ?? simId, on: false }];
  }

  function watchingEvents(): TextEvent[] {
    return [{ tag: "WATCH", list: watchBook.ids().map((id) => index.textIdOf(id) ?? id) }];
  }

  // ── step ⑪: the cheat channel ────────────────────────────────────────────
  function cheatFrame(name: string, arg: string | undefined): TextFrame {
    if (!deps.cheats) {
      return frame([{ tag: "ERR", text: CHEATS_DISABLED }]);
    }
    const r = runCheat(name, arg, {
      host: deps.cheatHost,
      simIdOf: (textId) => index.simIdOf(textId),
      recordOf: (simId) => {
        const state = lastState ?? deps.view.probe().state;
        if (!state) return null;
        return {
          simId,
          textId: index.textIdOf(simId) ?? null,
          avatar: state.avatars[simId] ?? null,
          object: state.objects[simId] ?? null,
          npcSpec: (state.spec.npcs ?? []).find((n) => n.id === simId) ?? null,
          objectSpec: (state.spec.objects ?? []).find((o) => o.id === simId) ?? null,
          building: (state.spec.buildings ?? []).find((b) => b.id === simId) ?? null,
        };
      },
    });
    if (!r.ok) return frame([{ tag: "ERR", text: r.error ?? "that cheat did nothing." }]);
    // EXACTLY ONE MARKER in the ordinary stream, so a reviewer knows the tester
    // peeked; the peek itself never joins `lines` (law ⑦).
    return frame([{ tag: "CHEAT", text: r.marker }], r.lines);
  }

  function perform(cmd: TextCommand): TextFrame {
    switch (cmd.kind) {
      case "help":
        return frame([...helpEvents(), ...settle()]);
      case "scene":
        return frame([...sceneEvents(), ...settle()]);
      case "self":
        return frame([...selfEvents(), ...settle()]);
      case "board":
        return frame([...boardAnswer(), ...settle()]);
      case "spots":
        // Reprinting the ground costs nothing and moves nothing — but the
        // settle keeps the one-TICK-per-command rule intact.
        return frame([...spotEvents(), ...siteEvents(), ...settle()]);
      case "family":
        return frame([...familyEvents(cmd.who), ...settle()]);
      case "look": {
        if (!cmd.target) return frame([...sceneEvents(), ...settle()]);
        const evs = lookEvents(cmd.target);
        // A FED GAZE IS NOT QUIET UNTIL ITS DWELL HAS ANSWERED (§5's rule for a
        // standing aim, applied to the other thing the pointer does). The host
        // opens a board only after the gaze SETTLES and then rests — the smoother
        // has to converge and the long dwell has to run — which is longer than
        // the ordinary quiet window. Ending the command first made `look plot-3`
        // followed by `press` a race the driver lost, silently: the press landed
        // on the previous board.
        const settled = settle(LOOK_SETTLE_QUIET_S);
        // WHERE THE SPARK ACTUALLY LANDED. The gaze snaps to what is DRAWN at
        // the point (the body standing in the room, the bubble over its head),
        // so aiming at a place can rest the spark on somebody in it — and what
        // the world thinks you are looking at is what a dwell will act on.
        // Reported, never hidden: this coupling is the harness's whole job.
        const looked = evs.find((e) => e.tag === "LOOK");
        const landed = deps.view.probe().intent?.cursor?.hoverId;
        const landedText = landed ? (index.textIdOf(landed) ?? landed) : null;
        const note: TextEvent[] =
          looked?.tag === "LOOK" && landedText && landedText !== looked.textId
            ? [{ tag: "NOTE", text: `your gaze rests on ${landedText}, which is what is drawn there.` }]
            : [];
        return frame([...evs, ...note, ...settled]);
      }
      case "where":
        return frame([...whereEvents(cmd.target), ...settle()]);
      case "who":
        return frame([...whoEvents(), ...settle()]);
      case "wait":
        return frame(stepExactly(cmd.seconds));
      // ⏩ THE CLOCK WARP (⑬). The books jump; nothing walks. The `# warp` line
      //    lands FIRST so a transcript reads in order, and then the ordinary
      //    SETTLE runs — the world's own reaction to a week of ledgers (a
      //    stake-out toast, a board that changed) is play, and play is what a
      //    settle is for. The TICK that closes the command therefore reports
      //    the SETTLE's seconds, never the warped span: no time was played.
      case "warp":
        return frame(warpEvents(cmd.days));
      case "say": {
        // The driver's own composition, handed to the host verbatim. The line
        // that comes back is read off the bubble like any other (law ②) — this
        // never narrates the player's speech itself.
        const sentence = cmd.words.join(" + ");
        deps.host.speak(sentence);
        return frame([{ tag: "OK", text: `said: ${sentence}` }, ...settle()]);
      }
      case "press": {
        if (!boardView) return frame([{ tag: "ERR", text: "no board is open." }]);
        const o = findBoardOption(boardButtons, {
          ...(cmd.index !== undefined ? { index: cmd.index } : {}),
          ...(cmd.label !== undefined ? { label: cmd.label } : {}),
        });
        if (!o) {
          return frame([
            {
              tag: "ERR",
              text: `no such button. This page has 1–${boardButtons.length}.`,
            },
          ]);
        }
        return frame([...pressOption(o), ...settle()]);
      }
      case "more":
      case "back": {
        // THE BUILDER OWNS THE PAGING while it is the open surface — a tab
        // listing pages at the grid, exactly like a board page does.
        if (builderOpen && !boardView) {
          beginComposition();
          presses += 1;
          const r = builder.page(cmd.kind);
          if (!r.ok) return frame([{ tag: "ERR", text: r.error ?? "no such page." }]);
          return frame([builder.block(), ...settle()]);
        }
        if (!boardView) return frame([{ tag: "ERR", text: "no board is open." }]);
        const o = findChrome(boardButtons, cmd.kind);
        if (!o) return frame([{ tag: "ERR", text: `this board has no "${cmd.kind}" button.` }]);
        return frame([...pressOption(o), ...settle()]);
      }
      case "builder":
        return frame([...builderEvents({ kind: "build", op: "show" }), ...settle()]);
      case "build":
        return frame([...builderEvents(cmd), ...settle()]);
      case "go": {
        const g = goEvents(cmd.target, cmd.approach === true);
        return frame([...g.events, ...(g.travel ? settleTravel() : [])]);
      }
      case "stop":
        return frame([...stopEvents(), ...settle()]);
      case "send": {
        // Issued, then SETTLED like any other act: the creature's answer — a
        // line, or the law-③ silence — is what tells the driver whether it was
        // taken. A refusal moved no time, so it closes with no TICK.
        const s = sendEvents(cmd.creature, cmd.target);
        return frame([...s.events, ...(s.sent ? settle() : [])]);
      }
      case "watch":
        return frame([...watchEvents(cmd.target), ...settle()]);
      case "unwatch":
        return frame([...unwatchEvents(cmd.target), ...settle()]);
      case "watching":
        return frame([...watchingEvents(), ...settle()]);
      case "cheat":
        return cheatFrame(cmd.name, cmd.arg);
    }
  }

  return {
    command(input) {
      const parsed = parseCommand(input);
      if (isParseError(parsed)) {
        // A rejected line executes nothing, so it settles nothing — and closes
        // with no TICK, because no time passed.
        return frame([
          { tag: "ERR", text: parsed.error },
          { tag: "NOTE", text: `commands: ${TEXT_COMMANDS.join(", ")}.` },
        ]);
      }
      commands += 1;
      return perform(parsed);
    },
    perform,
    drain() {
      return frame(drainFrame());
    },
    currentBoard() {
      return boardBlock;
    },
    textIdOf: (simId) => index.textIdOf(simId),
    simIdOf: (textId) => index.simIdOf(textId),
    sessionStats(): TextSessionStats {
      return { commands, presses, screens };
    },
    watching() {
      return watchBook.ids().map((id) => index.textIdOf(id) ?? id);
    },
  };
}
