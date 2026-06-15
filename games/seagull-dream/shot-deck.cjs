// Deck heightmap capture across the distance ladder (v3 Phase 1).
// Usage: node shot-deck.cjs [port]
const puppeteer = require("puppeteer");
const fs = require("fs");
const path = require("path");

const SCENES = ["fair-weather-ground", "above-deck", "crossfade-climb", "orbit", "stratus-underside"];
const port = process.argv[2] || "5185";

(async () => {
  const outDir = path.join(__dirname, "caps-clouds");
  fs.mkdirSync(outDir, { recursive: true });
  const b = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--use-gl=angle", "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
  });
  const p = await b.newPage();
  await p.setViewport({ width: 960, height: 560, deviceScaleFactor: 1 });
  p.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
  p.on("console", (m) => { if (m.type() === "error") console.log("CONSOLE:", m.text()); });
  await p.goto(`http://localhost:${port}/cloud-lab.html`, { waitUntil: "networkidle0" });
  await p.waitForFunction(() => typeof window.__labReady === "function", { timeout: 20000 });

  const renderer = process.argv[3] || "deck";
  await p.evaluate((r) => window.__labSetRenderer(r), renderer);
  for (const name of SCENES) {
    await p.evaluate((n) => window.__labGoto(n), name);
    await p.evaluate((r) => window.__labSetRenderer(r), renderer);
    await p.waitForFunction(() => window.__labReady(), { timeout: 120000 });
    await new Promise((r) => setTimeout(r, 600));
    const stats = await p.evaluate(() => window.__labStats());
    const f = path.join(outDir, `deck_${name.replace(/[^a-z0-9]+/gi, "_")}.png`);
    await p.screenshot({ path: f });
    console.log("shot", path.basename(f), JSON.stringify(stats));
  }
  await b.close();
})();
