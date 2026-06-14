const puppeteer=require("puppeteer");
const port=process.argv[2]||"5185";
(async()=>{
  const b=await puppeteer.launch({headless:"new",args:["--no-sandbox","--use-gl=angle","--use-angle=swiftshader","--enable-unsafe-swiftshader","--ignore-gpu-blocklist"]});
  const p=await b.newPage();await p.setViewport({width:600,height:600});
  p.on("pageerror",e=>console.log("ERR",e.message));
  await p.goto(`http://localhost:${port}/cloud-lab.html`,{waitUntil:"networkidle0"});
  await p.waitForFunction(()=>typeof window.__labReady==="function",{timeout:20000});
  // Measure rendered cloud fraction TOP-DOWN at neutral sites, averaged.
  // Camera just above the layer, narrow FOV-ish by high pitch straight down.
  const cases=[["mars-wisps",0.18,21000],["fair-weather-ground",0.30,9000],["jupiter-close",0.85,90000]];
  for(const [s,cov,alt] of cases){
    await p.evaluate(n=>window.__labGoto(n),s);
    await p.evaluate(()=>window.__labSetRenderer("blobs"));
    await p.waitForFunction(()=>window.__labReady(),{timeout:120000});
    const sites=[[5,20],[ -10,80],[20,150],[-25,-60],[12,250],[30,300]];
    let sum=0;
    for(const [la,lo] of sites){
      await p.evaluate((la,lo)=>window.__labSetSite(la,lo),la,lo);
      await p.evaluate(a=>window.__labSetCam(a,0,-85),alt);
      await new Promise(z=>setTimeout(z,350));
      const f=await p.evaluate(()=>{
        const cv=document.createElement('canvas');cv.width=600;cv.height=600;
        const c=cv.getContext('2d');c.drawImage(document.querySelector('#lab-scene'),0,0,600,600);
        const d=c.getImageData(0,0,600,600).data;let cl=0,t=0;
        // central 360px box, avoid UI
        for(let y=120;y<480;y++)for(let x=120;x<480;x++){const i=(y*600+x)*4;
          const r=d[i],g=d[i+1],bl=d[i+2];t++; if(Math.min(r,g,bl)>150&&Math.abs(r-bl)<45) cl++;}
        return cl/t;
      });
      sum+=f;
    }
    console.log(`${s.padEnd(20)} cov=${cov}  rendered≈${(100*sum/sites.length).toFixed(0)}% (avg of ${sites.length} neutral sites, top-down)`);
  }
  await b.close();
})();
