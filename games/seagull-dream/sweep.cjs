const puppeteer=require("puppeteer");
const port=process.argv[2]||"5185";
(async()=>{
  const b=await puppeteer.launch({headless:"new",args:["--no-sandbox","--use-gl=angle","--use-angle=swiftshader","--enable-unsafe-swiftshader","--ignore-gpu-blocklist"]});
  const p=await b.newPage();await p.setViewport({width:640,height:360});
  p.on("pageerror",e=>console.log("ERR",e.message));
  await p.goto(`http://localhost:${port}/cloud-lab.html`,{waitUntil:"networkidle0"});
  await p.waitForFunction(()=>typeof window.__labReady==="function",{timeout:20000});
  await p.evaluate(()=>window.__labGoto("fair-weather-ground"));
  await p.evaluate(()=>window.__labSetRenderer("blobs"));
  await p.waitForFunction(()=>window.__labReady(),{timeout:120000});
  // sweep altitude looking straight down at the deck
  for(const altKm of [7,8,9,9.3,9.5,9.71,9.9,10,10.5,11,12]){
    await p.evaluate(a=>window.__labSetCam(a*1000, 0, -90), altKm);
    await new Promise(z=>setTimeout(z,400));
    const st=JSON.parse(await p.evaluate(()=>window.__labStats()));
    console.log(`alt ${String(altKm).padStart(5)}km  sprites ${String(st.sprites).padStart(5)}  tiers [${st.tierSprites}]  iter ${st.cellsIterated}`);
  }
  await b.close();
})();
