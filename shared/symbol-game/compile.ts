// shared/symbol-game/compile.ts
//
// Compile a bound quote-exchange into a goal-tree game (§7) — the step that
// turns an endpoint quote into an actually-playable, certifiable beat.
//
// Two shapes, dispatched on the exchange:
//   • TELL (a prompt + ≥2 board responses) → WATCH (observe) then a `choose`
//     whose options carry each response's composed glyph (mirrors
//     lessons/symbol-basics.ts); a contingency concept also gets a
//     `choose.onCorrect` payoff.
//   • DO (no responses, an `action`) → follow the NPC instruction in the world:
//     `collect` the named item among pool siblings, or `transport` it to a spot.
//
// The output is ordinary goal-tree data: certifyGoalTreeGame(compileExchange(x))
// runs the full schema → solver → layout gauntlet. Nothing here can express an
// unwinnable game — a choose's single `correct` option / a collect's target /
// a transport's placement is the win condition.
//
// NOT YET HANDLED (by design): intentNoKey (A2/A3 @P4) — the marked `correct`
// drives low-phase scaffolding and satisfies the one-correct rule; P4 "log don't
// score" is a runtime concern.

import type {
  ChooseNode,
  ChooseOption,
  CollectNode,
  EntityDef,
  GoalNode,
  GoalTreeGame,
  ObserveNode,
  OvercomeNode,
  TransportNode,
} from "../goal-tree/types.js";
import type { BoundExchange } from "./quote.js";
import { templateSlots } from "./quote.js";
import { demoForConcept, contingencyCue } from "./concept-demo.js";
import type { DoAction, PoolDef, PoolMember } from "./types.js";

/** Coerce an arbitrary string into a valid goal-tree id (`[A-Za-z_][A-Za-z0-9_]*`). */
function toId(raw: string): string {
  let s = raw.replace(/[^a-zA-Z0-9_]/g, "_");
  if (!/^[a-zA-Z_]/.test(s)) s = `n_${s}`;
  return s.slice(0, 64);
}

export interface CompileOptions {
  /** Companion/poser display name. Defaults to "Teacher". */
  poserName?: string;
  /** Companion emoji. Defaults to "🧑‍🏫". */
  poserIcon?: string;
  /**
   * Prepend a WATCH beat: an `observe` that demonstrates the target glyph on a
   * stage prop before the `choose` tests it (the teach-then-test loop). Default
   * true. The contingency payoff (`choose.onCorrect`) is added independently
   * whenever the concept has one (more/again/go). TELL beats only.
   */
  withWatch?: boolean;
  /** Pools — REQUIRED to compile a DO `collect` exchange (for its distractors). */
  pools?: Record<string, PoolDef>;
}

/** An EntityDef built from a pool member (label/icon/glyph), kind "item". */
function itemEntity(id: string, member: PoolMember): EntityDef {
  return {
    id,
    kind: "item",
    label: member.label,
    ...(member.iconRef ? { iconRef: member.iconRef } : {}),
    glyph: member.symbol,
  };
}

function gameOf(concept: string, entities: EntityDef[], root: GoalNode): GoalTreeGame {
  return {
    engine: "goal-tree",
    engineVersion: 1,
    meta: { title: `Symbol: ${concept}`, locale: "en", theme: "bright learning playground", learningGoals: [concept] },
    entities,
    root,
  };
}

/**
 * Compile one bound exchange into a standalone, certifiable GoalTreeGame.
 *
 * @throws if the exchange is neither a TELL (≥2 board responses, exactly one
 *   correct) nor a DO (carries an `action`), or a DO `collect` lacks `opts.pools`.
 */
export function compileExchange(bound: BoundExchange, opts: CompileOptions = {}): GoalTreeGame {
  const { exchange, responses } = bound;
  if (responses.length >= 2) return compileTellExchange(bound, opts);
  if (exchange.action) return compileDoExchange(bound, exchange.action, opts);
  throw new Error(
    `exchange "${exchange.id}" has ${responses.length} response(s) and no DO action — ` +
      `nothing to compile (a TELL needs ≥2 responses; a DO needs an action).`,
  );
}

// ---------------------------------------------------------------------------
// TELL — WATCH (observe) then pick-the-sentence (choose)
// ---------------------------------------------------------------------------

function compileTellExchange(bound: BoundExchange, opts: CompileOptions): GoalTreeGame {
  const { exchange, prompt, responses } = bound;
  const correctCount = responses.filter((r) => r.correct).length;
  if (correctCount !== 1) {
    throw new Error(`exchange "${exchange.id}" has ${correctCount} correct responses; a choose node requires exactly 1.`);
  }

  const base = toId(exchange.id);
  const poserId = `${base}_poser`;
  const finishId = `${base}_finish`;
  const quizId = `${base}_quiz`;
  const watchId = `${base}_watch`;
  const stageId = `${base}_stage`;
  const withWatch = opts.withWatch !== false;

  // One option entity per response, each carrying its composed glyph (for board
  // locking). Track the correct + a contrast glyph for the WATCH beat.
  const optionEntities: EntityDef[] = [];
  const options: ChooseOption[] = [];
  let correctGlyph = "";
  let contrastGlyph: string | undefined;
  responses.forEach((r, i) => {
    const optId = `${base}_opt${i}`;
    // Until i18n lands, the composed glyph doubles as the human label.
    optionEntities.push({ id: optId, kind: "item", label: r.bound.glyph, glyph: r.bound.glyph });
    options.push({ entityId: optId, correct: r.correct ? true : undefined });
    if (r.correct) correctGlyph = r.bound.glyph;
    else if (contrastGlyph === undefined) contrastGlyph = r.bound.glyph;
  });

  // Stage prop: the referent the WATCH demo / onCorrect payoff acts on. Drawn
  // from the LAST bound slot of the prompt (the object under discussion), else
  // a neutral prop.
  const promptSlots = templateSlots(exchange.prompt.glyph);
  const refMember = promptSlots.length ? bound.binding[promptSlots[promptSlots.length - 1]!] : undefined;
  const onCorrect = contingencyCue(exchange.concept, stageId);
  const needStage = withWatch || onCorrect !== undefined;

  const entities: EntityDef[] = [
    { id: poserId, kind: "character", label: opts.poserName ?? "Teacher", iconRef: opts.poserIcon ?? "🧑‍🏫" },
    { id: finishId, kind: "marker", label: "Star", iconRef: "⭐" },
    { id: quizId, kind: "obstacle", label: "Question", iconRef: "❓" },
    ...optionEntities,
  ];
  if (needStage) {
    entities.push({
      id: stageId,
      kind: "item",
      label: refMember?.label ?? "Thing",
      iconRef: refMember?.iconRef ?? "✨",
      ...(refMember?.symbol ? { glyph: refMember.symbol } : {}),
    });
  }
  if (withWatch) {
    entities.push({ id: watchId, kind: "obstacle", label: "Watch", iconRef: "👀" });
  }

  const choose: ChooseNode = {
    type: "choose",
    id: `${base}_choose`,
    posedByEntityId: poserId,
    // The bound prompt SENTENCE stands in for the displayed question until i18n.
    prompt: prompt.glyph,
    options,
    ...(onCorrect ? { onCorrect } : {}),
  };

  // WATCH (observe) then TELL (choose), each an overcome guarding the finish —
  // the teach-then-test loop (mirrors lessons/symbol-basics.ts).
  const via: OvercomeNode[] = [];
  if (withWatch) {
    const observe: ObserveNode = {
      type: "observe",
      id: `${base}_observe`,
      targetGlyph: correctGlyph,
      ...(contrastGlyph ? { contrastGlyph } : {}),
      stageEntityId: stageId,
      demonstrate: demoForConcept(exchange.concept, stageId),
    };
    via.push({ type: "overcome", id: `${base}_watch_gate`, obstacleEntityId: watchId, key: observe });
  }
  via.push({ type: "overcome", id: `${base}_gate`, obstacleEntityId: quizId, key: choose });

  return gameOf(exchange.concept, entities, { type: "reach", id: `${base}_root`, markerEntityId: finishId, via });
}

// ---------------------------------------------------------------------------
// DO — follow the NPC instruction in the world (collect / transport)
// ---------------------------------------------------------------------------

function compileDoExchange(bound: BoundExchange, action: DoAction, opts: CompileOptions): GoalTreeGame {
  const { exchange } = bound;
  const target = bound.binding[action.slot];
  if (!target) {
    throw new Error(`DO exchange "${exchange.id}" action slot "{${action.slot}}" is not bound by the prompt.`);
  }

  const base = toId(exchange.id);
  const poserId = `${base}_poser`;
  const finishId = `${base}_finish`;
  const taskId = `${base}_task`;
  const targetId = `${base}_target`;

  const entities: EntityDef[] = [
    { id: poserId, kind: "character", label: opts.poserName ?? "Teacher", iconRef: opts.poserIcon ?? "🧑‍🏫" },
    { id: finishId, kind: "marker", label: "Star", iconRef: "⭐" },
    { id: taskId, kind: "obstacle", label: "Task", iconRef: "🔒" },
    itemEntity(targetId, target),
  ];

  let key: GoalNode;
  if (action.kind === "collect") {
    const pool = opts.pools?.[action.slot];
    if (!pool) {
      throw new Error(
        `compiling DO collect for "${exchange.id}" needs opts.pools["${action.slot}"] (to draw distractors).`,
      );
    }
    // Object-pool distractors: other members of the same pool (wrong noun).
    const distractorIds: string[] = [];
    pool.members
      .filter((m) => m.id !== target.id)
      .slice(0, 3)
      .forEach((m, i) => {
        const did = `${base}_distractor${i}`;
        entities.push(itemEntity(did, m));
        distractorIds.push(did);
      });
    const collect: CollectNode = {
      type: "collect",
      id: `${base}_collect`,
      itemEntityIds: [targetId],
      count: 1,
      ...(distractorIds.length ? { distractorEntityIds: distractorIds } : {}),
    };
    key = collect;
  } else {
    // transport (plain carry-to-spot) OR fetch (carry the RIGHT one among siblings).
    const destId = `${base}_dest`;
    // The recipient/drop spot shows its OWN icon (a basket), never the item's; the
    // wanted item is shown by a glyph bubble over it (player-side, for fetch).
    entities.push({ id: destId, kind: "marker", label: "Here", iconRef: "🧺" });
    const distractorIds: string[] = [];
    if (action.kind === "fetch") {
      const pool = opts.pools?.[action.slot];
      if (!pool) {
        throw new Error(
          `compiling DO fetch for "${exchange.id}" needs opts.pools["${action.slot}"] (to draw distractors).`,
        );
      }
      pool.members
        .filter((m) => m.id !== target.id)
        .slice(0, 3)
        .forEach((m, i) => {
          const did = `${base}_distractor${i}`;
          entities.push(itemEntity(did, m));
          distractorIds.push(did);
        });
    }
    const transport: TransportNode = {
      type: "transport",
      id: `${base}_transport`,
      objectEntityId: targetId,
      ...(distractorIds.length ? { distractorEntityIds: distractorIds } : {}),
      destEntityId: destId,
      ...(action.relation ? { relation: action.relation } : {}),
    };
    key = transport;
  }

  return gameOf(exchange.concept, entities, {
    type: "reach",
    id: `${base}_root`,
    markerEntityId: finishId,
    via: [{ type: "overcome", id: `${base}_gate`, obstacleEntityId: taskId, key }],
  });
}
