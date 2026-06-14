// Headless screenshot harness for the cloud lab (cloud-lab.html).
// Usage:  node shot-clouds.cjs [scenario|scenario|... | all] [port]
// Output: caps-clouds/cloud_<scenario>.png
const puppeteer = require("puppeteer");
const fs = require("fs");
const path = require("path");

const ALL = [
  "fair-weather-ground", "broken-flight", "above-deck", "fog-stress",
  "stratus-underside", "deck-top", "crossfade-climb", "orbit",
  "orbit-terminator", "night-flight", "jupiter-disc", "jupiter-close",
  "venus-deck", "mars-wisps",
];

const arg = process.argv[2] || "all";
const port = process.argv[3] || "5184";
const targets = arg === "all" ? ALL : arg.split("|");

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

  for (const name of targets) {
    await p.evaluate((n) => window.__labGoto(n), name);
    await p.waitForFunction(() => window.__labReady(), { timeout: 120000 });
    await new Promise((r) => setTimeout(r, 300));
    const f = path.join(outDir, "cloud_" + name.replace(/[^a-z0-9]+/gi, "_") + ".png");
    await p.screenshot({ path: f });
    console.log("shot", f);
  }
  await b.close();
})();
