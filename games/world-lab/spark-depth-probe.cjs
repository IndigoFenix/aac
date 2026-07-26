// Spark DEPTH probe — does a depth-tested spark survive on the planet path?
//
// The question (PLANET_ENTITY_PLAN step 1, "SPARK DEPTH — OFF EVERYWHERE,
// KNOWINGLY WRONG"): on the ground rung the spark should be a 3D being,
// occluded by terrain and walls. With depthTest ON it was reported invisible,
// and the cause was never measured — so main.ts forces depth OFF everywhere.
//
// This boots the earthlike system (the HDR-composer path), flies the drone down
// so the terrain around it actually STREAMS, stands the ladder on the ground
// there, and then runs the A/B:
//
//   marker (a depth-tested MESH at the spark's exact point) visible, spark not
//                              ⇒ SPRITE-specific depth failure
//   neither visible            ⇒ the point really is occluded (placement)
//   both appear only in raw    ⇒ the EffectComposer eats depth-tested sprites
//
// Requires the dev server on :5189 (npx vite --config games/world-lab/vite.config.ts).
//   node games/world-lab/spark-depth-probe.cjs [outDir]
//
// SwiftShader caveat (same as shot-flash.cjs): absolute pixels and frame rate
// differ from a real GPU, so a NEGATIVE result here does not clear the bug.
const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer");

const OUT = process.argv[2] || path.join(__dirname, "spark-out");
const PROFILE = process.env.SPARK_PROFILE || path.join(OUT, "chrome-profile");
const URL_BASE = process.env.WORLD_LAB_URL || "http://localhost:5189/";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await puppeteer.launch({
    headless: "new",
    // A PERSISTENT profile: the geology bake is ~36 s and caches in IndexedDB,
    // so a throwaway profile pays for it on every run.
    userDataDir: PROFILE,
    // REAL GPU by default (SPARK_SWIFTSHADER=1 for the software control).
    // This matters: SwiftShader and a real driver DISAGREE about depth-tested
    // sprites under logarithmicDepthBuffer, so a software "it works" proves
    // nothing about what the player sees.
    args: [
      "--use-gl=angle",
      ...(process.env.SPARK_SWIFTSHADER === "1"
        ? ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"]
        : ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist"]),
      "--no-sandbox", "--window-size=1280,800",
    ],
    defaultViewport: { width: 1280, height: 800 },
  });
  const page = await browser.newPage();
  const logs = [];
  const say = (s) => { logs.push(s); console.log(s); };
  page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));

  await page.goto(URL_BASE, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !!document.querySelector("#world-select"), { timeout: 60000 });
  await page.select("#world-select", "earthlike-system");
  await page.waitForFunction(() => !!window.__spirit && !!window.__spirit.drone, { timeout: 240000 });
  say("booted: " + await page.evaluate(() => JSON.stringify({ level: __spirit.level, alt: Math.round(__spirit.alt) })));
  say("gpu: " + await page.evaluate(() => {
    const c = document.createElement("canvas");
    const gl = c.getContext("webgl2") || c.getContext("webgl");
    const dbg = gl && gl.getExtension("WEBGL_debug_renderer_info");
    return dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : "unknown";
  }));

  // 1) Wait for the home planet's geography (the bake founds the surface the
  //    streamer draws — without it there is nothing to occlude anything).
  await page.waitForFunction(
    () => { const b = __spirit.body; return !!(b && b.geography && !b.geographyPending); },
    { timeout: 600000, polling: 2000 },
  );
  say("geography ready");

  // 2a) FLIGHT rung first: the HUD spark is camera-anchored, drawn on top.
  await page.evaluate(() => {
    const canvas = document.querySelector("#view canvas");
    const r = canvas.getBoundingClientRect();
    canvas.dispatchEvent(new PointerEvent("pointermove", {
      clientX: r.left + r.width * 0.5, clientY: r.top + r.height * 0.45,
      bubbles: true, pointerType: "mouse",
    }));
  });
  await sleep(1500);
  await page.screenshot({ path: path.join(OUT, "0-flight-hud.png") });
  say("flight: " + await page.evaluate(() => JSON.stringify({
    level: __spirit.level, alt: Math.round(__spirit.alt),
    spark: __spark.probe().drawState, drawn: __spark.probe().drawn,
  })));

  // 2) Fly the drone down and let the ground stream in. OVER A CITY by default:
  //    ground mode INSIDE a town is the case that matters (a mounted quest host
  //    reports the cursor, the town's meshes are in the drawn world) — pass
  //    SPARK_WILD=1 for the open-country control.
  say(await page.evaluate((wild) => {
    const b = __spirit.body;
    const V = b.worldPosition.constructor;
    if (wild) {
      __spirit.drone.setGround(new V(0.35, 0.5, 0.79).normalize(), 400);
      return "drone → open country";
    }
    const cities = window.__flightLab.cities().filter((c) => c.body === b);
    const c = cities[0];
    const dir = new V(c.city.dir[0], c.city.dir[1], c.city.dir[2]).normalize().applyQuaternion(b.orientation);
    __spirit.drone.setGround(dir, 250);
    return `drone → city ${c.city.cell} (of ${cities.length})`;
  }, process.env.SPARK_WILD === "1"));
  const view = await page.$("#view");
  const box = await view.boundingBox();
  const cx = Math.round(box.x + box.width / 2);
  const cy = Math.round(box.y + box.height * 0.6);
  for (let i = 0; i < 60; i++) {
    await page.mouse.move(cx + (i % 4), cy + (i % 3));
    await sleep(500);
    const cast = await page.evaluate(() => {
      try { return String(__spark.probe().lastCast || ""); } catch { return ""; }
    });
    if (/hit/.test(cast)) { say("terrain streamed: " + cast); break; }
    if (i === 59) say("terrain never cast a hit: " + cast);
  }

  // 3) Stand on the ground under the drone, WITH the town ref when there is a
  //    town here (that is what puts a reporting host under the glide).
  say(await page.evaluate(() => {
    const b = __spirit.body;
    const V = b.worldPosition.constructor;
    const p = __spirit.drone.groundPoint(b.worldPosition, b.radius, new V());
    let best = null, bd = Infinity;
    for (const c of window.__flightLab.cities()) {
      if (c.body !== b) continue;
      const d = c.worldPos.distanceTo(p);
      if (d < bd) { bd = d; best = c; }
    }
    const town = bd < 2000 ? best : null;
    // Step 250 m off the town centre before landing: standing in a footprint
    // (with the gaze resting in the same one) descends into its dollhouse, and
    // then there is no ground rung left to measure.
    if (town) {
      const away = new V().subVectors(p, town.worldPos);
      if (away.lengthSq() > 1e-6) p.addScaledVector(away.normalize(), 250);
    }
    __spirit.ladder.dropToGround(p, town);
    return `dropped ${[p.x, p.y, p.z].map((n) => n.toFixed(0)).join(",")} town:${town ? town.city.cell : "-"} d${Math.round(bd)}`;
  }));
  // HOLD THE POINTER from inside the page: OS-level mouse moves are unreliable
  // here, and the ladder hides the spark on any frame without a pointer.
  await page.evaluate(() => {
    const canvas = document.querySelector("#view canvas");
    const r = canvas.getBoundingClientRect();
    let k = 0;
    window.__holdPtr = setInterval(() => {
      k++;
      const x = r.left + r.width * (0.5 + 0.06 * Math.sin(k / 9));
      const y = r.top + r.height * (0.68 + 0.04 * Math.cos(k / 6));
      canvas.dispatchEvent(new PointerEvent("pointermove", { clientX: x, clientY: y, bubbles: true, pointerType: "mouse" }));
    }, 60);
  });
  await sleep(4000);
  say("level: " + await page.evaluate(() => __spirit.level));
  say("frames: " + await page.evaluate(() => JSON.stringify(window.__sparkTick || null)));

  const probe = async (tag) => {
    const p = await page.evaluate(() => {
      try { return JSON.stringify(__spark.probe()); } catch (e) { return "probe failed: " + e.message; }
    });
    say(`${tag}: ${p}`);
  };
  const shot = async (name) => page.screenshot({ path: path.join(OUT, name + ".png") });
  const wiggle = async (n = 6) => { await sleep(n * 250); }; // the page-side interval drives the pointer

  // ── A/B 1: depth OFF — today's shipped behaviour (the control) ──────────
  await page.evaluate(() => __spark.depth(false));
  await wiggle();
  await shot("1-depth-off");
  await probe("depth OFF");

  // ── A/B 2: depth ON + a depth-tested MESH marker at the same point ──────
  await page.evaluate(() => __spark.depth(true));
  await wiggle();
  await shot("2a-depth-on-no-marker");
  await probe("depth ON (no marker)");
  await page.evaluate(() => __spark.marker(true));
  await wiggle();
  await shot("2-depth-on-with-marker");
  await probe("depth ON");

  // ── A/B 3: the same, with the EffectComposer bypassed ───────────────────
  await page.evaluate(() => __walk.raw(8));
  await sleep(1500);
  await shot("3-depth-on-raw-no-composer");
  await probe("raw (no composer)");

  // ── A/B 4: depth ON, terrain HIDDEN — is the sprite losing a depth
  //    COMPARISON against the ground, or not being rasterized at all? ───────
  await page.evaluate(() => __spark.hideTerrain(true));
  await wiggle(4);
  await shot("4-depth-on-terrain-hidden");
  await probe("depth ON, terrain hidden");

  // ── A/B 5: depth ON, terrain X-RAYED (drawn, but depthWrite off) — the
  //    same question with the landscape still on screen for reference. ──────
  await page.evaluate(() => { __spark.hideTerrain(false); __spark.xray(true); });
  await wiggle(4);
  await shot("5-depth-on-terrain-xray");
  await probe("depth ON, terrain x-ray");

  await page.evaluate(() => { __spark.xray(false); __spark.marker(false); __spark.depth(null); });
  fs.writeFileSync(path.join(OUT, "log.txt"), logs.join("\n"), "utf8");
  await browser.close();
})().catch((e) => { console.error("PROBE FAILED", e); process.exit(1); });
