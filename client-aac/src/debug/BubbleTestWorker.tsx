// client-aac/src/debug/BubbleTestWorker.tsx
//
// Drives the REAL worker render path end-to-end: WorldRenderClient →
// transferControlToOffscreen → world-render.worker (render3d inside the worker) →
// glyph requested over the protocol → fulfillGlyph (our SVG raster) → ImageBitmap
// transferred in → drawn into the OffscreenCanvas texture. This is exactly what
// the game does; the other harnesses bypass the worker.

import { useEffect, useRef, useState } from "react";
import { WorldRenderClient, supportsOffscreenRender } from "@shared/social-world/world-render-client";
import { socialFieldSpec } from "@shared/world-engine/specs/social-field";
import { glyphBubbleImageUrl } from "@/lib/glyphRaster";

export default function BubbleTestWorker() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [status, setStatus] = useState("starting…");

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (!supportsOffscreenRender()) { setStatus("OffscreenCanvas NOT supported here"); return; }

    let fulfillCalls = 0;
    let lastBitmap = "";
    // Exactly SocialWorldCanvas's worker-path fulfillGlyph.
    const fulfillGlyph = async (glyph: string): Promise<ImageBitmap[]> => {
      fulfillCalls++;
      const url = await glyphBubbleImageUrl(glyph);
      if (!url) { setStatus(`fulfill #${fulfillCalls}: NO URL`); return []; }
      try {
        const img = new Image();
        img.decoding = "async";
        img.src = url;
        await img.decode();
        const w = img.naturalWidth || img.width;
        const h = img.naturalHeight || img.height;
        if (!w || !h) { setStatus(`fulfill #${fulfillCalls}: naturalWidth=0`); return []; }
        const c2 = document.createElement("canvas");
        c2.width = w; c2.height = h;
        const cx = c2.getContext("2d")!;
        cx.drawImage(img, 0, 0, w, h);
        const bmp = await createImageBitmap(c2);
        lastBitmap = `${bmp.width}x${bmp.height}`;
        setStatus(`fulfill #${fulfillCalls}: bitmap ${lastBitmap} (url len ${url.length})`);
        return [bmp];
      } catch (e) {
        setStatus(`fulfill #${fulfillCalls}: ERROR ${String(e)}`);
        return [];
      }
    };

    const client = new WorldRenderClient({
      canvas,
      worldSpec: socialFieldSpec,
      localId: "me",
      renderer: "3d",
      spawnIndex: 0,
      fulfillFace: async () => ({ bitmap: null, label: "Me" }),
      fulfillGlyph,
      initialSize: { width: 900, height: 600, dpr: 1 },
      onFallback: (reason) => setStatus("WORKER FALLBACK → main: " + reason),
    });

    // Say after a beat so the worker has initialised.
    const t = setTimeout(() => client.say("I want to go home", "i_me+want+go+home"), 400);

    return () => { clearTimeout(t); client.dispose(); };
  }, []);

  return (
    <div style={{ fontFamily: "system-ui, sans-serif", padding: 16 }}>
      <h2>Worker render-path bubble test (the real game path)</h2>
      <div data-testid="status" style={{ marginBottom: 8, fontSize: 13 }}>{status}</div>
      <canvas
        ref={canvasRef}
        width={900}
        height={600}
        style={{ border: "1px solid #333", display: "block" }}
        data-testid="canvas-worker"
      />
    </div>
  );
}
