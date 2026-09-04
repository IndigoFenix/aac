// Guards scripts/ios-configure.mjs against the Capacitor iOS template moving
// underneath it.
//
// `ios/` is generated fresh on every release by `npx cap add ios`, so nothing
// about the native project is committed and nothing about it is reviewable in a
// diff. This script IS the iOS project, and it is applied on a macOS runner we
// cannot reproduce locally — a mistake here surfaces as a rejected App Store
// upload or, worse, a shipped build with the wrong device family or English-only
// permission prompts.
//
// So the suite runs the real script against the real template tarball out of
// node_modules and asserts the resulting project, rather than asserting the
// script's source text.

import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as plist from "plist";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const template = path.join(
  repoRoot,
  "node_modules",
  "@capacitor",
  "cli",
  "assets",
  "ios-pods-template.tar.gz",
);

/** Every .lproj the script is expected to emit. */
const EXPECTED_LPROJ = [
  "en", "ar", "de", "es", "fr", "he", "ko", "pt-BR", "pt", "ru", "yue-Hant", "zh-Hans",
];

describe("ios-configure against the generated Capacitor project", () => {
  let work: string;
  let projectDir: string;
  let pbxproj: string;
  let info: Record<string, unknown>;

  beforeAll(() => {
    work = mkdtempSync(path.join(tmpdir(), "aivota-ios-cfg-"));
    // The same template `cap add ios --packagemanager CocoaPods` unpacks.
    // Copied in and extracted with cwd rather than passed by absolute path:
    // GNU tar reads the `@` in `@capacitor` as a remote user@host spec and
    // tries to open a network connection.
    copyFileSync(template, path.join(work, "template.tar.gz"));
    execFileSync("tar", ["-xzf", "template.tar.gz"], { cwd: work, stdio: "pipe" });
    projectDir = path.join(work, "App");

    execFileSync("node", ["scripts/ios-configure.mjs", "--project", projectDir], {
      cwd: repoRoot,
      stdio: "pipe",
    });

    pbxproj = readFileSync(path.join(projectDir, "App.xcodeproj", "project.pbxproj"), "utf8");
    info = plist.parse(
      readFileSync(path.join(projectDir, "App", "Info.plist"), "utf8"),
    ) as Record<string, unknown>;
  }, 120_000);

  afterAll(() => {
    if (work) rmSync(work, { recursive: true, force: true });
  });

  it("declares export compliance so uploads do not stall", () => {
    // Without this key every App Store Connect upload waits for the
    // export-compliance question to be answered by hand.
    expect(info.ITSAppUsesNonExemptEncryption).toBe(false);
  });

  it("writes the permission strings App Review reads", () => {
    for (const key of [
      "NSCameraUsageDescription",
      "NSMicrophoneUsageDescription",
      "NSLocalNetworkUsageDescription",
    ]) {
      expect(typeof info[key]).toBe("string");
      expect((info[key] as string).length).toBeGreaterThan(20);
    }
  });

  it("targets iPad only", () => {
    // "1,2" is the template's iPhone+iPad default. Shipping that means the
    // store demands iPhone screenshots and a UI that works at phone size.
    expect(pbxproj).not.toContain('TARGETED_DEVICE_FAMILY = "1,2"');
    const iPadOnly = pbxproj.match(/TARGETED_DEVICE_FAMILY = "2";/g) ?? [];
    expect(iPadOnly).toHaveLength(2); // Debug + Release
  });

  it("emits an InfoPlist.strings for every shipped language", () => {
    for (const lproj of EXPECTED_LPROJ) {
      const file = path.join(projectDir, "App", `${lproj}.lproj`, "InfoPlist.strings");
      expect(existsSync(file)).toBe(true);
      const contents = readFileSync(file, "utf8");
      for (const key of [
        "NSCameraUsageDescription",
        "NSMicrophoneUsageDescription",
        "NSLocalNetworkUsageDescription",
      ]) {
        expect(contents).toContain(`"${key}" = "`);
      }
    }
  });

  it("actually localizes — the non-English strings are not the English ones", () => {
    // The failure this catches is a table where a locale was added but its
    // values were copied from English: the file exists, the build succeeds, and
    // a Hebrew family still gets an English prompt.
    const english = readFileSync(
      path.join(projectDir, "App", "en.lproj", "InfoPlist.strings"),
      "utf8",
    );
    for (const lproj of EXPECTED_LPROJ.filter((l) => l !== "en")) {
      const contents = readFileSync(
        path.join(projectDir, "App", `${lproj}.lproj`, "InfoPlist.strings"),
        "utf8",
      );
      expect(contents).not.toBe(english);
    }
  });

  it("registers the strings in the Resources build phase", () => {
    // A .lproj on disk that no build phase copies is simply absent from the
    // .app — the localization silently does nothing.
    const variantGroup = pbxproj.match(
      /([0-9A-F]{24}) \/\* InfoPlist\.strings \*\/ = \{\n\t+isa = PBXVariantGroup;/,
    );
    expect(variantGroup).not.toBeNull();

    const buildFile = pbxproj.match(
      /([0-9A-F]{24}) \/\* InfoPlist\.strings in Resources \*\/ = \{isa = PBXBuildFile; fileRef = ([0-9A-F]{24})/,
    );
    expect(buildFile).not.toBeNull();
    expect(buildFile![2]).toBe(variantGroup![1]);

    const resourcesPhase = pbxproj.match(
      /isa = PBXResourcesBuildPhase;[\s\S]*?files = \(([\s\S]*?)\);/,
    );
    expect(resourcesPhase).not.toBeNull();
    expect(resourcesPhase![1]).toContain(buildFile![1]);
  });

  it("leaves a structurally intact project file", () => {
    // No Xcode here to parse it, so assert what a textual patch can break:
    // delimiter balance, and object ids referenced but never defined.
    expect(pbxproj.split("{").length).toBe(pbxproj.split("}").length);
    expect(pbxproj.split("(").length).toBe(pbxproj.split(")").length);

    const defined = new Set(
      [...pbxproj.matchAll(/^\t\t([0-9A-F]{24}) \/\*/gm)].map((m) => m[1]),
    );
    const referenced = [...pbxproj.matchAll(/^\t{3,4}([0-9A-F]{24}) \/\*/gm)].map((m) => m[1]);
    expect(referenced.filter((id) => !defined.has(id))).toEqual([]);

    // knownRegions must not gain a second `en` — the template already has one.
    const regions = pbxproj.match(/knownRegions = \(([\s\S]*?)\);/)![1];
    const entries = regions
      .split("\n")
      .map((l) => l.trim().replace(/[",]/g, ""))
      .filter(Boolean);
    expect(entries.length).toBe(new Set(entries).size);
  });

  it("is idempotent, and --check passes on its own output", () => {
    const second = execFileSync(
      "node",
      ["scripts/ios-configure.mjs", "--project", projectDir],
      { cwd: repoRoot, encoding: "utf8" },
    );
    expect(second).toContain("already up to date");
    expect(second).not.toContain("patched");

    // --check exits non-zero (throwing here) if anything is stale.
    execFileSync("node", ["scripts/ios-configure.mjs", "--project", projectDir, "--check"], {
      cwd: repoRoot,
      stdio: "pipe",
    });
  }, 120_000);
});

describe("iOS permission strings cover the shipped languages", () => {
  it("has a translation for every client-aac locale", async () => {
    // The real risk: someone adds a 12th language to the app and the iOS
    // permission dialogs quietly stay English for it.
    const locales = readdirSync(path.join(repoRoot, "client-aac", "src", "i18n"))
      .filter((f) => f.endsWith(".ts") && f !== "index.ts")
      .map((f) => f.replace(/\.ts$/, ""));

    const mod = await import(
      path.join(repoRoot, "scripts", "ios-permission-strings.mjs").replace(/\\/g, "/")
    );

    for (const locale of locales) {
      expect(Object.keys(mod.LPROJ_FOR_LOCALE)).toContain(locale);
      if (locale === "en") continue;
      const entry = mod.IOS_PERMISSION_STRINGS[locale];
      expect(entry).toBeDefined();
      for (const key of Object.keys(mod.BASE_PERMISSION_STRINGS)) {
        expect(typeof entry[key]).toBe("string");
      }
    }
  });
});
