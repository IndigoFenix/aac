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
// Usage notes:
//   --project <dir>   root of the generated iOS project (default: ios/App)
//   --check           verify without writing; exit 1 if changes are needed

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import * as plist from "plist";

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
  process.exit(0);
}

if (checkOnly) {
  console.error(`[ios-configure] --check failed; these keys need updating: ${changes.join(", ")}`);
  process.exit(1);
}

writeFileSync(infoPlistPath, `${plist.build(parsed)}\n`, "utf8");
console.log(`[ios-configure] updated ${infoPlistPath}`);
for (const key of changes) console.log(`  - ${key}`);
