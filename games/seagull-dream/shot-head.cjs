// Head close-up capture. Usage:
//   node shot-head.cjs [port] [exampleName|@file.json#index] [tag] [gape]
// @animals-adjusted.json#1 loads the 2nd blueprint from that file.
// Writes caps-creatures/<tag>_head_<view>.png (+ _open when gape>0).
const puppeteer = require("puppeteer");
const fs = require("fs");
const path = require("path");

const port = process.argv[2] || "5184";
const example = process.argv[3] || "Human";
const tag = process.argv[4] || example.toLowerCase().replace(/[^a-z0-9@#.]+/gi, "_");
const gape = parseFloat(process.argv[5] || "0");

// [name, azimuthDeg, elevationDeg] — 90 = head-on, 0 = right profile.
const VIEWS = [
  ["front", 90, 5],
  ["profile", 0, 0],
  ["threequarter", 45, 10],
];

// Resolve @file.json#index into a blueprint JSON string, else null (name load).
let blueprintJson = null;
if (example.startsWith("@")) {
  const [file, idx] = example.slice(1).split("#");
  const arr = JSON.parse(fs.readFileSync(path.join(__dirname, "src", "creatures", file), "utf8"));
  blueprintJson = JSON.stringify(arr[parseInt(idx || "0", 10)]);
}

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
  await p.setViewport({ width: 700, height: 600, deviceScaleFactor: 1 });
  p.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
  await p.goto(`http://localhost:${port}/lab.html`, { waitUntil: "networkidle0" });
  await p.waitForFunction(() => window.__creatureLab && window.__creatureLab.ready(), { timeout: 20000 });

  if (blueprintJson) {
    await p.evaluate((j) => window.__creatureLab.applyBlueprint(j), blueprintJson);
  } else {
    const ok = await p.evaluate((name) => window.__creatureLab.loadExample(name), example);
    if (!ok) { console.log(`example not found: ${example}`); await b.close(); process.exit(1); }
  }
  await p.evaluate(() => {
    const c = document.getElementById("lab-panel");
    if (c) c.style.display = "none";
  });
  await p.evaluate((g) => window.__creatureLab.setGape(g), gape);
  if (process.env.WIRE) await p.evaluate(() => window.__creatureLab.setWireframe(true));
  if (process.env.BARE) await p.evaluate(() => window.__creatureLab.setTissue(false));
  if (process.env.CEL) await p.evaluate(() => window.__creatureLab.setCel(true));

  const suffix = (gape > 0 ? "_open" : "") + (process.env.WIRE ? "_wire" : "") + (process.env.CEL ? "_cel" : "");
  for (const [view, az, el] of VIEWS) {
    await p.evaluate((a, e) => {
      window.__creatureLab.frameHead(1);
      window.__creatureLab.orbit(a, e, 1);
    }, az, el);
    await new Promise((r) => setTimeout(r, 250));
    const f = path.join(outDir, `${tag}_head_${view}${suffix}.png`);
    await p.screenshot({ path: f });
    console.log("shot", path.basename(f));
  }
  await b.close();
})();
