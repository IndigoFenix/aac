/**
 * dispatch.ts — THE ONE ROUTE TABLE: scope × avatar-kind → how the lab
 * boots the world. Pure and headless-testable; main.ts's boot() is a thin
 * switch over the result.
 *
 * The law (2026-07 reorganization):
 *   • SPIRIT works at EVERY scope — one spirit ladder (flight → town →
 *     ground → structure), starting at the initial_focus rung and capped
 *     by the scope.
 *   • A WALKER works at every scope — space scopes fly (can_fly pilots the
 *     streaming world), ground scopes walk (embedded/standalone hosts).
 *   • No avatar = the spirit view (a spectator IS the gaze camera), except
 *     a town, which is meaningless unembodied (buildTownScope's law; the
 *     spirit presence counts as embodied).
 */
import type { AvatarKind, GameScope } from "@shared/world-engine/kernel/manifest";

export type WorldRoute =
  /** The unified spirit ladder over the scope's world (any scope). */
  | { kind: "spirit" }
  /** Piloted flight in the streaming world (walker with can_fly; the
   *  space scopes' embodiment). */
  | { kind: "flight" }
  /** A walker on streamed planet/region ground (spawns inside the focus;
   *  flight-sim handoff owns takeoff/landing). */
  | { kind: "surface-walker" }
  /** The standalone living town on the quest host. */
  | { kind: "town-walker" }
  /** The standalone structure puzzle on the quest host. */
  | { kind: "structure-walker" };

const SPACE_SCOPES: readonly GameScope[] = ["solar_system", "star_cluster", "galaxy"];

/** Route a game. Throws on the one illegal combination (town + no avatar). */
export function routeFor(scope: GameScope, kind: AvatarKind): WorldRoute {
  if (kind === "spirit") return { kind: "spirit" };
  if (kind === "walker") {
    if (SPACE_SCOPES.includes(scope)) return { kind: "flight" };
    if (scope === "planet" || scope === "region") return { kind: "surface-walker" };
    if (scope === "town") return { kind: "town-walker" };
    return { kind: "structure-walker" };
  }
  // No avatar: the gaze view frames the scope — except a town, which is
  // played embodied or not at all.
  if (scope === "town") {
    throw new Error('a town is played embodied — set avatar to true (or "spirit")');
  }
  return { kind: "spirit" };
}
