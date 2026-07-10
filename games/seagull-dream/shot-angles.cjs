// One-off: custom-angle head close-ups for membrane inspection.
// node shot-angles.cjs <port> <example> <gape> <tag> <az,el az,el ...>
const puppeteer = require("puppeteer");
const fs = require("fs");
const path = require("path");

const port = process.argv[2] || "5184";
const example = process.argv[3] || "Quadruped";
const gape = parseFloat(process.argv[4] || "1");
const tag = process.argv[5] || "inspect";
const views = (process.argv[6] || "25,-5 155,0").split(" ").map((v) => v.split(",").map(Number));
const outDir = path.join("C:/Users/Daniel/Documents/Apps/aac/cliniaacian/games/seagull-dream", "caps-creatures");

(async () => {
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
  const ok = await p.evaluate((name) => window.__creatureLab.loadExample(name), example);
  if (!ok) { console.log(`example not found: ${example}`); await b.close(); process.exit(1); }
  await p.evaluate(() => { const c = document.getElementById("lab-panel"); if (c) c.style.display = "none"; });
  // SKIN="#base,#belly,#accent" — diagnostic skin override (color-continuity checks).
  if (process.env.SKIN) {
    const [sb, sbe, sa] = process.env.SKIN.split(",");
    await p.evaluate((b2, be2, a2) => {
      const ta = document.getElementById("lab-json");
      const bp = JSON.parse(ta.value);
      bp.skin.baseColor = b2; bp.skin.bellyColor = be2; bp.skin.accentColor = a2;
      window.__creatureLab.applyBlueprint(JSON.stringify(bp));
    }, sb, sbe, sa);
  }
  // MO=0.7 — override head.mouthOpen (commissure-slide checks).
  if (process.env.MO) {
    await p.evaluate((mo) => {
      const ta = document.getElementById("lab-json");
      const bp = JSON.parse(ta.value);
      bp.head.mouthOpen = mo;
      window.__creatureLab.applyBlueprint(JSON.stringify(bp));
    }, parseFloat(process.env.MO));
  }
  // LIFT=0.3 — override neck.lift (jaw/neck junction checks).
  if (process.env.LIFT) {
    await p.evaluate((v) => {
      const ta = document.getElementById("lab-json");
      const bp = JSON.parse(ta.value);
      bp.neck.lift = v;
      window.__creatureLab.applyBlueprint(JSON.stringify(bp));
    }, parseFloat(process.env.LIFT));
  }
  await p.evaluate((g) => window.__creatureLab.setGape(g), gape);
  if (process.env.WIRE) await p.evaluate(() => window.__creatureLab.setWireframe(true));
  if (process.env.CEL) await p.evaluate(() => window.__creatureLab.setCel(true));
  if (process.env.SECT) await p.evaluate(() => window.__creatureLab.setColorSection(true));
  for (let i = 0; i < views.length; i++) {
    const [az, el] = views[i];
    await p.evaluate((a, e) => {
      window.__creatureLab.frameHead(0.8);
      window.__creatureLab.orbit(a, e, 1);
    }, az, el);
    await new Promise((r) => setTimeout(r, 250));
    const f = path.join(outDir, `${tag}_${i}_az${az}_el${el}.png`);
    await p.screenshot({ path: f });
    console.log("shot", path.basename(f));
  }
  await b.close();
})();
