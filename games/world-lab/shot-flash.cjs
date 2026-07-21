// games/world-lab/shot-flash.cjs
//
// Headless driver for THE STAR-FLASH TRAP (see src/flash-watch.ts).
//
// Boots world-lab's Solar System demo with `?flashwatch=1`, strips the scene to
// just the starfield, parks the cursor off-centre so the drone sweeps fast, and
// runs until the trap has caught some flashes — then writes every captured
// frame as a PNG plus a JSON dossier naming the cell behind each one.
//
// Requires the dev server already running:
//   npx vite --config games/world-lab/vite.config.ts
// then:
//   node games/world-lab/shot-flash.cjs [seconds] [outDir]
//
// NOTE ON SOFTWARE RENDERING: this runs under SwiftShader, so absolute pixel
// values and frame rate differ from a real GPU. A low frame rate means a LARGER
// dt per frame, which makes per-frame boundary bugs MORE likely to trip, not
// less — but a negative result here does not clear the bug. The same trap runs
// in a real browser: open `?flashwatch=1`, call `__flash.clean()`, fly, then
// `__flash.save()`.

const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer");

const SECONDS = Number(process.argv[2] || 90);
const OUT = process.argv[3] || path.join(__dirname, "flash-out");
const URL_BASE = process.env.WORLD_LAB_URL || "http://localhost:5189/";

(async () => {
  fs.mkdirSync(OUT, { recursive: true });

  const browser = await puppeteer.launch({
    headless: "new",
    args: [
      "--use-gl=angle",
      "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader",
      "--no-sandbox",
      "--window-size=1280,720",
    ],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });

  page.on("console", (m) => {
    const t = m.text();
    // The trap's own findings, plus anything that smells like a failure.
    if (/^\[flash\]/.test(t) || /error|exception|NaN|Inf/i.test(t)) {
      console.log(`  [page] ${t}`);
    }
  });
  page.on("pageerror", (e) => console.log(`  [pageerror] ${e.message}`));

  console.log(`→ ${URL_BASE}?flashwatch=1`);
  await page.goto(`${URL_BASE}?flashwatch=1`, { waitUntil: "domcontentloaded" });

  // Wait for the world to boot — __flash exists at once, but the starfield only
  // has content once flight is up.
  await page.waitForFunction(
    () => window.__flash && window.__flightLab,
    { timeout: 120000, polling: 500 },
  );
  console.log("✓ world booted");

  await page.evaluate(() => window.__flash.clean());

  // UPPER-LEFT CORNER — the user's reliable repro. Past ROT_EDGE horizontally
  // is a fast lateral sweep and above ASC_START is a climb, and both pan rates
  // scale with ALTITUDE, so climbing compounds into runaway outward speed. That
  // is the fastest sustained motion the spirit ladder offers.
  const corner = process.env.FLASH_CORNER || "upper-left";
  const view = await page.$("#view");
  const box = await view.boundingBox();
  const fx = corner.includes("right") ? 0.97 : 0.03;
  const fy = corner.includes("lower") ? 0.97 : 0.03;
  const px = box.x + box.width * fx;
  const py = box.y + box.height * fy;
  console.log(`✓ cursor parked ${corner} (${px.toFixed(0)}, ${py.toFixed(0)})`);
  await page.mouse.move(px, py);
  // Re-assert periodically: some rungs reset pointer state on a transition.
  const keepAlive = setInterval(() => {
    page.mouse.move(px, py).catch(() => {});
  }, 250);

  console.log(`✓ sweeping for ${SECONDS}s...`);
  await new Promise((r) => setTimeout(r, SECONDS * 1000));
  clearInterval(keepAlive);

  const stats = await page.evaluate(() => window.__flash.hdrStats());
  const records = await page.evaluate(() => window.__flash.report());
  console.log(
    `\n=== ${records.length} flash(es) over ${stats.frames} frames === ` +
    `peak raw radiance ${stats.max.toExponential(3)}, ` +
    `${stats.badFrames} frame(s) with overflow/NaN`,
  );

  const dossier = records.map((r, i) => {
    if (r.png) {
      const file = path.join(OUT, `flash-${String(i).padStart(2, "0")}-frame${r.frame}.png`);
      fs.writeFileSync(file, Buffer.from(r.png.split(",")[1], "base64"));
    }
    const { png, ...rest } = r;
    const w = r.top[0];
    console.log(
      `#${i} frame ${r.frame}  mean ${r.prevMean.toFixed(1)} → ${r.mean.toFixed(1)} ` +
      `→ ${r.nextMean == null ? "?" : r.nextMean.toFixed(1)}  ` +
      `${r.transient ? "TRANSIENT (one-frame)" : "sustained"}  ` +
      `galacticStep ${Number(r.galacticStepLy).toExponential(2)} ly`,
    );
    if (r.hdr) {
      console.log(
        `     raw radiance ${Number(r.hdr.prevValue).toExponential(2)} → ${Number(r.hdr.value).toExponential(2)}` +
        `${r.hdr.bad ? "  ⚠ OVERFLOW/NaN" : ""}  at uv(${r.hdr.u.toFixed(3)}, ${r.hdr.v.toFixed(3)})`,
      );
    }
    if (w) {
      console.log(
        `     loudest: ${w.kind} ${w.id} tier ${w.tier}  ${w.pix.toFixed(0)}px  ` +
        `k=${w.k == null ? "?" : w.k.toFixed(4)}  d=${w.distLy == null ? "?" : w.distLy.toFixed(1)} ly  ` +
        `weight=${w.fadeWeight == null ? "?" : w.fadeWeight.toFixed(3)}  ` +
        `rgb=[${w.color.map((c) => c.toFixed(2)).join(", ")}]`,
      );
    }
    return rest;
  });

  fs.writeFileSync(path.join(OUT, "flash-dossier.json"), JSON.stringify(dossier, null, 2));
  console.log(`\n→ ${OUT}`);

  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
