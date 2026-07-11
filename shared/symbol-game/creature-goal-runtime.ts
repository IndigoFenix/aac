// shared/symbol-game/creature-goal-runtime.ts
//
// The LIVE glue that turns the pure goal/rule system into running behavior: each
// frame it advances a world clock, runs selectGoal per creature, and — when a
// creature's chosen goal CHANGES — compiles it to a GoalPlan and hands it to the
// host to execute (as an NpcErrand). This is the bridge the goal-selection.ts
// doc-comment describes; it keeps the world-host coupling to a single `issue`
// callback so the host owns the errand + world-effect details.
//
// The default Riverside behavior is authored END-TO-END through the pipeline:
// `defaultCurfewRules` parses "when + night + go + home" and compiles it to a Rule
// per creature (self-authored, so it's a town CUSTOM every resident follows) — the
// same path a child's board utterance takes.

import {
  advanceClock,
  createWorldClock,
  worldConditions,
  type WorldClock,
  type WorldClockConfig,
} from "../world-engine/world-clock.js";
import type { CreatureId, CreatureWorld } from "./creatures.js";
import type { GoalSpec, Rule, RuleContext } from "./rules.js";
import {
  compileGoal,
  selectGoal,
  type GoalPlan,
  type RuleRuntime,
  type WorldResolver,
} from "./goal-selection.js";
import { DEFAULT_RELATION, type Relation } from "./relations.js";
import type { Personality } from "./personality.js";
import { parseSentence } from "./parse-intent.js";
import { compileIntent, defaultBinder } from "./intent-compile.js";

/** A short in-game day so day/night (and the curfew) is observable in a play session. */
export const DEFAULT_TOWN_DAY_LENGTH = 60;

/** Per-session goal/rule state that rides alongside the creature world. */
export interface CreatureGoalState {
  rules: Rule[];
  /** Per-rule runtime (edge/until + cooldown). Rule ids are unique per creature. */
  runtimes: Map<string, RuleRuntime>;
  /** Last chosen goal key per creature — so an errand is (re)issued only on CHANGE. */
  lastGoalKey: Map<CreatureId, string>;
  clock: WorldClock;
}

export function createCreatureGoalState(
  rules: Rule[],
  clock?: Partial<WorldClockConfig>,
): CreatureGoalState {
  return {
    rules,
    runtimes: new Map(),
    lastGoalKey: new Map(),
    clock: createWorldClock({ dayLength: DEFAULT_TOWN_DAY_LENGTH, ...clock }),
  };
}

/**
 * A town CUSTOM per creature: "when night, go home", authored through the real
 * parser + compiler (a self-authored rule → full compliance, so every resident
 * follows it). Ids are unique per creature (`curfew_<cid>`).
 */
export function defaultCurfewRules(creatureIds: Iterable<CreatureId>): Rule[] {
  const out: Rule[] = [];
  for (const cid of creatureIds) {
    const compiled = compileIntent(
      parseSentence("when + night + go + home"),
      defaultBinder({ player: cid, listener: cid }),
      { id: `curfew_${cid}` },
    );
    if (compiled.kind === "rule") out.push(compiled.rule);
  }
  return out;
}

/** Everything the step needs from the live world — supplied by the host. */
export interface GoalRuntimeHooks {
  world: CreatureWorld;
  creatureIds: Iterable<CreatureId>;
  /** Positions/home lookups for compileGoal (goal-selection.WorldResolver). */
  resolver: WorldResolver;
  /** Is this creature already running an errand? (Don't interrupt it.) */
  isBusy: (cid: CreatureId) => boolean;
  /** Execute the compiled plan (the host turns it into an NpcErrand). */
  issue: (cid: CreatureId, plan: GoalPlan) => void;
  /** Optional per-creature personality (tilts rule compliance). */
  personalityOf?: (cid: CreatureId) => Personality | undefined;
  /** Optional directed relation self→author (for non-self-authored rules). */
  relationTo?: (self: CreatureId, author: CreatureId) => Relation;
  /** Optional live role membership for group-bound rules. */
  rolesOf?: (cid: CreatureId) => ReadonlySet<string>;
}

/** A stable key for a goal, so we (re)issue only when it changes. */
export function goalKey(goal: GoalSpec | null): string {
  return goal ? JSON.stringify(goal) : "";
}

/**
 * Advance the clock and, for each creature, pick its goal and (re)issue an errand
 * when the goal changes. Advancing the clock is the caller's cadence: pass `dt`
 * seconds. Pure except for the `issue` side effect + mutation of `gs` runtime maps.
 */
export function stepCreatureGoals(gs: CreatureGoalState, dt: number, h: GoalRuntimeHooks): void {
  gs.clock = advanceClock(gs.clock, dt);
  const conditions = worldConditions(gs.clock);
  const now = gs.clock.time;

  for (const cid of h.creatureIds) {
    const self = h.world.creatures[cid];
    if (!self) continue;
    const ctx: RuleContext = {
      self,
      world: h.world,
      worldConditions: conditions,
      personality: h.personalityOf?.(cid),
      rolesOf: h.rolesOf,
    };
    const res = selectGoal({
      ctx,
      rules: gs.rules,
      relationTo: (author) => h.relationTo?.(cid, author) ?? DEFAULT_RELATION,
      runtimes: gs.runtimes,
      now,
    });
    const goal = res.chosen?.goal ?? null;
    const key = goalKey(goal);
    if (key === (gs.lastGoalKey.get(cid) ?? "")) continue; // unchanged → nothing to do

    if (!goal) {
      // Goal cleared (e.g. day broke) — let the creature's normal behavior resume.
      gs.lastGoalKey.set(cid, "");
      continue;
    }
    if (h.isBusy(cid)) continue; // don't interrupt a running errand; retry next change
    const plan = compileGoal(goal, cid, h.resolver);
    if (!plan) continue; // unresolvable right now (no home yet) — retry next change
    gs.lastGoalKey.set(cid, key);
    h.issue(cid, plan);
  }
}
