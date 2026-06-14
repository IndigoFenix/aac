const puppeteer=require("puppeteer"),fs=require("fs"),path=require("path");
const port=process.argv[2]||"5185";
function cloudPixels(data){ // count near-white-ish pixels over blue sky/deck
  let c=0; for(let i=0;i<data.length;i+=4){const r=data[i],g=data[i+1],bl=data[i+2];
    if(r>200&&g>200&&bl>200) c++;} return c;}
(async()=>{
  const outDir=path.join(__dirname,"caps-clouds");
  const b=await puppeteer.launch({headless:"new",args:["--no-sandbox","--use-gl=angle","--use-angle=swiftshader","--enable-unsafe-swiftshader","--ignore-gpu-blocklist"]});
  const p=await b.newPage();await p.setViewport({width:480,height:270});
  p.on("pageerror",e=>console.log("ERR",e.message));
  await p.goto(`http://localhost:${port}/cloud-lab.html`,{waitUntil:"networkidle0"});
  await p.waitForFunction(()=>typeof window.__labReady==="function",{timeout:20000});
  await p.evaluate(()=>window.__labGoto("fair-weather-ground"));
  await p.evaluate(()=>window.__labSetRenderer("blobs"));
  await p.waitForFunction(()=>window.__labReady(),{timeout:120000});
  // settle at 9.0 down
  await p.evaluate(()=>window.__labSetCam(9000,0,-40));
  await new Promise(z=>setTimeout(z,600));
  let s=await p.screenshot({encoding:"binary"}); // settled baseline
  fs.writeFileSync(path.join(outDir,"m_settled.png"),s);
  // now simulate continuous fast wheel: repeated big alt jumps, screenshot tight
  for(let i=0;i<6;i++){ await p.evaluate(a=>window.__labSetCam(a,0,-40), 9000+ (i+1)*1100); await new Promise(z=>setTimeout(z,16)); }
  // capture right after the last jump (band still ballooned from continuous motion)
  await p.evaluate(a=>window.__labSetCam(a,0,-40), 9000+7*1100);
  await new Promise(z=>setTimeout(z,16));
  s=await p.screenshot({encoding:"binary"});
  fs.writeFileSync(path.join(outDir,"m_moving.png"),s);
  console.log("captured m_settled.png and m_moving.png");
  await b.close();
})();
