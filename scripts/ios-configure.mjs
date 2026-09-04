// scripts/ios-configure.mjs
//
// Applies our customizations to the GENERATED iOS project.
//
// `ios/` is not committed — the release workflow runs `npx cap add ios` on a
// macOS runner, which emits a stock Xcode project from the Capacitor template.
// Everything we need to change about that template lives here, so the native
// project stays disposable and there is exactly one reviewable place where the
// app's iOS permissions and behaviour are declared.
//
// Run AFTER `cap add ios` / `cap sync ios`, BEFORE `xcodebuild`:
//     node scripts/ios-configure.mjs
//
// Idempotent: safe to run repeatedly on the same project.
//
// Four things are applied here: Info.plist keys, the app icon, the localized
// permission strings, and the Xcode build settings we override (device family).
//
// Usage notes:
//   --project <dir>   root of the generated iOS project (default: ios/App)
//   --check           verify without writing; exit 1 if changes are needed

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import * as plist from "plist";
import sharp from "sharp";
import {
  BASE_PERMISSION_STRINGS,
  IOS_PERMISSION_STRINGS,
  LPROJ_FOR_LOCALE,
} from "./ios-permission-strings.mjs";

const args = process.argv.slice(2);
const checkOnly = args.includes("--check");
const projectArgIndex = args.indexOf("--project");
const projectDir = projectArgIndex >= 0 ? args[projectArgIndex + 1] : path.join("ios", "App");

const infoPlistPath = path.join(projectDir, "App", "Info.plist");

/**
 * Keys we force into Info.plist.
 *
 * Every usage-description string here is USER-FACING: iOS shows it verbatim in
 * the permission dialog, and App Review rejects builds whose strings don't
 * explain the actual use. They are intentionally concrete about why an AAC app
 * needs each capability.
 *
 * The values below are the ENGLISH fallback. iOS localizes permission strings
 * via per-.lproj InfoPlist.strings files, which the Capacitor template does not
 * create — this script writes them (see "Localized permission strings" below)
 * so a Hebrew-speaking family does not get an English system prompt in front of
 * an otherwise fully-Hebrew app.
 */
const REQUIRED_KEYS = {
  // Camera / microphone / local-network usage descriptions. These live in
  // scripts/ios-permission-strings.mjs because they are ALSO emitted as
  // per-language InfoPlist.strings below, and the English must not drift
  // between the two.
  ...BASE_PERMISSION_STRINGS,

  // Export compliance. The app uses only standard HTTPS/TLS, which is exempt
  // under the "limited exemption" category, but the declaration is still
  // mandatory: without this key EVERY App Store Connect upload stops and waits
  // for the export-compliance question to be answered by hand in the web UI.
  ITSAppUsesNonExemptEncryption: false,

  // A communication device must not be resized into Slide Over / Split View
  // mid-sentence: the board is a fixed-layout target surface, and a student
  // driving it by dwell cannot recover from the layout moving underneath them.
  UIRequiresFullScreen: true,

  // iPad is used in both orientations depending on how the device is mounted
  // on a wheelchair or stand. Upside-down is included deliberately — mounts
  // are frequently rigged that way to get the camera at eye level.
  "UISupportedInterfaceOrientations~ipad": [
    "UIInterfaceOrientationPortrait",
    "UIInterfaceOrientationPortraitUpsideDown",
    "UIInterfaceOrientationLandscapeLeft",
    "UIInterfaceOrientationLandscapeRight",
  ],

  // Keep the status bar out of the way; the AAC client owns the full surface.
  UIStatusBarHidden: true,
  UIViewControllerBasedStatusBarAppearance: false,
};

/**
 * App Transport Security. We do NOT set NSAllowsArbitraryLoads — that is a
 * blanket disable of TLS enforcement and draws App Review scrutiny. Only
 * local networking is excepted, which is what the ws://localhost eye-tracker
 * bridge actually needs.
 */
const ATS_KEY = "NSAppTransportSecurity";
const ATS_VALUE = { NSAllowsLocalNetworking: true };

/**
 * App icon.
 *
 * The Capacitor template does not ship a usable AppIcon, and `ios/` is
 * regenerated from that template on every build — so without this step the
 * iPad app shipped with no icon at all (blank tile on the home screen and in
 * TestFlight). App Store Connect also rejects a build whose icon is missing or
 * carries an alpha channel, so this is a release blocker, not cosmetics.
 *
 * SOURCE IS SHARED WITH WINDOWS ON PURPOSE. This reads the very file
 * electron-builder.yml points `win.icon` at, so the two shells cannot drift
 * apart the way the website's icon set did. Repointing one repoints both.
 */
const ICON_SOURCE = path.join("electron", "resources", "icon.png");

/** Apple's required app-icon size. Xcode derives every smaller variant. */
const ICON_SIZE = 1024;

/**
 * The artwork is transparent and runs to within ~1% of its left and right
 * edges, so it gets two treatments the Windows .ico doesn't need:
 *
 *   - flattened onto white. iOS forbids alpha in an app icon; it would be
 *     composited onto black, which the dark purple body sinks into.
 *   - inset, so the outer frills clear the squircle mask iOS applies.
 */
const ICON_INSET = 0.88;
const ICON_BG = { r: 255, g: 255, b: 255, alpha: 1 };

/** Xcode 14+ single-size app icon: one 1024 image, all variants derived. */
const ICON_FILENAME = "AppIcon-512@2x.png";
const ICON_CONTENTS = {
  images: [
    {
      filename: ICON_FILENAME,
      idiom: "universal",
      platform: "ios",
      size: "1024x1024",
    },
  ],
  info: { author: "xcode", version: 1 },
};

function fail(message) {
  console.error(`[ios-configure] ERROR: ${message}`);
  process.exit(1);
}

if (!existsSync(infoPlistPath)) {
  fail(
    `Info.plist not found at ${infoPlistPath}.\n` +
    `  The iOS project must be generated first:  npx cap add ios\n` +
    `  If it lives elsewhere, pass --project <dir>.`,
  );
}

const original = readFileSync(infoPlistPath, "utf8");

let parsed;
try {
  parsed = plist.parse(original);
} catch (err) {
  fail(`could not parse ${infoPlistPath}: ${err.message}`);
}

if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
  fail(`${infoPlistPath} did not parse to a dictionary.`);
}

const changes = [];

for (const [key, value] of Object.entries(REQUIRED_KEYS)) {
  const current = JSON.stringify(parsed[key]);
  const desired = JSON.stringify(value);
  if (current !== desired) {
    changes.push(key);
    parsed[key] = value;
  }
}

// Merge ATS rather than replace, so a key the template adds later survives.
const existingAts = (parsed[ATS_KEY] && typeof parsed[ATS_KEY] === "object") ? parsed[ATS_KEY] : {};
const mergedAts = { ...existingAts, ...ATS_VALUE };
if (JSON.stringify(existingAts) !== JSON.stringify(mergedAts)) {
  changes.push(ATS_KEY);
  parsed[ATS_KEY] = mergedAts;
}

if (changes.length === 0) {
  console.log(`[ios-configure] ${infoPlistPath} already up to date.`);
} else if (!checkOnly) {
  writeFileSync(infoPlistPath, `${plist.build(parsed)}\n`, "utf8");
  console.log(`[ios-configure] updated ${infoPlistPath}`);
  for (const key of changes) console.log(`  - ${key}`);
}

// ── App icon ───────────────────────────────────────────────────────────────

if (!existsSync(ICON_SOURCE)) {
  fail(
    `app icon source not found at ${ICON_SOURCE}.\n` +
    `  This is the same file electron-builder.yml ships as the Windows icon; ` +
    `if it moved, update ICON_SOURCE here and win.icon there together.`,
  );
}

const iconSetDir = path.join(projectDir, "App", "Assets.xcassets", "AppIcon.appiconset");
const iconPath = path.join(iconSetDir, ICON_FILENAME);
const contentsPath = path.join(iconSetDir, "Contents.json");

const inner = Math.round(ICON_SIZE * ICON_INSET);
const rendered = await sharp({
  create: { width: ICON_SIZE, height: ICON_SIZE, channels: 4, background: ICON_BG },
})
  .composite([
    {
      input: await sharp(ICON_SOURCE)
        .resize(inner, inner, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .png()
        .toBuffer(),
      gravity: "centre",
    },
  ])
  .flatten({ background: ICON_BG })
  .removeAlpha() // App Store Connect rejects an app icon with an alpha channel
  .png()
  .toBuffer();

const desiredContents = `${JSON.stringify(ICON_CONTENTS, null, 2)}\n`;

// sharp is deterministic for a given input and settings, so comparing bytes is
// a real up-to-date test rather than a mere existence check — which is what
// makes --check able to catch a stale icon.
const iconCurrent =
  existsSync(iconPath) &&
  readFileSync(iconPath).equals(rendered) &&
  existsSync(contentsPath) &&
  readFileSync(contentsPath, "utf8") === desiredContents;

if (iconCurrent) {
  console.log(`[ios-configure] ${iconPath} already up to date.`);
} else if (!checkOnly) {
  mkdirSync(iconSetDir, { recursive: true });

  // Drop any images the template left behind. Once Contents.json names only
  // ours, the rest are unassigned children and Xcode warns about them.
  for (const entry of readdirSync(iconSetDir)) {
    if (entry !== ICON_FILENAME && entry.toLowerCase().endsWith(".png")) {
      rmSync(path.join(iconSetDir, entry));
      console.log(`  - removed stale ${entry}`);
    }
  }

  writeFileSync(iconPath, rendered);
  writeFileSync(contentsPath, desiredContents, "utf8");
  console.log(`[ios-configure] wrote ${iconPath} (${ICON_SIZE}x${ICON_SIZE}, opaque)`);
}

// ── Localized permission strings ───────────────────────────────────────────
//
// iOS shows the camera/microphone/local-network prompts itself, before any of
// our JavaScript runs, and it chooses the language from the DEVICE's preferred
// languages — not from the in-app picker. The only way to translate them is a
// `<lang>.lproj/InfoPlist.strings` file per language inside the app bundle.
//
// The Capacitor template ships no .lproj beyond Base.lproj (the storyboards),
// so both halves of this are ours: writing the files, and registering them in
// the Xcode project so they are actually copied into the bundle. A file on
// disk that no build phase references is silently absent from the .app — which
// is exactly the kind of failure that only shows up on a tester's device.

/** Text of one InfoPlist.strings file. */
function stringsFileFor(entries) {
  const lines = [
    "/* Generated by scripts/ios-configure.mjs — do not edit.",
    "   Source: scripts/ios-permission-strings.mjs */",
  ];
  // Sorted so the output is stable and `--check` can compare byte-for-byte.
  for (const key of Object.keys(entries).sort()) {
    // .strings is a C-like format: backslashes and double quotes must be
    // escaped, and a literal newline would terminate the statement.
    const value = entries[key]
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/\n/g, "\\n");
    lines.push(`"${key}" = "${value}";`);
  }
  return `${lines.join("\n")}\n`;
}

/** lproj directory name → file contents. Built from the shared string table. */
const LPROJ_FILES = new Map();
for (const [locale, dirs] of Object.entries(LPROJ_FOR_LOCALE)) {
  const entries = locale === "en" ? BASE_PERMISSION_STRINGS : IOS_PERMISSION_STRINGS[locale];
  if (!entries) {
    fail(
      `no iOS permission strings for locale "${locale}".\n` +
      `  Every locale in LPROJ_FOR_LOCALE needs an entry in IOS_PERMISSION_STRINGS ` +
      `(except "en", which uses BASE_PERMISSION_STRINGS).`,
    );
  }
  for (const key of Object.keys(BASE_PERMISSION_STRINGS)) {
    if (!entries[key]) {
      fail(`locale "${locale}" is missing a translation for ${key}.`);
    }
  }
  for (const dir of dirs) LPROJ_FILES.set(dir, stringsFileFor(entries));
}

const appSourceDir = path.join(projectDir, "App");
const staleLproj = [];

for (const [dir, contents] of LPROJ_FILES) {
  const target = path.join(appSourceDir, `${dir}.lproj`, "InfoPlist.strings");
  const current = existsSync(target) && readFileSync(target, "utf8") === contents;
  if (current) continue;
  staleLproj.push(dir);
  if (!checkOnly) {
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, contents, "utf8");
  }
}

if (staleLproj.length === 0) {
  console.log(`[ios-configure] InfoPlist.strings up to date for ${LPROJ_FILES.size} languages.`);
} else if (!checkOnly) {
  console.log(`[ios-configure] wrote InfoPlist.strings for: ${staleLproj.join(", ")}`);
}

// ── Xcode project (project.pbxproj) ────────────────────────────────────────
//
// Two things the generated project gets wrong for us:
//
//   1. TARGETED_DEVICE_FAMILY = "1,2" (iPhone + iPad). Submitted that way the
//      App Store requires iPhone screenshots and a UI that works there — and
//      the AAC board is a fixed-layout surface designed for a mounted iPad.
//      Narrow it to iPad.
//   2. The .lproj files written above are not referenced by any build phase,
//      so they would not be copied into the bundle at all.
//
// This is a generated file we fully own, so it is patched textually against
// anchors from the Capacitor template. Every anchor is asserted to match
// EXACTLY once: if a future Capacitor release reshapes the template, this
// fails loudly on the runner instead of quietly shipping an iPhone-sized,
// English-only build.

const pbxprojPath = path.join(projectDir, "App.xcodeproj", "project.pbxproj");

/**
 * Deterministic Xcode object IDs for the objects we add. Xcode IDs are 24
 * uppercase hex characters; this prefix is ours, which is also how the patch
 * detects that it has already been applied.
 */
const UUID_PREFIX = "A1D0BA";
const uuid = (n) => UUID_PREFIX + String(n).padStart(18, "0");
const VARIANT_GROUP_ID = uuid(1);
const BUILD_FILE_ID = uuid(2);
const fileRefId = (index) => uuid(100 + index);

const DEVICE_FAMILY_FROM = 'TARGETED_DEVICE_FAMILY = "1,2";';
const DEVICE_FAMILY_TO = 'TARGETED_DEVICE_FAMILY = "2";'; // 2 = iPad only

let pbxprojChanged = false;

if (!existsSync(pbxprojPath)) {
  // The icon test synthesizes a bare project directory holding only an
  // Info.plist; there is nothing to patch and that is not an error.
  console.log(`[ios-configure] no ${pbxprojPath} — skipping Xcode project patch.`);
} else {
  const before = readFileSync(pbxprojPath, "utf8");
  let pbx = before;

  /** Replace exactly `expected` occurrences, or fail with a legible reason. */
  const replaceExactly = (haystack, from, to, expected, what) => {
    const count = haystack.split(from).length - 1;
    if (count !== expected) {
      fail(
        `${pbxprojPath}: expected ${expected} occurrence(s) of ${what}, found ${count}.\n` +
        `  The Capacitor iOS template has changed shape. Re-check this patch against\n` +
        `  node_modules/@capacitor/cli/assets/ios-pods-template.tar.gz before releasing.`,
      );
    }
    return haystack.split(from).join(to);
  };

  // 1. iPad only. Present in both the Debug and Release target configs.
  if (pbx.includes(DEVICE_FAMILY_FROM)) {
    pbx = replaceExactly(pbx, DEVICE_FAMILY_FROM, DEVICE_FAMILY_TO, 2, "TARGETED_DEVICE_FAMILY");
  } else if (!pbx.includes(DEVICE_FAMILY_TO)) {
    fail(
      `${pbxprojPath}: TARGETED_DEVICE_FAMILY is neither the template's "1,2" nor our "2".\n` +
      `  Refusing to guess — inspect the generated project.`,
    );
  }

  // 2. Register the localized InfoPlist.strings as a variant group in the
  //    Resources build phase. Skipped when our IDs are already present, which
  //    is what makes this half idempotent.
  if (!pbx.includes(UUID_PREFIX)) {
    const dirs = [...LPROJ_FILES.keys()];

    const buildFileLine =
      `\t\t${BUILD_FILE_ID} /* InfoPlist.strings in Resources */ = {isa = PBXBuildFile; ` +
      `fileRef = ${VARIANT_GROUP_ID} /* InfoPlist.strings */; };\n`;
    pbx = replaceExactly(
      pbx,
      "/* End PBXBuildFile section */",
      `${buildFileLine}/* End PBXBuildFile section */`,
      1,
      "the PBXBuildFile section",
    );

    const fileRefLines = dirs
      .map(
        (dir, i) =>
          `\t\t${fileRefId(i)} /* ${dir} */ = {isa = PBXFileReference; ` +
          `lastKnownFileType = text.plist.strings; name = "${dir}"; ` +
          `path = "${dir}.lproj/InfoPlist.strings"; sourceTree = "<group>"; };\n`,
      )
      .join("");
    pbx = replaceExactly(
      pbx,
      "/* End PBXFileReference section */",
      `${fileRefLines}/* End PBXFileReference section */`,
      1,
      "the PBXFileReference section",
    );

    const variantGroup =
      `\t\t${VARIANT_GROUP_ID} /* InfoPlist.strings */ = {\n` +
      `\t\t\tisa = PBXVariantGroup;\n` +
      `\t\t\tchildren = (\n` +
      dirs.map((dir, i) => `\t\t\t\t${fileRefId(i)} /* ${dir} */,\n`).join("") +
      `\t\t\t);\n` +
      `\t\t\tname = InfoPlist.strings;\n` +
      `\t\t\tsourceTree = "<group>";\n` +
      `\t\t};\n`;
    pbx = replaceExactly(
      pbx,
      "/* End PBXVariantGroup section */",
      `${variantGroup}/* End PBXVariantGroup section */`,
      1,
      "the PBXVariantGroup section",
    );

    // Into the Resources build phase — without this the files are in the
    // project but never copied into the .app.
    const resourcesAnchor =
      "\t\t\tisa = PBXResourcesBuildPhase;\n\t\t\tbuildActionMask = 2147483647;\n\t\t\tfiles = (\n";
    pbx = replaceExactly(
      pbx,
      resourcesAnchor,
      `${resourcesAnchor}\t\t\t\t${BUILD_FILE_ID} /* InfoPlist.strings in Resources */,\n`,
      1,
      "the Resources build phase",
    );

    // Into the App group, so the files sit in Xcode's navigator next to the
    // Info.plist they localize. Cosmetic, but a project where a resource has
    // no home group is confusing to open.
    const groupAnchor = pbx.match(/\t{4}([0-9A-F]{24}) \/\* Info\.plist \*\/,\n/);
    if (!groupAnchor) fail(`${pbxprojPath}: could not find the Info.plist entry in the App group.`);
    pbx = replaceExactly(
      pbx,
      groupAnchor[0],
      `${groupAnchor[0]}\t\t\t\t${VARIANT_GROUP_ID} /* InfoPlist.strings */,\n`,
      1,
      "the App group's Info.plist entry",
    );

    // knownRegions is what makes Xcode treat these as localizations rather
    // than loose files, and it is what App Store Connect reads to list the
    // languages the app supports.
    const regionsBlock = pbx.match(/\t{3}knownRegions = \(\n([\s\S]*?)\t{3}\);\n/);
    if (!regionsBlock) fail(`${pbxprojPath}: could not find knownRegions.`);
    // The template already lists `en` (and `Base`); adding it again would give
    // Xcode two entries for one region.
    const existingRegions = new Set(
      regionsBlock[1]
        .split("\n")
        .map((line) => line.trim().replace(/^"|",$|,$|"$/g, ""))
        .filter(Boolean),
    );
    const newRegions = dirs.filter((dir) => !existingRegions.has(dir));
    if (newRegions.length > 0) {
      const regionsAnchor = "\t\t\tknownRegions = (\n";
      pbx = replaceExactly(
        pbx,
        regionsAnchor,
        regionsAnchor + newRegions.map((dir) => `\t\t\t\t"${dir}",\n`).join(""),
        1,
        "knownRegions",
      );
    }
  }

  pbxprojChanged = pbx !== before;
  if (pbxprojChanged && !checkOnly) {
    writeFileSync(pbxprojPath, pbx, "utf8");
    console.log(
      `[ios-configure] patched ${pbxprojPath} (iPad-only, ${LPROJ_FILES.size} localizations)`,
    );
  } else if (!pbxprojChanged) {
    console.log(`[ios-configure] ${pbxprojPath} already up to date.`);
  }
}

if (checkOnly && (changes.length > 0 || !iconCurrent || staleLproj.length > 0 || pbxprojChanged)) {
  if (changes.length > 0) {
    console.error(`[ios-configure] --check failed; these keys need updating: ${changes.join(", ")}`);
  }
  if (!iconCurrent) {
    console.error(`[ios-configure] --check failed; app icon is missing or stale.`);
  }
  if (staleLproj.length > 0) {
    console.error(`[ios-configure] --check failed; InfoPlist.strings stale for: ${staleLproj.join(", ")}`);
  }
  if (pbxprojChanged) {
    console.error(`[ios-configure] --check failed; project.pbxproj needs patching.`);
  }
  process.exit(1);
}
