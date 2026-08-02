// Guards the app icon sets against silent drift.
//
// This suite exists because of a real bug: the clinician site's logo was
// replaced, but only `client/public/favicon.png` was regenerated. `favicon.ico`,
// `apple-touch-icon.png` and both `android-chrome-*` files kept the previous
// logo for months. Nothing caught it, because a browser TAB reads the declared
// `<link rel="icon">` and looked correct — while Chrome's desktop-shortcut /
// install path, which prefers an exact pixel-size match from the implicit
// /favicon.ico, kept handing out the old one.
//
// The iPad shell had the mirror-image failure: `ios/` is regenerated from the
// Capacitor template on every build and nothing wrote an AppIcon, so the app
// shipped with no icon at all.
//
// So the invariants asserted here are: every emitted icon is exactly what the
// generator produces from the current source, index.html declares the whole
// set, and the two native shells read the SAME icon file.

import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const publicDir = path.join(repoRoot, "client", "public");

describe("clinician site icon set", () => {
  let generated: string;

  beforeAll(() => {
    // Run the real generator rather than re-implementing it, so this test
    // cannot pass against logic that has diverged from what ships.
    generated = mkdtempSync(path.join(tmpdir(), "aivota-icons-"));
    execFileSync("node", ["scripts/generate-web-icons.mjs", "--out", generated], {
      cwd: repoRoot,
      stdio: "pipe",
    });
  }, 60_000);

  afterAll(() => {
    if (generated) rmSync(generated, { recursive: true, force: true });
  });

  it("ships exactly what the generator produces from the current source", () => {
    const stale: string[] = [];

    for (const name of readdirSync(generated)) {
      const committed = path.join(publicDir, name);
      if (!existsSync(committed)) {
        stale.push(`${name} (missing)`);
        continue;
      }
      if (!readFileSync(committed).equals(readFileSync(path.join(generated, name)))) {
        stale.push(name);
      }
    }

    // Thrown rather than asserted so the failure carries the fix, not just a
    // diff of file names.
    if (stale.length > 0) {
      throw new Error(
        `client/public icons are out of sync with attached_assets/aivota_icon.png.\n` +
          `  Stale: ${stale.join(", ")}\n` +
          `  Fix:   npm run icons:web`,
      );
    }
    expect(stale).toEqual([]);
  });

  it("declares every icon in index.html, including the manifest", () => {
    const html = readFileSync(path.join(repoRoot, "client", "index.html"), "utf8");

    // The .ico and the touch icon are the two Chrome reaches for when building
    // a desktop shortcut; the manifest is what makes it stop guessing at all.
    for (const href of [
      "/favicon.ico",
      "/favicon.png",
      "/favicon-16x16.png",
      "/favicon-32x32.png",
      "/apple-touch-icon.png",
      "/site.webmanifest",
    ]) {
      expect(html).toContain(`href="${href}"`);
    }

    expect(html).toContain('rel="manifest"');
    expect(html).toContain('rel="apple-touch-icon"');
  });

  it("has a manifest whose icons all exist", () => {
    const manifest = JSON.parse(
      readFileSync(path.join(publicDir, "site.webmanifest"), "utf8"),
    ) as { icons: Array<{ src: string; sizes: string; type: string }> };

    expect(manifest.icons.length).toBeGreaterThan(0);

    for (const icon of manifest.icons) {
      const file = path.join(publicDir, icon.src.replace(/^\//, ""));
      expect(existsSync(file)).toBe(true);

      // PNG header carries the real dimensions at bytes 16..24; a manifest that
      // lies about `sizes` makes Chrome pick the wrong icon.
      const buf = readFileSync(file);
      const actual = `${buf.readUInt32BE(16)}x${buf.readUInt32BE(20)}`;
      expect(actual).toBe(icon.sizes);
    }
  });

  it("keeps the apple-touch-icon opaque", () => {
    // iOS composites a transparent touch icon onto black, which the gold mark
    // disappears into. Colour type 2 = RGB, 6 = RGBA (byte 25 of the IHDR).
    const buf = readFileSync(path.join(publicDir, "apple-touch-icon.png"));
    expect(buf.readUInt8(25)).toBe(2);
  });
});

describe("native shell app icon", () => {
  const iconSource = path.join("electron", "resources", "icon.png");

  it("is the same file on Windows and iPad", () => {
    // Both shells must resolve to this one path. electron-builder reads it
    // directly; ios-configure.mjs renders the iOS AppIcon from it at build
    // time, because `ios/` is generated fresh and cannot hold the asset.
    const builder = readFileSync(path.join(repoRoot, "electron-builder.yml"), "utf8");
    const iosConfigure = readFileSync(
      path.join(repoRoot, "scripts", "ios-configure.mjs"),
      "utf8",
    );

    expect(builder).toContain(`icon: ${iconSource.split(path.sep).join("/")}`);
    expect(iosConfigure).toContain(`path.join("electron", "resources", "icon.png")`);
    expect(existsSync(path.join(repoRoot, iconSource))).toBe(true);
  });

  it("renders an opaque 1024px iOS icon", () => {
    const projectDir = mkdtempSync(path.join(tmpdir(), "aivota-ios-"));
    try {
      const appDir = path.join(projectDir, "App");
      execFileSync(
        "node",
        [
          "-e",
          `const {mkdirSync,writeFileSync}=require("node:fs");const p=require("node:path");` +
            `mkdirSync(p.join(${JSON.stringify(appDir)},"App"),{recursive:true});` +
            `writeFileSync(p.join(${JSON.stringify(appDir)},"App","Info.plist"),` +
            `'<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict/></plist>');`,
        ],
        { cwd: repoRoot, stdio: "pipe" },
      );

      execFileSync("node", ["scripts/ios-configure.mjs", "--project", appDir], {
        cwd: repoRoot,
        stdio: "pipe",
      });

      const icon = path.join(
        appDir,
        "App",
        "Assets.xcassets",
        "AppIcon.appiconset",
        "AppIcon-512@2x.png",
      );
      expect(existsSync(icon)).toBe(true);

      const buf = readFileSync(icon);
      expect(buf.readUInt32BE(16)).toBe(1024);
      expect(buf.readUInt32BE(20)).toBe(1024);
      // App Store Connect rejects an app icon carrying an alpha channel.
      expect(buf.readUInt8(25)).toBe(2);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  }, 60_000);
});
