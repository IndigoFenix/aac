// Verifies the in-call game picker list (listSocialGameOptions): the built-in
// default social world comes first, the Dollhouse iframe game second, and the
// institute's certified multiplayer custom apps follow. Apps whose stored spec
// is missing or no longer certifies are silently skipped.
//
// DB-free: the custom-app repository is mocked (unstable_mockModule — plain
// jest.mock is a no-op under the ESM preset), so this runs under
// `npm run test:unit`.

import { describe, it, expect, beforeEach, jest } from "@jest/globals";

const listMultiplayerAppsForInstitute = jest.fn(async (): Promise<Array<{ id: string; name?: string | null }>> => []);
const getApp = jest.fn(async (): Promise<{ id: string; name: string | null; definition: unknown } | null> => null);

jest.unstable_mockModule("../repositories/customAppRepository", () => ({
  customAppRepository: { listMultiplayerAppsForInstitute, getApp },
}));

const { listSocialGameOptions } = await import("../services/social-game/socialGameOptions");
const { DEFAULT_SOCIAL_GAME, DOLLHOUSE_CALL_GAME } = await import("@shared/social-world/default-game");
const { socialFieldSpec } = await import("@shared/world-engine/specs/index");

describe("listSocialGameOptions", () => {
  beforeEach(() => {
    listMultiplayerAppsForInstitute.mockResolvedValue([]);
    getApp.mockResolvedValue(null);
  });

  it("returns the built-ins (default world, then Dollhouse) when there are no custom apps", async () => {
    const options = await listSocialGameOptions("inst-1");
    expect(options).toEqual([DEFAULT_SOCIAL_GAME, DOLLHOUSE_CALL_GAME]);
  });

  it("describes the Dollhouse as an iframe-quest game mounted from /games/dollhouse/", async () => {
    const options = await listSocialGameOptions("inst-1");
    const dollhouse = options.find((o) => o.appId === "dollhouse");
    expect(dollhouse).toBeDefined();
    expect(dollhouse!.engine).toBe("iframe-quest");
    expect(dollhouse!.src).toBe("/games/dollhouse/");
    // An iframe game carries no world spec — every participant mounts its own.
    expect(dollhouse!.worldSpec).toBeUndefined();
    expect(dollhouse!.worldSpecKey).toBeUndefined();
  });

  it("appends a certified custom world app after the built-ins", async () => {
    // The display name comes from the LISTING row (metadata), not the full record.
    listMultiplayerAppsForInstitute.mockResolvedValue([{ id: "app-1", name: "My World" }]);
    getApp.mockResolvedValue({ id: "app-1", name: "My World", definition: socialFieldSpec });
    const options = await listSocialGameOptions("inst-1");
    expect(options).toHaveLength(3);
    expect(options[0]).toEqual(DEFAULT_SOCIAL_GAME);
    expect(options[1]).toEqual(DOLLHOUSE_CALL_GAME);
    expect(options[2]!.appId).toBe("app-1");
    expect(options[2]!.name).toBe("My World");
    expect(options[2]!.worldSpec).toBeDefined();
  });

  it("skips custom apps whose stored spec no longer certifies", async () => {
    listMultiplayerAppsForInstitute.mockResolvedValue([{ id: "app-bad" }]);
    getApp.mockResolvedValue({ id: "app-bad", name: "Broken", definition: { not: "a spec" } });
    const options = await listSocialGameOptions("inst-1");
    expect(options).toEqual([DEFAULT_SOCIAL_GAME, DOLLHOUSE_CALL_GAME]);
  });

  it("skips custom apps whose full record is missing", async () => {
    listMultiplayerAppsForInstitute.mockResolvedValue([{ id: "app-gone" }]);
    getApp.mockResolvedValue(null);
    const options = await listSocialGameOptions("inst-1");
    expect(options).toEqual([DEFAULT_SOCIAL_GAME, DOLLHOUSE_CALL_GAME]);
  });
});
