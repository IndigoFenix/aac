// Sandbox Game — map view for the entity/relationship WORLD (Step 3).
//
// Renders cities at their positions (size = population, fill = goods) and the
// relationships between them (line width = road strength, red tint = hostility).
// A per-frame rAF loop reads the live EntityWorld; the simulation is ticked by
// useWorld. Click a city for a goods boom, or near a route to stir up hostility.

import { useEffect, useRef } from 'react';
import type { EntityWorld } from '@shared/engine/cells';
import { injectEntity, injectEdge } from '@shared/engine/cells';

interface Props {
  getWorld: () => EntityWorld;
}

const PAD = 28; // px inset so big city circles aren't clipped

function lerp(a: number, b: number, t: number) { return a + (b - a) * Math.max(0, Math.min(1, t)); }

export default function WorldMap({ getWorld }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const lastClick = useRef(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const toPx = (w: EntityWorld, i: number, W: number, H: number): [number, number] =>
      [PAD + w.pos[2 * i] * (W - 2 * PAD), PAD + w.pos[2 * i + 1] * (H - 2 * PAD)];

    let raf = 0;
    const frame = () => {
      raf = requestAnimationFrame(frame);
      const w = getWorld();
      const rect = canvas.getBoundingClientRect();
      const W = Math.max(1, Math.round(rect.width)), H = Math.max(1, Math.round(rect.height));
      if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
      ctx.clearRect(0, 0, W, H);
      ctx.fillStyle = '#0b1220';
      ctx.fillRect(0, 0, W, H);

      const pop = w.scalars.population, goods = w.scalars.goods;
      const road = w.edgeAttr.road, host = w.edgeAttr.hostility;

      // Relationships: road width + hostility tint.
      for (let e = 0; e < w.edges.length; e++) {
        const { a, b } = w.edges[e];
        const [ax, ay] = toPx(w, a, W, H), [bx, by] = toPx(w, b, W, H);
        const r = road ? road[e] : 0.3;
        const h = host ? host[e] : 0;
        ctx.lineWidth = 1 + r * 7;
        ctx.strokeStyle = `rgb(${Math.round(lerp(120, 230, h))},${Math.round(lerp(110, 60, h))},${Math.round(lerp(90, 55, h))})`;
        ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
      }

      // Cities: radius = population, fill = goods.
      for (let i = 0; i < w.n; i++) {
        const [x, y] = toPx(w, i, W, H);
        const rad = 5 + (pop ? pop[i] : 0) / 100 * 18;
        const g = goods ? goods[i] / 100 : 0;
        ctx.beginPath(); ctx.arc(x, y, rad, 0, Math.PI * 2);
        ctx.fillStyle = `rgb(${Math.round(lerp(90, 250, g))},${Math.round(lerp(150, 210, g))},${Math.round(lerp(110, 90, g))})`;
        ctx.fill();
        ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.stroke();
        if (w.scalars.production && w.scalars.production[i] > 1) { // mark producers
          ctx.fillStyle = 'rgba(255,255,255,0.9)'; ctx.font = '11px sans-serif'; ctx.textAlign = 'center';
          ctx.fillText('★', x, y + 4);
        }
      }
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [getWorld]);

  // Click a city → goods boom; click near a route midpoint → raise hostility.
  const onClick = (ev: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current; if (!canvas) return;
    const now = Date.now(); if (now - lastClick.current < 120) return; lastClick.current = now;
    const w = getWorld();
    const rect = canvas.getBoundingClientRect();
    const W = rect.width, H = rect.height;
    const px = ev.clientX - rect.left, py = ev.clientY - rect.top;
    const at = (i: number): [number, number] => [PAD + w.pos[2 * i] * (W - 2 * PAD), PAD + w.pos[2 * i + 1] * (H - 2 * PAD)];
    // Nearest city.
    let best = -1, bd = Infinity;
    for (let i = 0; i < w.n; i++) { const [x, y] = at(i); const d = Math.hypot(x - px, y - py); if (d < bd) { bd = d; best = i; } }
    if (best >= 0 && bd < 26) { injectEntity(w, best, 'goods', 40); return; }
    // Otherwise nearest edge midpoint → stir hostility.
    let be = -1, bed = Infinity;
    for (let e = 0; e < w.edges.length; e++) { const [ax, ay] = at(w.edges[e].a), [bx, by] = at(w.edges[e].b); const d = Math.hypot((ax + bx) / 2 - px, (ay + by) / 2 - py); if (d < bed) { bed = d; be = e; } }
    if (be >= 0 && bed < 40) injectEdge(w, be, 'hostility', 0.8);
  };

  return (
    <canvas
      ref={canvasRef}
      onClick={onClick}
      title="Click a city for a goods boom, or a route to stir up hostility"
      className="w-full h-full cursor-pointer rounded-lg"
    />
  );
}
