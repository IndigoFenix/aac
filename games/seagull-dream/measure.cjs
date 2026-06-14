const puppeteer=require("puppeteer"),fs=require("fs"),path=require("path");
const port=process.argv[2]||"5185";
(async()=>{
  const outDir=path.join(__dirname,"caps-clouds");
  const b=await puppeteer.launch({headless:"new",args:["--no-sandbox","--use-gl=angle","--use-angle=swiftshader","--enable-unsafe-swiftshader","--ignore-gpu-blocklist"]});
  const p=await b.newPage();await p.setViewport({width:800,height:500});
  p.on("pageerror",e=>console.log("ERR",e.message));
  await p.goto(`http://localhost:${port}/cloud-lab.html`,{waitUntil:"networkidle0"});
  await p.waitForFunction(()=>typeof window.__labReady==="function",{timeout:20000});
  // top-down just above each layer to read TRUE areal cloud fraction (no horizon pileup)
  const cases=[
    ["mars-wisps",0.18,22000,"mars_topdown"],
    ["fair-weather-ground",0.30,9000,"earth_topdown"],
    ["broken-flight",0.55,9000,"broken_topdown"], // same earth field, cov 0.55
  ];
  for(const [s,cov,alt,tag] of cases){
    await p.evaluate(n=>window.__labGoto(n),s);
    await p.evaluate(()=>window.__labSetRenderer("blobs"));
    await p.waitForFunction(()=>window.__labReady(),{timeout:120000});
    await p.evaluate(a=>window.__labSetCam(a,0,-90),alt);
    await new Promise(z=>setTimeout(z,800));
    await p.screenshot({path:path.join(outDir,`meas_${tag}.png`)});
    // count cloud (bright greyish) pixels, excluding the UI panel region (x<320,y<300)
    const frac=await p.evaluate(()=>{
      const cv=document.createElement('canvas');cv.width=800;cv.height=500;
      const c=cv.getContext('2d');c.drawImage(document.querySelector('#lab-scene'),0,0,800,500);
      const d=c.getImageData(0,0,800,500).data;let cloud=0,tot=0;
      for(let y=0;y<500;y++)for(let x=0;x<800;x++){ if(x<320&&y<300)continue; const i=(y*800+x)*4;
        const r=d[i],g=d[i+1],bl=d[i+2];tot++; if(Math.min(r,g,bl)>140) cloud++; }
      return cloud/tot;
    });
    console.log(`${tag.padEnd(16)} cov=${cov}  rendered cloud frac ≈ ${(frac*100).toFixed(0)}%`);
  }
  await b.close();
})();
