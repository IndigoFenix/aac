// scripts/generate-web-icons.mjs
//
// Regenerates the clinician site's whole favicon set from ONE source image.
//
//     npm run icons:web
//
// WHY THIS EXISTS: the set used to be maintained by hand, and drifted. Only
// `favicon.png` was ever updated to the current logo; `favicon.ico`,
// `apple-touch-icon.png` and the two `android-chrome-*` files still held the
// previous one. That is invisible in a browser tab — which uses the declared
// `<link rel="icon">` — but very visible on a desktop shortcut, because
// Chrome's install/shortcut path ignores that declaration. With no manifest it
// falls back to the icon candidates it collects on its own (the implicit
// /favicon.ico, the auto-probed /apple-touch-icon.png) and prefers an EXACT
// pixel-size match over downscaling a large PNG. A Windows shortcut renders at
// 16/32/48 — precisely the sizes the stale .ico offered natively — so it won
// every time and the shortcut showed the old logo indefinitely.
//
// So: one source, every consumer regenerated together, plus a real
// site.webmanifest so the install path reads a declared icon instead of
// guessing. See client/index.html for the declarations.
//
// NOTE FOR WHOEVER REPLACES THE LOGO NEXT: change SOURCE (or the file it
// points at) and re-run. Do not hand-edit anything in client/public/ — it is
// all output.
//
// Usage notes:
//   --out <dir>   write somewhere other than client/public. Used by
//                 server/tests/app-icons.test.ts, which regenerates into a
//                 temp dir and diffs against the committed files, so the set
//                 can never silently drift from the source again.

import sharp from "sharp";
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const SOURCE = "attached_assets/aivota_icon.png";

const outArgIndex = process.argv.indexOf("--out");
const OUT_DIR = outArgIndex >= 0 ? process.argv[outArgIndex + 1] : path.join("client", "public");

/**
 * Sizes baked into favicon.ico.
 *
 * 16/32/48 are what Windows and Chrome actually ask for (tab, taskbar,
 * desktop shortcut); 64/128/256 are there so the shortcut/install path finds
 * an exact match at the larger sizes too rather than reaching for some other
 * file. This is the specific fix for the stale-shortcut bug described above.
 */
const ICO_SIZES = [16, 32, 48, 64, 128, 256];

/**
 * apple-touch-icon is composited by iOS onto an opaque tile and then masked to
 * a squircle, so it gets two treatments the other outputs don't:
 *
 *   - flattened onto white. A transparent touch icon renders against black on
 *     the home screen, which the gold mark nearly disappears into.
 *   - inset. The artwork runs to within ~0.6% of the source's left and right
 *     edges, and the wing tips sit high enough to fall inside the corner
 *     radius; full-bleed would clip them.
 */
const TOUCH_ICON_SIZE = 180;
const TOUCH_ICON_INSET = 0.88; // artwork occupies 88% of the tile
const TOUCH_ICON_BG = { r: 255, g: 255, b: 255, alpha: 1 };

/** Builds a PNG-embedded .ico from pre-rendered PNG buffers. */
function buildIco(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: 1 = icon
  header.writeUInt16LE(pngs.length, 4);

  const DIR_ENTRY = 16;
  let offset = header.length + pngs.length * DIR_ENTRY;

  const entries = pngs.map(({ size, data }) => {
    const e = Buffer.alloc(DIR_ENTRY);
    e.writeUInt8(size >= 256 ? 0 : size, 0); // 0 means 256
    e.writeUInt8(size >= 256 ? 0 : size, 1);
    e.writeUInt8(0, 2); // palette size — 0 for truecolor
    e.writeUInt8(0, 3); // reserved
    e.writeUInt16LE(1, 4); // colour planes
    e.writeUInt16LE(32, 6); // bits per pixel
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += data.length;
    return e;
  });

  return Buffer.concat([header, ...entries, ...pngs.map((p) => p.data)]);
}

/** Square render at `size`, transparency preserved. */
function square(size) {
  return sharp(SOURCE)
    .resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
}

function write(name, data) {
  const dest = path.join(OUT_DIR, name);
  writeFileSync(dest, data);
  console.log(`  ${dest.padEnd(44)} ${String(data.length).padStart(7)} bytes`);
}

const meta = await sharp(SOURCE).metadata();
console.log(`[icons] source ${SOURCE} — ${meta.width}x${meta.height}`);

if (meta.width !== meta.height) {
  console.warn(`[icons] WARNING: source is not square; output will be letterboxed.`);
}
if (meta.width < 512) {
  console.warn(
    `[icons] WARNING: source is ${meta.width}px. 512 is the largest size we emit, ` +
      `so anything smaller is upscaled and will look soft.`,
  );
}

mkdirSync(OUT_DIR, { recursive: true });

// Declared tab icon. Kept at full source resolution — it is also what Chrome
// downscales from when it wants a size the .ico doesn't carry.
write("favicon.png", await square(Math.min(meta.width, 512)));
write("favicon-16x16.png", await square(16));
write("favicon-32x32.png", await square(32));

const icoPngs = [];
for (const size of ICO_SIZES) icoPngs.push({ size, data: await square(size) });
write("favicon.ico", buildIco(icoPngs));

// Manifest icons. Transparency is fine here: Chrome composites these onto its
// own surface, and a hard white tile would look wrong in a dark taskbar.
write("android-chrome-192x192.png", await square(192));
write("android-chrome-512x512.png", await square(512));

const inner = Math.round(TOUCH_ICON_SIZE * TOUCH_ICON_INSET);
write(
  "apple-touch-icon.png",
  await sharp({
    create: {
      width: TOUCH_ICON_SIZE,
      height: TOUCH_ICON_SIZE,
      channels: 4,
      background: TOUCH_ICON_BG,
    },
  })
    .composite([
      {
        input: await sharp(SOURCE)
          .resize(inner, inner, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
          .png()
          .toBuffer(),
        gravity: "centre",
      },
    ])
    .flatten({ background: TOUCH_ICON_BG })
    .removeAlpha() // flatten makes it opaque; this drops the now-pointless channel
    .png()
    .toBuffer(),
);

console.log("[icons] done.");
