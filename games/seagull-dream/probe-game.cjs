const puppeteer = require("puppeteer");
const path = require("path");
(async () => {
  const b = await puppeteer.launch({ headless: "new", args: ["--no-sandbox", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
  const p = await b.newPage();
  await p.setViewport({ width: 960, height: 560 });
  p.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
  await p.goto("http://localhost:5185/", { waitUntil: "networkidle0", timeout: 60000 });
  await new Promise((r) => setTimeout(r, 25000));
  await p.screenshot({ path: path.join(__dirname, "caps-clouds", "game_fixed_a.png") });
  // pan the view: walk-mode steering follows the mouse; sweep right then left
  await p.mouse.move(900, 250);
  await new Promise((r) => setTimeout(r, 6000));
  await p.screenshot({ path: path.join(__dirname, "caps-clouds", "game_fixed_b.png") });
  await p.mouse.move(60, 250);
  await new Promise((r) => setTimeout(r, 9000));
  await p.screenshot({ path: path.join(__dirname, "caps-clouds", "game_fixed_c.png") });
  console.log("done");
  await b.close();
})();
