// shared/world-engine/interaction/text/session.ts
//
// THE PROJECTION, DRIVEN. `createTextModeSession` wires the pure pieces —
// visibility (§3), the scene index (§4), the bubble diff (laws ②/③), the board
// printer (law ④), the crowd pass (law ⑤) — to a boot that owns the host, the
// view and the clock (`TextSessionDeps`, types.ts).
//
// Two rules shape everything here:
//
//   • BYPASS THE PIXELS, NEVER THE SIM (law ⑥). Every act reaches the world
//     through the host's existing string inputs — `speak` and `select`. There is
//     no text-only simulation path, and this file must never grow one.
//   • EVERY COMMAND ENDS WITH A SETTLE (§5). Step until quiet (0.75 s with no
//     new event) capped at 8 s, and close with EXACTLY ONE `TICK`. `wait n`
//     steps exactly n sim-seconds instead. A command that produced no line at
//     all still says so — silence is reported, never implied.
//
// The presenter tap FANS OUT: `addPresenterTap` registers a partial presenter
// beside the real one, so board pushes and toasts are recorded without the AAC
// board ever losing them.
//
// PHASE 1 (design §8 step ④). Not here, on purpose:
//   TODO step ⑦  full crowd pass (city-HUD mirror line, richer ASK discriminators)
//   TODO step ⑧  builder driving (`build` grammar, press/screen accounting)
//   TODO step ⑨  movement (`go`/`approach`/`stop`, ENTER/EXIT, the steering NOTE
//                 that `look <id>` must print once looking steers a walker)
//   TODO step ⑩  watching (D6 deltas)
//   TODO step ⑪  the cheat channel (a different object, prefix and FILE — law ⑦)

import type { WorldState } from "../../engine.js";
import type { QuestBoardView } from "../quest/quest-host.js";
import { baseWord } from "../lang/core.js";
import { languageFor } from "../lang/index.js";
import { boardEvents, findBoardOption, findChrome, textBoardOptions } from "./board.js";
import { parseCommand, TEXT_COMMANDS } from "./parse.js";
import { renderEvents } from "./render.js";
import { createSceneIndex } from "./scene-index.js";
import { diffBubbles, EMPTY_BUBBLES, type BubbleSnapshot } from "./speech.js";
import { summarizePlaces, summarizeScene } from "./summarize.js";
import { indefiniteArticle, inViewSet, visibleSubjects, wordFor } from "./visibility.js";
import {
  SETTLE_CAP_S,
  SETTLE_QUIET_S,
  WAIT_DEFAULT_S,
  isParseError,
  type SceneEntry,
  type TextBoardOption,
  type TextCommand,
  type TextEvent,
  type TextFrame,
  type TextModeSession,
  type TextSessionDeps,
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

export function createTextModeSession(deps: TextSessionDeps): TextModeSession {
  const lang = languageFor(deps.locale);
  const quietS = deps.settle?.quietS ?? SETTLE_QUIET_S;
  const capS = deps.settle?.capS ?? SETTLE_CAP_S;
  const index = createSceneIndex({ ...(deps.nameOf ? { nameOf: deps.nameOf } : {}) });

  /** Events the presenter tap recorded since the last drain. */
  const pending: TextEvent[] = [];
  let bubbles: BubbleSnapshot = EMPTY_BUBBLES;
  let boardView: QuestBoardView | null = null;
  let boardBlock: TextEvent | null = null;
  let boardButtons: TextBoardOption[] = [];
  let lastScene: VisibleScene | null = null;

  // ── the presenter tap — fans out, never replaces ──────────────────────────
  deps.addPresenterTap({
    board(view) {
      boardView = view;
      boardButtons = textBoardOptions(view.options);
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
    won() {
      pending.push({ tag: "WON" });
    },
  });

  // ── wording helpers (payloads are locale-aware, tags never are) ───────────
  const activityPhrase = (a: { verb: string; object?: string } | undefined): string | undefined => {
    if (!a) return undefined;
    const verb = baseWord(lang, a.verb);
    return a.object ? `${verb} ${baseWord(lang, headOf(a.object))}` : verb;
  };

  const placeLabel = (space: string | null): string =>
    space ? (index.textIdOf(space) ?? space) : "outdoors";

  const entryOf = (s: VisibleSubject): SceneEntry => {
    const detail: string[] = [];
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

  // ── the frame drain: probe → speech diff → presenter pending ──────────────
  /** Read the view exactly as a renderer would, and turn the frame into events. */
  function drainFrame(): TextEvent[] {
    const probe = deps.view.probe();
    const state = probe.state;
    if (!state) return pending.splice(0);

    const viewer = viewerIdOf(state);
    const scene = visibleSubjects(state, viewer, {
      ...(deps.locale ? { locale: deps.locale } : {}),
      ...(deps.activityOf ? { activityOf: deps.activityOf } : {}),
      ...(deps.nameOf ? { nameOf: deps.nameOf } : {}),
    });
    index.assign(scene.subjects);
    index.assign(scene.places);
    lastScene = scene;

    const { events, next } = diffBubbles(bubbles, state, {
      inView: inViewSet(scene),
      textIdOf: (id) => index.textIdOf(id),
    });
    bubbles = next;
    return [...events, ...pending.splice(0)];
  }

  /** §5 — step until quiet, capped; exactly one TICK closes it. */
  function settle(): TextEvent[] {
    const out: TextEvent[] = [];
    let elapsed = 0;
    let quiet = 0;
    while (elapsed < capS) {
      deps.stepFrame();
      elapsed += deps.frameDt;
      const evs = drainFrame();
      if (evs.length) {
        out.push(...evs);
        quiet = 0;
      } else {
        quiet += deps.frameDt;
      }
      if (quiet >= quietS) break;
    }
    out.push({ tag: "TICK", reason: quiet >= quietS ? "quiet" : "capped", seconds: elapsed });
    return out;
  }

  /** `wait n` — exactly n sim-seconds, no early exit (§5). */
  function stepExactly(seconds: number): TextEvent[] {
    const frames = Math.max(1, Math.round(seconds / deps.frameDt));
    const out: TextEvent[] = [];
    for (let i = 0; i < frames; i++) {
      deps.stepFrame();
      out.push(...drainFrame());
    }
    out.push({ tag: "TICK", reason: "waited", seconds: frames * deps.frameDt });
    return out;
  }

  /** The current scene, re-probed without stepping (a query must not move time
   *  before it answers — the settle after it does that). */
  function currentScene(): VisibleScene | null {
    const probe = deps.view.probe();
    if (!probe.state) return lastScene;
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

  function sceneEvents(): TextEvent[] {
    const scene = currentScene();
    if (!scene?.me) return [{ tag: "NOTE", text: "no world is loaded yet." }];
    const probe = deps.view.probe();
    const summary = summarizeScene(scene.subjects, {
      ...(probe.intent?.conversation ? { conversation: probe.intent.conversation } : {}),
    });

    const entries: SceneEntry[] = summary.named.map(entryOf);
    for (const g of summary.groups) {
      entries.push({
        kind: "group",
        count: g.count,
        ...bucketWord(g.head, g.word, g.count),
        band: g.band,
        cardinal: g.cardinal,
        ...(g.verb ? { activity: baseWord(lang, g.verb) } : {}),
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

    return [{ tag: "SELF", where: `you are ${placeLabel(scene.me.space)}.`, facts }];
  }

  function lookEvents(target: string): TextEvent[] {
    const scene = currentScene();
    if (!scene?.me) return [{ tag: "NOTE", text: "no world is loaded yet." }];
    const hit = index.resolve(target);
    if (hit.kind === "none") return [{ tag: "ERR", text: `nothing here called "${target}".` }];
    if (hit.kind === "many") {
      // §4: ambiguity is ASKED, never guessed. Phase 1 discriminates by band +
      // cardinal + room; TODO step ⑦ adds appearance and activity to the order.
      const all = [...scene.subjects, ...scene.places];
      const options = hit.ids.map((id) => {
        const s = all.find((c) => c.id === id);
        const textId = index.textIdOf(id) ?? id;
        return s ? `${textId} — ${s.band} ${s.cardinal}, ${placeLabel(s.space)}` : `${textId} — out of view`;
      });
      return [{ tag: "ASK", question: `which "${target}"?`, options }];
    }

    const all = [...scene.subjects, ...scene.places];
    const s = all.find((c) => c.id === hit.id);
    if (!s) {
      return [{ tag: "ERR", text: `${hit.textId} is not in view.` }];
    }
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
      const activity = activityPhrase(s.activity);
      if (activity) facts.push(`${activity}.`);
      if (s.holding.length) {
        facts.push(`holding ${s.holding.map((h) => index.textIdOf(h) ?? h).join(", ")}.`);
      }
    }
    // TODO step ⑨: in a walker scope `look` also STEERS, and must print the NOTE
    // saying so — hiding that coupling would hide the gap class this harness
    // exists to find. Phase 1 does not move, so it does not claim to.
    return [{ tag: "LOOK", textId: s.textId, word: s.name ?? s.word, facts }];
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
          "board            — reprint the buttons on screen",
          "say <words>      — compose and speak (words join with +)",
          "press <n|label>  — press a button by number or caption",
          "more / back      — the board's own paging buttons",
          `wait [n]         — let ${WAIT_DEFAULT_S}s (or n) of world time pass`,
          "help             — this list",
        ],
      },
    ];
  }

  // ── acts (law ⑥: through the host's own string inputs) ────────────────────
  function pressOption(o: TextBoardOption): TextEvent[] {
    deps.host.select(o.id);
    return [{ tag: "OK", text: `pressed ${o.n}. ${o.label}` }];
  }

  function frame(events: TextEvent[]): TextFrame {
    return { events, lines: renderEvents(events) };
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
        if (!boardView) return frame([{ tag: "ERR", text: "no board is open." }]);
        const o = findChrome(boardButtons, cmd.kind);
        if (!o) return frame([{ tag: "ERR", text: `this board has no "${cmd.kind}" button.` }]);
        return frame([...pressOption(o), ...settle()]);
      }
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
  };
}
