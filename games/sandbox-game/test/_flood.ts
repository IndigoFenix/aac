import { createGrid, worldStep, pendingCount, terrain, injectTile } from '../src/cell-systems/index.ts';
function scen(label:string, wrap:boolean, steep:boolean){
  const g=createGrid(terrain,32,32,wrap);
  if(steep){for(let y=0;y<32;y++)for(let x=0;x<32;x++){const d=Math.hypot(x-16,y-16);if(d<8)g.fields.height[y*32+x]=14+(26-14)*(1-d/8);} for(let i=0;i<1024;i++)injectTile(g,i,'height',0);}
  let peakH=-1,pi=0;for(let i=0;i<1024;i++)if(g.fields.height[i]>peakH){peakH=g.fields.height[i];pi=i;}
  let rest=-1;for(let n=0;n<4000;n++){worldStep(g);if(pendingCount(g)===0){rest=n;break;}}
  let mx=-Infinity,wet=0,green=0;for(let i=0;i<1024;i++){const w=g.fields.water[i];mx=Math.max(mx,w);if(w>0.05)wet++;if(g.fields.plant[i]>0.05)green++;}
  console.log(`${label}: rest@${rest} wmax ${mx.toFixed(1)} wet ${(wet/10.24).toFixed(0)}% green ${green} | peakW ${g.fields.water[pi].toFixed(2)} (h${peakH.toFixed(0)})`);
}
scen('def bnd', false,false); scen('def tor', true,false); scen('stp bnd', false,true ); scen('stp tor', true,true );
