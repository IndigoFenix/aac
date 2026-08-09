// Tests for the smart-home actions foundation:
//   - normalizeHomeActions — jsonb sanitization of aac_settings.home_actions,
//     per-TYPE: `spoken` needs a command, cloud slots must not carry one
//   - enabledHomeActions / findHomeAction — the server-side press gate's lookup
//   - executeHomeAction — provider seam dispatch (spoken actuates on the client,
//     the cloud providers are registered but stubbed until the accounts exist)
//
// DB-free by design (runs under test:unit).

import { describe, test, expect } from "@jest/globals";
import {
  normalizeHomeActions,
  enabledHomeActions,
  findHomeAction,
} from "@shared/home-actions";
import type { HomeAction } from "@shared/schema";
import { executeHomeAction } from "../services/dual-agent/home-action-service";
import type { HomeActionContext } from "../services/smart-home/types";

const LIGHTS: HomeAction = {
  id: "lights_on",
  label: "Lights on",
  type: "spoken",
  command: "Alexa, turn on the lights",
  enabled: true,
};
const FAN: HomeAction = {
  id: "fan_off",
  label: "Fan off",
  type: "spoken",
  command: "Alexa, turn off the fan",
  enabled: false,
};
/** Every press is for ONE student — the only thing a cloud provider needs. */
const CTX: HomeActionContext = { studentId: "student-1" };

describe("normalizeHomeActions", () => {
  test("accepts a valid row and defaults enabled to true", () => {
    const parsed = normalizeHomeActions([
      { id: "lights_on", label: "Lights on", type: "spoken", command: "Alexa, turn on the lights" },
    ]);
    expect(parsed).toEqual([
      {
        id: "lights_on",
        label: "Lights on",
        type: "spoken",
        command: "Alexa, turn on the lights",
        enabled: true,
      },
    ]);
  });

  test("keeps an explicit enabled:false", () => {
    const parsed = normalizeHomeActions([{ ...LIGHTS, enabled: false }]);
    expect(parsed[0].enabled).toBe(false);
  });

  test("trims strings and keeps optional fields", () => {
    const parsed = normalizeHomeActions([
      {
        id: "  lights_on ",
        label: " Lights on ",
        type: "spoken",
        command: "  Alexa, turn on the lights  ",
        icon: " 💡 ",
        description: " when the room is dark ",
        requiresConfirmation: true,
      },
    ]);
    expect(parsed).toEqual([
      {
        id: "lights_on",
        label: "Lights on",
        type: "spoken",
        command: "Alexa, turn on the lights",
        icon: "💡",
        description: "when the room is dark",
        requiresConfirmation: true,
        enabled: true,
      },
    ]);
  });

  test("drops blank-only optional fields rather than storing empty strings", () => {
    const parsed = normalizeHomeActions([{ ...LIGHTS, icon: "  ", description: "  " }]);
    expect(parsed[0].icon).toBeUndefined();
    expect(parsed[0].description).toBeUndefined();
    expect(parsed[0].requiresConfirmation).toBeUndefined();
  });

  test("drops rows missing id, label or command (half-filled editor rows)", () => {
    const parsed = normalizeHomeActions([
      { id: "", label: "Lights on", type: "spoken", command: "x" },
      { id: "a", label: "", type: "spoken", command: "x" },
      { id: "b", label: "Fan", type: "spoken", command: "   " },
      { id: "c", label: "Fan", type: "spoken" },
      { id: "ok", label: "Fan off", type: "spoken", command: "Alexa, turn off the fan" },
    ]);
    expect(parsed.map((a) => a.id)).toEqual(["ok"]);
  });

  test("rejects unknown and missing types — a slot nothing can dispatch is not a slot", () => {
    const parsed = normalizeHomeActions([
      { id: "a", label: "Lights", type: "matter", command: "x" },
      { id: "b", label: "Lights", type: "", command: "x" },
      { id: "c", label: "Lights", command: "x" },
      { id: "d", label: "Lights", type: 7, command: "x" },
      LIGHTS,
    ]);
    expect(parsed.map((a) => a.id)).toEqual(["lights_on"]);
  });

  test("accepts cloud rows WITHOUT a command — they actuate server-side", () => {
    const parsed = normalizeHomeActions([
      { id: "a", label: "Lights", type: "alexa" },
      { id: "b", label: "Fan", type: "google", requiresConfirmation: true },
    ]);
    expect(parsed).toEqual([
      { id: "a", label: "Lights", type: "alexa", enabled: true },
      { id: "b", label: "Fan", type: "google", requiresConfirmation: true, enabled: true },
    ]);
  });

  test("a cloud row's `command` is DROPPED — nothing utters it", () => {
    const parsed = normalizeHomeActions([
      { id: "a", label: "Lights", type: "alexa", command: "Alexa, turn on the lights" },
    ]);
    expect(parsed[0].command).toBeUndefined();
  });

  test("cloud `announce` is trimmed and optional; spoken rows never keep one", () => {
    const parsed = normalizeHomeActions([
      { id: "a", label: "Lights", type: "alexa", announce: "  turning on the lights  " },
      { id: "b", label: "Fan", type: "google", announce: "   " },
      { id: "c", label: "Lights on", type: "spoken", command: "Alexa, lights", announce: "ignored" },
    ]);
    expect(parsed[0].announce).toBe("turning on the lights");
    expect(parsed[1].announce).toBeUndefined();
    expect(parsed[2].announce).toBeUndefined();
  });

  test("drops duplicate ids (first wins)", () => {
    const parsed = normalizeHomeActions([
      LIGHTS,
      { id: "lights_on", label: "Lights on again", type: "spoken", command: "Alexa, nope" },
    ]);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].label).toBe("Lights on");
  });

  test("an INVALID row never claims its id — a later valid one with the same id wins", () => {
    const parsed = normalizeHomeActions([
      { id: "lights_on", label: "Lights on", type: "spoken" },   // no command → invalid
      LIGHTS,
    ]);
    expect(parsed).toEqual([LIGHTS]);
  });

  test("survives garbage input", () => {
    expect(normalizeHomeActions(undefined)).toEqual([]);
    expect(normalizeHomeActions(null)).toEqual([]);
    expect(normalizeHomeActions({})).toEqual([]);
    expect(normalizeHomeActions("[]")).toEqual([]);
    expect(normalizeHomeActions(42)).toEqual([]);
    expect(normalizeHomeActions([null, "junk", 7, [], { id: 1, label: 2, command: 3 }])).toEqual([]);
  });
});

describe("enabledHomeActions", () => {
  test("keeps enabled and undefined-enabled rows, drops disabled ones", () => {
    const list = enabledHomeActions([LIGHTS, FAN, { ...LIGHTS, id: "tv", enabled: undefined }]);
    expect(list.map((a) => a.id)).toEqual(["lights_on", "tv"]);
  });
});

describe("findHomeAction", () => {
  test("finds an enabled action by id", () => {
    expect(findHomeAction([LIGHTS, FAN], "lights_on")).toBe(LIGHTS);
  });

  test("does NOT find a disabled action (press gate)", () => {
    expect(findHomeAction([LIGHTS, FAN], "fan_off")).toBeUndefined();
  });

  test("returns undefined for unknown or empty ids", () => {
    expect(findHomeAction([LIGHTS], "nope")).toBeUndefined();
    expect(findHomeAction([LIGHTS], "")).toBeUndefined();
    expect(findHomeAction([], "lights_on")).toBeUndefined();
  });
});

describe("executeHomeAction", () => {
  test("spoken actions actuate on the client", async () => {
    await expect(executeHomeAction(LIGHTS, CTX)).resolves.toEqual({ kind: "client_spoken" });
  });

  test("the cloud providers are REGISTERED but unconfigured — soft-fail, no throw", async () => {
    const alexa: HomeAction = { id: "a", label: "Lights", type: "alexa" };
    const google: HomeAction = { id: "b", label: "Fan", type: "google" };
    await expect(executeHomeAction(alexa, CTX)).resolves.toEqual({
      kind: "failed",
      reason: "not_configured",
    });
    await expect(executeHomeAction(google, CTX)).resolves.toEqual({
      kind: "failed",
      reason: "not_configured",
    });
  });

  test("unknown types fail softly, never throw", async () => {
    const bogus = { ...LIGHTS, type: "matter" } as unknown as HomeAction;
    await expect(executeHomeAction(bogus, CTX)).resolves.toEqual({
      kind: "failed",
      reason: "unknown_type",
    });
    const missing = { id: "x", label: "x", command: "x" } as unknown as HomeAction;
    await expect(executeHomeAction(missing, CTX)).resolves.toEqual({
      kind: "failed",
      reason: "unknown_type",
    });
  });

  test("a throwing provider is caught and reported as an outcome", async () => {
    const exploding = { get type() { throw new Error("boom"); } } as unknown as HomeAction;
    // Even a hostile action object must not escape as an exception into the
    // press path — the coordinator awaits this inline.
    await expect(executeHomeAction(exploding, CTX)).resolves.toEqual(
      expect.objectContaining({ kind: "failed" }),
    );
  });
});
