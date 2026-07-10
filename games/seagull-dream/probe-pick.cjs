// Headless polygon probe: grid-scan __creatureLab.pickAt over a screen
// region and print each pick (tri/verts/position). Rays that miss the near
// surface (hole!) show far-side or interior hits — x flips sign.
//   node probe-pick.cjs <port> <example> <gape> <az> <el> <nx0> <nx1> <ny0> <ny1> <steps>
// Env: LIFT=, SKIN=, MO= like shot-angles.
const puppeteer = require("puppeteer");

const [, , port = "5184", example = "Quadruped", gapeS = "0",
  azS = "15", elS = "-15", nx0S = "0", nx1S = "0.5", ny0S = "-0.5", ny1S = "0", stepsS = "6"] = process.argv;

(async () => {
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
  await p.evaluate((name) => window.__creatureLab.loadExample(name), example);
  if (process.env.LIFT) {
    await p.evaluate((v) => {
      const bp = JSON.parse(document.getElementById("lab-json").value);
      bp.neck.lift = v;
      window.__creatureLab.applyBlueprint(JSON.stringify(bp));
    }, parseFloat(process.env.LIFT));
  }
  await p.evaluate((g) => window.__creatureLab.setGape(g), parseFloat(gapeS));
  await p.evaluate((a, e) => {
    window.__creatureLab.frameHead(0.8);
    window.__creatureLab.orbit(a, e, 1);
  }, parseFloat(azS), parseFloat(elS));
  await new Promise((r) => setTimeout(r, 250));

  const nx0 = parseFloat(nx0S), nx1 = parseFloat(nx1S), ny0 = parseFloat(ny0S), ny1 = parseFloat(ny1S);
  const steps = parseInt(stepsS, 10);
  for (let j = 0; j <= steps; j++) {
    for (let i = 0; i <= steps; i++) {
      const nx = nx0 + (i / steps) * (nx1 - nx0);
      const ny = ny0 + (j / steps) * (ny1 - ny0);
      const r = await p.evaluate((x, y) => window.__creatureLab.pickAt(x, y), nx, ny);
      if (r) {
        console.log(`ndc(${nx.toFixed(2)},${ny.toFixed(2)}) tri ${r.tri} verts ${r.verts.join(",")} @ ${r.point.join(",")}`);
      } else {
        console.log(`ndc(${nx.toFixed(2)},${ny.toFixed(2)}) MISS`);
      }
    }
  }
  await b.close();
})();
