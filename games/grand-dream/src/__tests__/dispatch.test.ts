/**
 * The lab's ONE route table (games/world-lab/src/dispatch.ts):
 * scope × avatar-kind → world route. Spirit at every scope; a walker at
 * every scope; no-avatar = the gaze view except the (refused) town.
 */
import { describe, it, expect } from "vitest";
import { GAME_SCOPES, type GameScope } from "@shared/world-engine/kernel/manifest";
import { routeFor } from "../../../world-lab/src/dispatch";

describe("routeFor — the scope × avatar-kind table", () => {
  it("spirit routes EVERY scope to the spirit ladder", () => {
    for (const scope of GAME_SCOPES) {
      expect(routeFor(scope, "spirit"), scope).toEqual({ kind: "spirit" });
    }
  });

  it("a walker flies the space scopes and walks the ground ones", () => {
    expect(routeFor("galaxy", "walker")).toEqual({ kind: "flight" });
    expect(routeFor("star_cluster", "walker")).toEqual({ kind: "flight" });
    expect(routeFor("solar_system", "walker")).toEqual({ kind: "flight" });
    expect(routeFor("planet", "walker")).toEqual({ kind: "surface-walker" });
    expect(routeFor("region", "walker")).toEqual({ kind: "surface-walker" });
    expect(routeFor("town", "walker")).toEqual({ kind: "town-walker" });
    expect(routeFor("structure", "walker")).toEqual({ kind: "structure-walker" });
  });

  it("no avatar = the gaze view — except a town, which must be embodied", () => {
    const spectatorScopes: GameScope[] = ["structure", "region", "planet", "solar_system", "star_cluster", "galaxy"];
    for (const scope of spectatorScopes) {
      expect(routeFor(scope, "none"), scope).toEqual({ kind: "spirit" });
    }
    expect(() => routeFor("town", "none")).toThrow(/played embodied/);
  });
});
