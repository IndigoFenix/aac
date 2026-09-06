// Verify a built iOS artifact from a machine with no Mac and no iPad.
//
//   node scripts/verify-ios-ipa.mjs <artifact.zip | app.ipa | extracted dir>
//
// Everything scripts/ios-configure.mjs does happens on a macOS runner we cannot
// reproduce, to a project (`ios/`) that is gitignored and thrown away after the
// build. The jest suite proves the script produces the right *project*; nothing
// proved the project produced the right *app*. This closes that: it reads the
// shipped bundle and asserts what the store and the student actually depend on.
//
// Both inputs a GitHub run gives you work directly:
//   - the workflow artifact zip (which contains the .ipa), or
//   - the .ipa itself.
//
// A built bundle's plists are compiled to binary; `plist` (already a
// devDependency, and what server/tests/ios-configure.test.ts uses) reads both
// that and XML, so this needs nothing new installed.

import { readFileSync, existsSync, statSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import { parse as parseXml, parseBinary } from "plist";
import { LPROJ_FOR_LOCALE } from "./ios-permission-strings.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * A built bundle's plists are binary (Xcode compiles even the .strings files);
 * a hand-assembled or source-tree one is XML. Dispatch on the magic rather than
 * assuming, so the same checks work on both.
 *
 * `plist` carries both readers. Note it publishes NAMED exports only — it has
 * no default export under Node's ESM interop, so `import plist from "plist"`
 * silently yields undefined and blows up at the first call.
 */
const parsePlist = (buf) =>
  buf.subarray(0, 8).toString("latin1") === "bplist00"
    ? parseBinary(buf)
    : parseXml(buf.toString("utf8"));

const USAGE_KEYS = [
  "NSCameraUsageDescription",
  "NSMicrophoneUsageDescription",
  "NSLocalNetworkUsageDescription",
];

const errors = [];
const warnings = [];
const err = (m) => errors.push(m);
const warn = (m) => warnings.push(m);

// ── Load the bundle ────────────────────────────────────────────────────────
//
// Represented as a flat map of bundle-relative path → Buffer, so a directory
// and a (possibly doubly-nested) zip are read by the same checks below.

/** Pull `Payload/App.app/**` out of a zip, tolerating an artifact zip wrapping an .ipa. */
async function filesFromZip(buf, depth = 0) {
  const zip = await JSZip.loadAsync(buf);
  const names = Object.keys(zip.files);

  // A workflow artifact is a zip containing the .ipa, which is itself a zip.
  const nested = names.find((n) => n.endsWith(".ipa"));
  if (nested && depth < 2) {
    console.log(`  (unwrapping ${nested})`);
    return filesFromZip(await zip.file(nested).async("nodebuffer"), depth + 1);
  }

  const prefix = names.find((n) => /^Payload\/[^/]+\.app\//.test(n));
  if (!prefix) throw new Error("no Payload/*.app/ inside the archive — is this an iOS artifact?");
  const appRoot = prefix.slice(0, prefix.indexOf(".app/") + 5);

  const files = new Map();
  for (const name of names) {
    if (!name.startsWith(appRoot) || zip.files[name].dir) continue;
    files.set(name.slice(appRoot.length), await zip.files[name].async("nodebuffer"));
  }
  return files;
}

function filesFromDir(dir) {
  // Accept either the .app itself or anything above it.
  let appRoot = dir;
  if (!existsSync(path.join(appRoot, "Info.plist"))) {
    const payload = path.join(dir, "Payload");
    const search = existsSync(payload) ? payload : dir;
    const app = readdirSync(search).find((n) => n.endsWith(".app"));
    if (!app) throw new Error(`no *.app under ${dir}`);
    appRoot = path.join(search, app);
  }

  const files = new Map();
  const walk = (abs, rel) => {
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      const next = path.join(abs, entry.name);
      const key = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(next, key);
      else files.set(key, readFileSync(next));
    }
  };
  walk(appRoot, "");
  return files;
}

const target = process.argv[2];
if (!target) {
  console.error("usage: node scripts/verify-ios-ipa.mjs <artifact.zip | app.ipa | extracted dir>");
  process.exit(2);
}
if (!existsSync(target)) {
  console.error(`not found: ${target}`);
  process.exit(2);
}

console.log(`Reading ${target}`);
const files = statSync(target).isDirectory()
  ? filesFromDir(target)
  : await filesFromZip(readFileSync(target));

// ── Info.plist ─────────────────────────────────────────────────────────────

const infoRaw = files.get("Info.plist");
if (!infoRaw) {
  console.error("No Info.plist in the bundle — nothing to check.");
  process.exit(1);
}
const info = parsePlist(infoRaw);

console.log(
  `\n${info.CFBundleDisplayName ?? info.CFBundleName} ${info.CFBundleShortVersionString} ` +
  `(build ${info.CFBundleVersion})\n` +
  `  bundle id   ${info.CFBundleIdentifier}\n` +
  `  built with  Xcode ${info.DTXcode} / ${info.DTSDKName}\n` +
  `  min iOS     ${info.MinimumOSVersion}\n`,
);

if (info.CFBundleIdentifier !== "com.aivota.aac") {
  err(`bundle id is ${info.CFBundleIdentifier}, expected com.aivota.aac (must match the App Store Connect record).`);
}

// The SDK floor is owned by the workflows; read it rather than restate it, so
// the spring bump is one edit and this cannot silently disagree with CI.
const workflow = readFileSync(
  path.join(repoRoot, ".github", "workflows", "release-aac-ios.yml"),
  "utf8",
);
const floor = workflow.match(/MIN_IOS_SDK:\s*'([\d.]+)'/)?.[1];
if (!floor) {
  warn("could not read MIN_IOS_SDK from release-aac-ios.yml — SDK not checked.");
} else {
  const sdk = String(info.DTSDKName ?? "").replace(/^iphoneos/, "");
  const cmp = (a, b) => {
    const [x, y] = [a, b].map((v) => String(v).split(".").map(Number));
    for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
    return 0;
  };
  if (!sdk) err(`no DTSDKName in Info.plist — cannot confirm the SDK.`);
  else if (cmp(sdk, floor) < 0) {
    err(
      `built against iOS SDK ${sdk}, below the ${floor} floor. App Store Connect rejects this on upload.\n` +
      `      The runner ignored the Xcode pin, or the pin is wrong — check the "Pin Xcode" step's output.`,
    );
  }
  // UIRequiresFullScreen stops being honoured on new enough SDKs; the plist
  // still carries it, so only a device can settle this.
  if (info.UIRequiresFullScreen && cmp(sdk, "26.0") >= 0) {
    warn(
      `UIRequiresFullScreen is set, but this is built against iOS SDK ${sdk}, where iPadOS may ignore it.\n` +
      `      Confirm ON A DEVICE that the app cannot be dragged into a resizable window mid-session.`,
    );
  }
}

if (info.ITSAppUsesNonExemptEncryption !== false) {
  err(
    `ITSAppUsesNonExemptEncryption is ${JSON.stringify(info.ITSAppUsesNonExemptEncryption)}, expected false. ` +
    `Every upload will stall on the export-compliance question.`,
  );
}

const family = info.UIDeviceFamily;
if (!Array.isArray(family) || family.length !== 1 || Number(family[0]) !== 2) {
  err(
    `UIDeviceFamily is ${JSON.stringify(family)}, expected [2] (iPad only). ` +
    `[1,2] means the store demands iPhone screenshots and a UI that works at phone size.`,
  );
}

for (const key of USAGE_KEYS) {
  const v = info[key];
  if (typeof v !== "string" || v.length < 20) {
    err(`${key} is missing or too short — App Review reads these verbatim.`);
  }
}

// ── Localized permission prompts ───────────────────────────────────────────
//
// The failure this exists for: the .lproj files are written and registered in
// the Xcode project, the build goes green, and they are absent from the .app
// because a build phase did not reference them. Nothing before this point can
// see that — only the shipped bundle can.

const expectedLproj = [...new Set(Object.values(LPROJ_FOR_LOCALE).flat())];
const stringsFor = (dir) => files.get(`${dir}.lproj/InfoPlist.strings`);

const readStrings = (buf) => {
  // Xcode compiles .strings to a binary plist; an uncompiled passthrough stays
  // in the original text format. Never XML either way — so this deliberately
  // does not go through parsePlist, whose XML branch would log parser errors
  // on every plain-text file.
  if (buf.subarray(0, 8).toString("latin1") === "bplist00") {
    try {
      return JSON.stringify(parseBinary(buf));
    } catch { /* fall through and compare the raw bytes */ }
  }
  return buf.toString("utf8");
};

const missing = expectedLproj.filter((d) => !stringsFor(d));
if (missing.length) {
  err(
    `no InfoPlist.strings in the bundle for: ${missing.join(", ")}.\n` +
    `      Those languages get ENGLISH permission prompts. iOS picks this from the\n` +
    `      DEVICE language, so the in-app picker cannot compensate.`,
  );
}

const english = stringsFor("en") && readStrings(stringsFor("en"));
if (english) {
  const identical = expectedLproj
    .filter((d) => d !== "en" && stringsFor(d))
    .filter((d) => readStrings(stringsFor(d)) === english);
  if (identical.length) {
    err(`these localizations are byte-identical to English: ${identical.join(", ")}.`);
  }
}

const present = expectedLproj.filter((d) => stringsFor(d)).length;
console.log(`  localizations  ${present}/${expectedLproj.length} InfoPlist.strings present`);

// ── Report ─────────────────────────────────────────────────────────────────

console.log("");
for (const w of warnings) console.log(`WARN  ${w}`);
for (const e of errors) console.log(`FAIL  ${e}`);

if (errors.length === 0) {
  console.log(`\nOK — ${warnings.length} warning(s), nothing blocking.`);
  process.exit(0);
}
console.log(`\n${errors.length} problem(s). This build should not be uploaded.`);
process.exit(1);
