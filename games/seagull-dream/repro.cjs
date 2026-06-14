const puppeteer = require("puppeteer");
const fs = require("fs"); const path = require("path");
const port = process.argv[2] || "5185";
const CASES = [
  ["stratus-underside", 26050, 0, -90, "c1_strat_26km"],
  ["stratus-underside", 20770, 0, -90, "c1_strat_20km"],
  ["fair-weather-ground", 470, -60, 18, "c2_fair_0_47km"],
  ["fair-weather-ground", 660, -60, 18, "c2_fair_0_66km"],
];
(async () => {
  const outDir = path.join(__dirname, "caps-clouds"); fs.mkdirSync(outDir, {recursive:true});
  const b = await puppeteer.launch({ headless:"new",
    args:["--no-sandbox","--use-gl=angle","--use-angle=swiftshader","--enable-unsafe-swiftshader","--ignore-gpu-blocklist"] });
  const p = await b.newPage(); await p.setViewport({width:960,height:560});
  p.on("pageerror",e=>console.log("ERR",e.message));
  await p.goto(`http://localhost:${port}/cloud-lab.html`,{waitUntil:"networkidle0"});
  await p.waitForFunction(()=>typeof window.__labReady==="function",{timeout:20000});
  let lastScene=null;
  for (const [scene,alt,yaw,pitch,tag] of CASES) {
    if (scene!==lastScene){ await p.evaluate(n=>window.__labGoto(n),scene);
      await p.evaluate(()=>window.__labSetRenderer("blobs"));
      await p.waitForFunction(()=>window.__labReady(),{timeout:120000}); lastScene=scene; }
    await p.evaluate((a,y,pi)=>window.__labSetCam(a,y,pi),alt,yaw,pitch);
    await new Promise(z=>setTimeout(z,500));
    const stats = await p.evaluate(()=>window.__labStats());
    const f = path.join(outDir,`repro_${tag}.png`); await p.screenshot({path:f});
    console.log(tag, stats);
  }
  await b.close();
})();
