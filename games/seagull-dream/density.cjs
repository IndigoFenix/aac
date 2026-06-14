const puppeteer=require("puppeteer"),fs=require("fs"),path=require("path");
const port=process.argv[2]||"5185";
(async()=>{
  const outDir=path.join(__dirname,"caps-clouds");
  const b=await puppeteer.launch({headless:"new",args:["--no-sandbox","--use-gl=angle","--use-angle=swiftshader","--enable-unsafe-swiftshader","--ignore-gpu-blocklist"]});
  const p=await b.newPage();await p.setViewport({width:960,height:560});
  p.on("pageerror",e=>console.log("ERR",e.message));
  await p.goto(`http://localhost:${port}/cloud-lab.html`,{waitUntil:"networkidle0"});
  await p.waitForFunction(()=>typeof window.__labReady==="function",{timeout:20000});
  const cases=[
    ["mars-wisps",4000,12,"mars_default"],
    ["mars-wisps",800000,-75,"mars_orbit"],
    ["fair-weather-ground",600000,-75,"earth_orbit"],
  ];
  for(const [s,alt,pitch,tag] of cases){
    await p.evaluate(n=>window.__labGoto(n),s);
    await p.evaluate(()=>window.__labSetRenderer("blobs"));
    await p.waitForFunction(()=>window.__labReady(),{timeout:120000});
    await p.evaluate((a,pi)=>window.__labSetCam(a,0,pi),alt,pitch);
    await new Promise(z=>setTimeout(z,800));
    await p.screenshot({path:path.join(outDir,`d_${tag}.png`)});
    const st=JSON.parse(await p.evaluate(()=>window.__labStats()));
    console.log(tag,"alt",(alt/1000)+"km sprites",st.sprites);
  }
  await b.close();
})();
