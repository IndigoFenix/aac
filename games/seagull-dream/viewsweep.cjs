const puppeteer=require("puppeteer"),fs=require("fs"),path=require("path");
const port=process.argv[2]||"5185";
(async()=>{
  const outDir=path.join(__dirname,"caps-clouds");
  const b=await puppeteer.launch({headless:"new",args:["--no-sandbox","--use-gl=angle","--use-angle=swiftshader","--enable-unsafe-swiftshader","--ignore-gpu-blocklist"]});
  const p=await b.newPage();await p.setViewport({width:960,height:560});
  p.on("pageerror",e=>console.log("ERR",e.message));
  await p.goto(`http://localhost:${port}/cloud-lab.html`,{waitUntil:"networkidle0"});
  await p.waitForFunction(()=>typeof window.__labReady==="function",{timeout:20000});
  await p.evaluate(()=>window.__labGoto("fair-weather-ground"));
  await p.evaluate(()=>window.__labSetRenderer("blobs"));
  await p.waitForFunction(()=>window.__labReady(),{timeout:120000});
  for(const [altKm,pitch,tag] of [[9.0,16,"a90_up"],[9.71,16,"a971_up"],[10.5,16,"a105_up"],[9.71,-30,"a971_down"]]){
    await p.evaluate((a,pi)=>window.__labSetCam(a*1000,0,pi),altKm,pitch);
    await new Promise(z=>setTimeout(z,500));
    const st=JSON.parse(await p.evaluate(()=>window.__labStats()));
    await p.screenshot({path:path.join(outDir,`v_${tag}.png`)});
    console.log(tag, "sprites",st.sprites,"tiers",JSON.stringify(st.tierSprites));
  }
  await b.close();
})();
