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
// Two things are applied here: Info.plist keys, and the app icon.
//
// Usage notes:
//   --project <dir>   root of the generated iOS project (default: ios/App)
//   --check           verify without writing; exit 1 if changes are needed

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import * as plist from "plist";
import sharp from "sharp";

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
 * NOTE: these are not translated. iOS localizes permission strings via
 * InfoPlist.strings files per .lproj, which the Capacitor template doesn't
 * create. Tracked as follow-up — the AAC client itself is fully i18n'd, so
 * English-only system prompts are an inconsistency worth fixing before a
 * non-English rollout.
 */
const REQUIRED_KEYS = {
  // The Observer agent watches the student through the front camera to read
  // attention, gaze, expression and (where enabled) seizure indicators.
  NSCameraUsageDescription:
    "Aivota uses the camera to see how the student is responding, so the communication board can adapt to them.",

  // Speech from the student and the people around them drives the Observer and
  // the speech-to-text pipeline.
  NSMicrophoneUsageDescription:
    "Aivota listens so it can understand speech and respond to the student.",

  // Eye-tracker companion software is reached over ws://localhost. On iOS any
  // local-network access prompts, and WITHOUT this key the app is terminated
  // rather than merely denied.
  NSLocalNetworkUsageDescription:
    "Aivota connects to eye-tracking hardware on this network so the student can select with their eyes.",

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

if (checkOnly && (changes.length > 0 || !iconCurrent)) {
  if (changes.length > 0) {
    console.error(`[ios-configure] --check failed; these keys need updating: ${changes.join(", ")}`);
  }
  if (!iconCurrent) {
    console.error(`[ios-configure] --check failed; app icon is missing or stale.`);
  }
  process.exit(1);
}
