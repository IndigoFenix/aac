/**
 * The symbol game in the lab, played through the shared quest host
 * (shared/symbol-game/quest-host). Two entry points share one stage scaffold:
 *   • bootLivingTown — the town scope: a real createTownWorld economy whose
 *     residents are the quest-givers and stream around a WALKING avatar.
 *   • bootStructure  — the structure scope: a freestanding creature-quest
 *     puzzle (buildCreatureQuestWorld). With avatar "spirit" it plays as the
 *     stationary, formless puzzle mode — dwell on things to pick/place/talk, no
 *     walking.
 *
 * Unlike every map scope (rendered into the lab's own orbit scene), the quest
 * host hands its own canvas to the world engine and answers conversations on the
 * REAL response board — the shared `BoardButtonVisual`, mounted as a small React
 * island (board-island.tsx), pixel-identical to the student's board.
 */
import { avatarKind, type LoadedWorld } from "@shared/engine/manifest";
import { buildTownScope } from "@shared/symbol-game/town-play-game";
import {
  buildCreatureQuestWorld,
  certifyCreatureQuestWorld,
  type CreatureWorldParams,
} from "@shared/symbol-game/creature-quests";
import type { TownPlay } from "@shared/symbol-game/town-play";
import {
  createQuestHost3D,
  type QuestBoardView,
  type QuestHost3D,
  type QuestSession,
} from "@shared/symbol-game/quest-host";
import type { GoalTreeGame } from "@shared/goal-tree/types";
import type { ObjectiveSummary } from "@shared/goal-tree/space";
import type { GoalNode } from "@shared/goal-tree/types";
import { labImageResolver } from "./glyph-resolver";
import { mountBoardIsland, type BoardIsland } from "./board-island";

export interface QuestBoot {
  dispose(): void;
}

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  parent: HTMLElement,
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  node.className = className;
  parent.appendChild(node);
  return node;
};

/** The objective chip's face — a compact port of the player's ObjectivesBar. */
function objectiveEmoji(node: GoalNode | undefined, icon: (id: string) => string): string {
  switch (node?.type) {
    case "reach": return icon(node.markerEntityId);
    case "collect": return icon(node.itemEntityIds[0]!);
    case "choose": return `${icon(node.posedByEntityId)}❓`;
    case "overcome": return icon(node.obstacleEntityId);
    case "observe": return `${icon(node.stageEntityId)}👁`;
    case "transport": return `${icon(node.objectEntityId)}📦`;
    case "converse": return `${icon(node.npcEntityId)}💬`;
    case "fulfill":
      return `${icon(node.npcEntityId)}${node.needItemEntityId ? icon(node.needItemEntityId) : "💬"}`;
    default: return "❔";
  }
}

interface QuestStartOpts {
  /** A living-town session (its residents stream in), or null for a
   *  freestanding structure puzzle. */
  town?: TownPlay | null;
  /** SPIRIT avatar — stationary, formless, gaze-only interaction. */
  spirit?: boolean;
  /** Status-line detail (build stats). */
  detail: string;
}

/** Mount the quest host + the real response board in the lab and start `game`.
 *  Shared by the living-town and structure boots. */
function bootQuestGame(
  container: HTMLElement,
  game: GoalTreeGame,
  setStatus: (text: string) => void,
  opts: QuestStartOpts,
): QuestBoot {
  // ── DOM scaffold: a stage (canvas + overlays) beside the real board ──────
  const root = el("div", "quest-root", container);
  const stage = el("div", "quest-stage", root);
  const canvas = el("canvas", "quest-canvas", stage);
  const objectivesEl = el("div", "quest-objectives", stage);
  const satchelEl = el("div", "quest-satchel", stage);
  const toastEl = el("div", "quest-toast", stage);
  const winEl = el("div", "quest-win", stage);
  const boardPanel = el("div", "quest-boardpanel", root);
  toastEl.hidden = true;
  winEl.hidden = true;

  let toastTimer: ReturnType<typeof setTimeout> | null = null;
  let session: QuestSession | null = null;
  let host: QuestHost3D | null = null;

  // The REAL board (shared BoardButtonVisual), driven by the host's board view.
  const board: BoardIsland = mountBoardIsland(boardPanel, (id) => host?.select(id));
  const iconOf = (id: string) => session?.entities.get(id)?.iconRef ?? "❔";

  const presenter = {
    sessionStarted(s: QuestSession) {
      session = s;
      board.set(null);
      winEl.hidden = true;
      objectivesEl.textContent = "";
      satchelEl.textContent = "";
    },
    board(view: QuestBoardView) { board.set(view); },
    clearBoard() { board.set(null); },
    toast(text: string) {
      toastEl.textContent = text;
      toastEl.hidden = false;
      if (toastTimer) clearTimeout(toastTimer);
      toastTimer = setTimeout(() => { toastEl.hidden = true; }, 3500);
    },
    objectives(objectives: ObjectiveSummary[]) {
      objectivesEl.textContent = "";
      for (const o of objectives) {
        const chip = el("span", `quest-chip${o.locked ? " locked" : ""}`, objectivesEl);
        const node = session?.ctx.nodeById.get(o.nodeId);
        chip.textContent = `${objectiveEmoji(node, iconOf)}${o.locked ? "🔒" : ""}`;
      }
    },
    collect() { /* the objectives strip is enough for the lab */ },
    satchel(inventory: Record<string, number>) {
      const held = Object.entries(inventory).filter(([, n]) => n > 0);
      satchelEl.textContent = held.length
        ? `🎒 ${held.map(([id, n]) => `${iconOf(id)}${n > 1 ? `×${n}` : ""}`).join(" ")}`
        : "";
    },
    won() {
      winEl.textContent = "";
      winEl.hidden = false;
      const burst = el("div", "quest-win-burst", winEl);
      burst.textContent = "🎉";
      const title = el("div", "quest-win-title", winEl);
      title.textContent = session?.game.root.outro ?? session?.game.meta.title ?? "You did it!";
      const replay = el("button", "quest-replay", winEl);
      replay.textContent = "🔁 Play again";
      replay.addEventListener("click", () => host?.replay());
    },
  };

  host = createQuestHost3D({ canvas, presenter, resolveImage: labImageResolver });
  host.start(game, opts.town ?? null, { spirit: opts.spirit });
  (window as unknown as Record<string, unknown>).__questLab = host;

  // Pointer-as-gaze: the mouse is the gaze. A walker steers toward it; a spirit
  // just looks (the host ignores steering in stationary mode).
  const onMove = (e: PointerEvent) => host?.setPointer(e.clientX, e.clientY);
  const onLeave = () => host?.clearPointer();
  stage.addEventListener("pointermove", onMove);
  stage.addEventListener("pointerleave", onLeave);

  const ro = new ResizeObserver(() => {
    host?.resize(canvas.clientWidth, canvas.clientHeight, window.devicePixelRatio || 1);
  });
  ro.observe(canvas);

  const hint = opts.spirit
    ? "SPIRIT — no walking: look at an item to pick it up / put it down, look at someone to talk"
    : "walk with the mouse, dwell on a resident to talk";
  setStatus(`${game.meta.title} · ${opts.detail} · ${hint}`);

  return {
    dispose() {
      ro.disconnect();
      stage.removeEventListener("pointermove", onMove);
      stage.removeEventListener("pointerleave", onLeave);
      host?.stop();
      host = null;
      board.dispose();
      delete (window as unknown as Record<string, unknown>).__questLab;
      root.remove();
    },
  };
}

/** The TOWN scope: a living town whose residents are the quest-givers. */
export function bootLivingTown(
  container: HTMLElement,
  loaded: LoadedWorld,
  setStatus: (text: string) => void,
): QuestBoot {
  const t0 = performance.now();
  const built = buildTownScope(loaded.game!);
  const detail =
    `town · seed ${built.spec.config.seed} · day ${built.play.town.day} · ` +
    `pop ${Math.round(built.play.town.scalar("population"))} · ${built.play.bundle.cast.length} residents · ` +
    `certified · ${Math.round(performance.now() - t0)}ms`;
  return bootQuestGame(container, built.play.bundle.game, setStatus, { town: built.play, detail });
}

/** The STRUCTURE scope: a freestanding creature-quest puzzle. With avatar
 *  "spirit" it plays as the stationary, formless puzzle (talk + move items). */
export function bootStructure(
  container: HTMLElement,
  loaded: LoadedWorld,
  setStatus: (text: string) => void,
): QuestBoot {
  const t0 = performance.now();
  const w = (loaded.game!.world ?? {}) as Record<string, unknown>;
  const numOf = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
  const params: CreatureWorldParams = {
    seed: numOf(w.seed, 1),
    questCount: numOf(w.questCount, 2),
    ...(w.layout === "house" || w.layout === "village" ? { layout: w.layout } : {}),
  };
  const game = buildCreatureQuestWorld(params);
  const cert = certifyCreatureQuestWorld(game);
  if (!cert.ok) {
    throw new Error(`structure world failed ${cert.stage} certification: ${cert.errors.join("; ")}`);
  }
  const spirit = avatarKind(loaded.game) === "spirit";
  const detail = `structure · seed ${params.seed} · ${game.entities.length} entities · certified · ${Math.round(performance.now() - t0)}ms`;
  return bootQuestGame(container, game, setStatus, { spirit, detail });
}
