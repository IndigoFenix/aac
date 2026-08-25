/**
 * The restaurant app's enablement gate.
 *
 * Regression test for a silent, confusing failure observed live on 2026-08-23:
 * Location Menus was ON, so the restaurant FLOOR BOARD was registered and the
 * agents saw it in <prebuilt_boards> — but the restaurant APP is
 * `enabledByDefault: false` and had never been enabled in `appConfig`, so it
 * was absent from <apps_context> and from the Speaker's `open_app` tool list.
 * The student asked for pizza. The Speaker, with no restaurant app to open,
 * called `picture_search("pizza")` and showed the child PHOTOGRAPHS of pizza
 * while they were trying to order lunch.
 *
 * Two switches for one feature was one switch too many. The feature switch now
 * moves the app's DEFAULT — and only its default, so an explicit choice by a
 * clinician still wins in both directions.
 */

import { describe, test, expect } from "@jest/globals";
import { getEnabledAppsFromConfig } from "../services/dual-agent/app-registry";

describe("the restaurant app follows the Location Menus switch", () => {
  test("off by default when the feature is off", () => {
    expect(getEnabledAppsFromConfig(null)).not.toContain("restaurant");
    expect(getEnabledAppsFromConfig(null, { venueMenusEnabled: false })).not.toContain("restaurant");
  });

  test("turning on Location Menus is enough to make the app launchable", () => {
    // The whole point: a clinician who enables the feature should not have to
    // find a second switch in a different section for it to work at all.
    expect(getEnabledAppsFromConfig(null, { venueMenusEnabled: true })).toContain("restaurant");
  });

  test("an explicit OFF still wins over the feature switch", () => {
    // A clinician who deliberately turned the app off means it.
    const config = { restaurant: { enabled: false } };
    expect(getEnabledAppsFromConfig(config, { venueMenusEnabled: true })).not.toContain("restaurant");
  });

  test("an explicit ON still wins with the feature off", () => {
    const config = { restaurant: { enabled: true } };
    expect(getEnabledAppsFromConfig(config, { venueMenusEnabled: false })).toContain("restaurant");
  });

  test("no other app's default is disturbed", () => {
    // The feature switch is scoped to the app that IS the feature's front door.
    const withFeature = getEnabledAppsFromConfig(null, { venueMenusEnabled: true });
    const without = getEnabledAppsFromConfig(null, { venueMenusEnabled: false });
    expect(withFeature.filter((id) => id !== "restaurant")).toEqual(without);
  });
});
