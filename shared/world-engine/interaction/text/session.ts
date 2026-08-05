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
import { indefiniteArticle, inViewSet, spaceOf, visibleSubjects, wordFor } from "./visibility.js";
import {
  ARRIVE_R,
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
  const index = createSceneIndex({ ...(deps.nameOf ? { nameOf: deps.nameOf } : {}) });

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

    return [...events, ...deltas, ...pending.splice(0)];
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

    const body = state.avatars[standing.simId];
    const obj = state.objects[standing.simId];
    let to: { x: number; y: number } | null = null;
    let kind: InteractKind = "object";
    if (body) {
      to = { x: body.x, y: body.y };
      kind = "avatar";
    } else if (obj) {
      to = { x: obj.x, y: obj.y };
    } else {
      const b = (state.spec.buildings ?? []).find((q) => q.id === standing.simId);
      if (b) to = { x: b.footprint.x + b.footprint.w / 2, y: b.footprint.y + b.footprint.h / 2 };
    }
    if (!to) return null;
    // `approach` runs the SAME `approachAim` the GL gaze does, so the body stops
    // at conversation distance and the host's own dwell opens the conversation.
    return standing.approach ? approachAim({ x: me.x, y: me.y }, to, kind) : to;
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
  function settle(): TextEvent[] {
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
      if (quiet >= quietS && !aim) break;
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
        text: `about ${city.population} more people live in this city (${districts} districts).`,
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
    ];
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

  function lookEvents(query: string): TextEvent[] {
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
    // §4: IN A WALKER SCOPE, LOOKING ALSO STEERS. That is the engine's real
    // coupling, and hiding it would hide the gap class this harness exists to
    // find. Text mode's `look` is a QUERY and does not feed the pointer — so the
    // note says exactly that, once, rather than pretending either way.
    if (!steeringNoted && !deps.spirit && deps.look) {
      steeringNoted = true;
      out.push({
        tag: "NOTE",
        text: "in a walker scope a resting gaze also STEERS you toward what it rests on — this `look` only reports, so use go/approach to move.",
      });
    }
    return out;
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
          "watch <thing> / unwatch <thing|all> / watching",
          `wait [n]         — let ${WAIT_DEFAULT_S}s (or n) of world time pass`,
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
   * `send <creature> to <id>` — PARSED, DELIBERATELY NOT WIRED.
   *
   * The action exists in the sim (`PlayerAction` `sendTo` / `attendObject`,
   * dispatched by `performPlayerAction`), but no PUBLIC host method reaches it
   * from a single-player headless boot: `applyRemoteCommand` is the only entry
   * that takes a `PlayerAction`, and it returns immediately unless the host was
   * built with multiplayer and this peer is the OWNER. Law ⑥ forbids inventing a
   * path, so this answers honestly instead of pretending to act.
   */
  function sendEvents(creature: string, to: string): TextEvent[] {
    return [
      {
        tag: "ERR",
        text: `not wired yet (needs a host command channel — step ⑨ TODO): send ${creature} to ${to}.`,
      },
    ];
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
      case "look":
        return frame([...(cmd.target ? lookEvents(cmd.target) : sceneEvents()), ...settle()]);
      case "where":
        return frame([...whereEvents(cmd.target), ...settle()]);
      case "who":
        return frame([...whoEvents(), ...settle()]);
      case "wait":
        return frame(stepExactly(cmd.seconds));
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
      case "send":
        return frame(sendEvents(cmd.creature, cmd.target));
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
