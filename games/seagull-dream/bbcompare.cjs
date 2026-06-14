const puppeteer=require("puppeteer"),fs=require("fs"),path=require("path");
const port=process.argv[2]||"5185";
(async()=>{
  const outDir=path.join(__dirname,"caps-clouds");
  const b=await puppeteer.launch({headless:"new",args:["--no-sandbox","--use-gl=angle","--use-angle=swiftshader","--enable-unsafe-swiftshader","--ignore-gpu-blocklist"]});
  const p=await b.newPage();await p.setViewport({width:960,height:560});
  p.on("pageerror",e=>console.log("ERR",e.message));
  await p.goto(`http://localhost:${port}/cloud-lab.html`,{waitUntil:"networkidle0"});
  await p.waitForFunction(()=>typeof window.__labReady==="function",{timeout:20000});
  const scenes=["above-deck","crossfade-climb","fair-weather-ground","stratus-underside"];
  for(const r of ["blob-billboard"]){
    for(const s of scenes){
      await p.evaluate(n=>window.__labGoto(n),s);
      await p.evaluate(m=>window.__labSetRenderer(m),r);
      await p.waitForFunction(()=>window.__labReady(),{timeout:120000});
      await new Promise(z=>setTimeout(z,500));
      const st=JSON.parse(await p.evaluate(()=>window.__labStats()));
      await p.screenshot({path:path.join(outDir,`bb_${s}.png`)});
      console.log(`bb_${s}`,"sprites",st.sprites,"walk",st.walkMs+"ms");
    }
  }
  await b.close();
})();
