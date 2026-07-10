// Creature-lab capture: load an example blueprint and screenshot it from a few
// angles, optionally frozen mid-gait. Usage:
//   node shot-creature.cjs [port] [exampleName] [tag] [onlyPrefixes]
// onlyPrefixes: comma-separated view-name prefixes (e.g. "front,side,anim_")
// to shoot a subset. Writes caps-creatures/<tag>_<view>.png
const puppeteer = require("puppeteer");
const fs = require("fs");
const path = require("path");

const port = process.argv[2] || "5184";
const example = process.argv[3] || "Human";
const tag = process.argv[4] || example.toLowerCase().replace(/[^a-z0-9]+/gi, "_");
const only = process.argv[5] ? process.argv[5].split(",") : null;
const wanted = (name) => !only || only.some((p) => name.startsWith(p));

// [name, azimuthDeg, elevationDeg, gait?]
const VIEWS = [
  ["front", 90, 10, null],
  ["side", 0, 5, null],
  ["threequarter", 45, 20, null],
  ["walk_p00", 0, 8, { phase: 0.0 }],
  ["walk_p25", 0, 8, { phase: 0.25 }],
  ["walk_3q_p50", 45, 15, { phase: 0.5 }],
];

// Animator sequence: each entry advances the controller by runS seconds
// (fixed 1/60 steps, deterministic) then shoots. [name, az, el, opts]
const ANIM_VIEWS = [
  ["anim_stand", 30, 10, { speed: 0, runS: 2.0 }],
  ["anim_walk", 0, 8, { speed: 0.35, runS: 2.4 }],
  ["anim_walk2", 30, 8, { speed: 0.35, runS: 0.3 }],
  ["anim_run", 0, 8, { speed: 1, runS: 2.1 }],
  ["anim_run2", 30, 8, { speed: 1, runS: 0.28 }],
  ["anim_reach", 40, 15, { speed: 0, runS: 0.65, action: "pickUp", pre: 0.8 }],
  ["anim_grasp", 40, 15, { runS: 0.5 }],
  ["anim_lift", 40, 15, { runS: 0.65 }],
  ["anim_carry", 40, 15, { runS: 1.5 }],
  ["anim_carrywalk", 0, 8, { speed: 0.35, runS: 1.6 }],
  ["anim_lower", 40, 15, { speed: 0, runS: 0.55, action: "putDown" }],
  ["anim_release", 40, 15, { runS: 0.6 }],
  ["anim_done", 40, 15, { runS: 2.2 }],
  // Two-handed: a crate too wide for one palm.
  ["anim2h_reach", 60, 15, { size: 0.26, speed: 0, runS: 0.7, action: "pickUp", pre: 0.6 }],
  ["anim2h_grasp", 60, 15, { runS: 0.55 }],
  ["anim2h_carry", 60, 15, { runS: 2.6 }],
  ["anim2h_carrywalk", 0, 8, { speed: 0.35, runS: 1.6 }],
  ["anim2h_done", 60, 15, { speed: 0, runS: 5.0, action: "putDown" }],
];

(async () => {
  const outDir = path.join(__dirname, "caps-creatures");
  fs.mkdirSync(outDir, { recursive: true });
  const b = await puppeteer.launch({
    headless: "new",
    protocolTimeout: 180000,
    args: ["--no-sandbox", "--use-gl=angle", "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
  });
  const p = await b.newPage();
  await p.setViewport({ width: 900, height: 700, deviceScaleFactor: 1 });
  p.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
  p.on("console", (m) => { if (m.type() === "error") console.log("CONSOLE:", m.text()); });
  await p.goto(`http://localhost:${port}/lab.html`, { waitUntil: "networkidle0" });
  await p.waitForFunction(() => window.__creatureLab && window.__creatureLab.ready(), { timeout: 20000 });

  const ok = await p.evaluate((name) => window.__creatureLab.loadExample(name), example);
  if (!ok) { console.log(`example not found: ${example}`); await b.close(); process.exit(1); }
  // Hide the control panel so it doesn't cover the creature.
  await p.evaluate(() => {
    const c = document.getElementById("lab-panel");
    if (c) c.style.display = "none";
  });

  for (const [view, az, el, gait] of VIEWS) {
    if (!wanted(view)) continue;
    await p.evaluate((g) => window.__creatureLab.setGait(!!g, g || undefined), gait);
    await p.evaluate((a, e) => window.__creatureLab.orbit(a, e, 1), az, el);
    await new Promise((r) => setTimeout(r, 250));
    const f = path.join(outDir, `${tag}_${view}.png`);
    await p.screenshot({ path: f });
    console.log("shot", path.basename(f));
  }
  await p.evaluate(() => window.__creatureLab.setGait(false));

  // The anim views are a SEQUENCE (each advances the controller), so when
  // filtering we still RUN every step and only skip the screenshot.
  if (ANIM_VIEWS.some(([view]) => wanted(view))) {
    for (const [view, az, el, opts] of ANIM_VIEWS) {
      const action = await p.evaluate((o) => {
        // `pre` runs before the action fires (settle into a stand first).
        if (o.pre) window.__creatureLab.anim({ speed: o.speed ?? 0, runS: o.pre });
        return window.__creatureLab.anim(o);
      }, opts);
      if (!wanted(view)) continue;
      await p.evaluate((a, e) => window.__creatureLab.orbit(a, e, 1), az, el);
      await p.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
      await new Promise((r) => setTimeout(r, 250));
      const f = path.join(outDir, `${tag}_${view}.png`);
      await p.screenshot({ path: f });
      console.log("shot", path.basename(f), "action:", action);
    }
  }
  await b.close();
})();
