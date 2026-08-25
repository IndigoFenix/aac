// scripts/generate-og-image.mjs
//
// Regenerates the landing page's social-share card.
//
//     npm run og:image
//
// WHY THIS EXISTS: a link to aivota.ai posted in Slack, WhatsApp, LinkedIn or
// X renders whatever `og:image` points at. With no `og:image` at all — the
// state before this file — every one of those unfurls as a bare text link, and
// the platforms give a card with a picture several times the reach of one
// without. The card also has to live at a STABLE path: the hero screenshot the
// landing page imports gets a content hash in its filename at build time, so it
// cannot be named in a meta tag that the prerender writes.
//
// Hence: one committed file at client/public/og-image.png, referenced by the
// absolute URL /og-image.png, regenerated from the same source screenshot the
// hero uses.
//
// 1200x630 is the size both Open Graph and Twitter's summary_large_image want.
// The screenshot is letterboxed onto the brand navy rather than cropped to fill
// — cropping a UI screenshot cuts off exactly the chrome that makes it legible
// at card size.
//
// NOTE FOR WHOEVER CHANGES THE SCREENSHOT NEXT: replace SOURCE and re-run. Do
// not hand-edit client/public/og-image.png — it is output.

import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import sharp from "sharp";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = path.join(ROOT, "attached_assets", "landing-page", "screenshot.png");
const OUT = path.join(ROOT, "client", "public", "og-image.png");

const WIDTH = 1200;
const HEIGHT = 630;
const PADDING = 48;
// --lp-primary in client/src/components/landing-page/landing-page.css
const BACKGROUND = "#1A2B4C";

async function main() {
  if (!fs.existsSync(SOURCE)) {
    console.error(`Source image not found: ${SOURCE}`);
    process.exit(1);
  }

  const inner = await sharp(SOURCE)
    .resize({
      width: WIDTH - PADDING * 2,
      height: HEIGHT - PADDING * 2,
      fit: "inside",
    })
    .png()
    .toBuffer();
  const { width, height } = await sharp(inner).metadata();

  await sharp({
    create: { width: WIDTH, height: HEIGHT, channels: 3, background: BACKGROUND },
  })
    .composite([
      {
        input: inner,
        left: Math.round((WIDTH - width) / 2),
        top: Math.round((HEIGHT - height) / 2),
      },
    ])
    // Palette quantisation keeps a screenshot well under the ~300KB that the
    // slower unfurlers will actually fetch before giving up.
    .png({ compressionLevel: 9, palette: true, quality: 90 })
    .toFile(OUT);

  const bytes = fs.statSync(OUT).size;
  console.log(`${path.relative(ROOT, OUT)}  ${WIDTH}x${HEIGHT}  ${(bytes / 1024).toFixed(0)}KB`);
}

main().catch((err) => {
  console.error("OG image generation failed:", err);
  process.exit(1);
});
