/**
 * The default-enablement contract, pinned on BOTH sides of the wire.
 *
 * An app's default reaches a student through two independent code paths:
 *
 *   server — APP_REGISTRY.enabledByDefault, consumed by getEnabledAppsFromConfig(),
 *            which decides what actually appears on the AAC Apps board.
 *   client — the AAC Settings switches, whose `?? <default>` fallback is what a
 *            CLINICIAN sees for a student with no explicit appConfig entry.
 *
 * They were hardcoded separately and drifted: `sandbox_game`, `bubbles_game`
 * and `musical_microbes` were on by default server-side while the panel drew
 * them OFF. Every new student got three game tiles nobody had enabled and whose
 * settings page denied they were there (found 2026-09-08, via a new student
 * opening Musical Microbes). Both sides now read shared/app-defaults.ts; these
 * tests fail if either one goes back to a literal.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { APP_REGISTRY, getEnabledAppsFromConfig } from "../services/dual-agent/app-registry";
import { APP_ENABLED_BY_DEFAULT, appEnabledByDefault } from "@shared/app-defaults";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PANEL = path.join(REPO_ROOT, "client", "src", "features", "AACSettingsPanel.tsx");

describe("app default enablement", () => {
  it("covers every registry app, and invents none", () => {
    expect(Object.keys(APP_ENABLED_BY_DEFAULT).sort()).toEqual(
      APP_REGISTRY.map(a => a.id).sort(),
    );
  });

  it("is what the registry hands the student", () => {
    for (const app of APP_REGISTRY) {
      expect(app.enabledByDefault).toBe(appEnabledByDefault(app.id));
    }
  });

  it("decides an unconfigured student's board", () => {
    const expected = APP_REGISTRY.filter(a => appEnabledByDefault(a.id)).map(a => a.id);
    expect(getEnabledAppsFromConfig(null)).toEqual(expected);
    expect(getEnabledAppsFromConfig({})).toEqual(expected);
  });

  it("is overridden by an explicit choice in both directions", () => {
    // musical_microbes is ON by default — the case that put an unasked-for game
    // on a new student's board while its switch read OFF.
    expect(appEnabledByDefault("musical_microbes")).toBe(true);
    expect(getEnabledAppsFromConfig({ musical_microbes: { enabled: false } }))
      .not.toContain("musical_microbes");
    expect(getEnabledAppsFromConfig({ picture_search: { enabled: true } }))
      .toContain("picture_search");
  });

  it("gives an unknown app id no default", () => {
    expect(appEnabledByDefault("custom_app_nobody_registered")).toBe(false);
  });

  /**
   * The client half. A unit test cannot render the panel here (it is a large
   * DOM-bound component in the clinician build), so this reads the source: the
   * failure being guarded against is textual — someone typing a literal back
   * into the fallback — and that is exactly what a literal scan catches.
   */
  describe("AAC Settings panel", () => {
    const source = readFileSync(PANEL, "utf8");

    it("has no hardcoded `?.enabled ?? <literal>` fallback", () => {
      const hardcoded = source
        .split("\n")
        .map((line, i) => [i + 1, line] as const)
        .filter(([, line]) => /\?\.enabled \?\? (true|false)\b/.test(line))
        .map(([n, line]) => `${n}: ${line.trim()}`);
      expect(hardcoded).toEqual([]);
    });

    it("reads every app switch from the shared defaults", () => {
      const ids = [...source.matchAll(/appEnabledByDefault\("([\w-]+)"\)/g)].map(m => m[1]);
      expect(ids.length).toBeGreaterThan(0);
      for (const id of ids) {
        expect(Object.keys(APP_ENABLED_BY_DEFAULT)).toContain(id);
      }
    });
  });
});
