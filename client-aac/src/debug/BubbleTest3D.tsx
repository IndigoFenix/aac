// client-aac/src/debug/BubbleTest3D.tsx
//
// Drives the REAL 3D world renderer (createWorld3DView → Bubble3D billboard) with
// one avatar that has a glyph `say`, so we can screenshot the actual in-world
// speech bubble — the path the game uses, which the 2D harness doesn't cover.

import { useEffect, useRef, useState } from "react";
import { createWorld3DView } from "@shared/world-engine/render3d";
import { createWorldState, setAvatarSpeech } from "@shared/world-engine";
import { socialFieldSpec } from "@shared/world-engine/specs/social-field";
import { glyphBubbleImageUrl } from "@/lib/glyphRaster";

async function decodeToBitmap(url: string): Promise<ImageBitmap | null> {
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    if (!w || !h) return null;
    const canvas = document.createElement("canvas");
    canvas.width = w; canvas.height = h;
    const c = canvas.getContext("2d")!;
    c.drawImage(img, 0, 0, w, h);
    return await createImageBitmap(canvas);
  } catch { return null; }
}

export default function BubbleTest3D() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [status, setStatus] = useState("starting…");

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let raf = 0;
    let disposed = false;
    let view: ReturnType<typeof createWorld3DView> | null = null;

    (async () => {
      const GLYPH = "i_me+want+go+home";
      const url = await glyphBubbleImageUrl(GLYPH);
      const bmp = url ? await decodeToBitmap(url) : null;
      setStatus(`glyph url len=${url?.length ?? 0}, bitmap=${bmp ? bmp.width + "x" + bmp.height : "NULL"}`);

      const glyphFor = (_g: string): CanvasImageSource[] | null => (bmp ? [bmp] : null);
      const faceFor = () => null;
      const labelFor = () => "Me";

      view = createWorld3DView(
        { canvas, localId: "me", faceFor, labelFor, glyphFor },
        socialFieldSpec,
      );
      view.resize(900, 600, 1);

      const state = createWorldState(socialFieldSpec, "me", 0);
      setAvatarSpeech(state, "me", { text: "I want to go home", glyph: GLYPH });

      let last = performance.now();
      const loop = () => {
        if (disposed || !view) return;
        const now = performance.now();
        const dt = Math.min(0.05, (now - last) / 1000);
        last = now;
        // Keep the bubble fresh: hold sim time within the bubble TTL window.
        state.time = 1.0;
        state.avatars.me.say!.at = 0.5;
        view.render(state, dt);
        raf = requestAnimationFrame(loop);
      };
      loop();
    })();

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      view?.dispose();
    };
  }, []);

  return (
    <div style={{ fontFamily: "system-ui, sans-serif", padding: 16 }}>
      <h2>3D speech-bubble billboard test</h2>
      <div data-testid="status" style={{ marginBottom: 8, fontSize: 13 }}>{status}</div>
      <canvas
        ref={canvasRef}
        width={900}
        height={600}
        style={{ border: "1px solid #333", display: "block" }}
        data-testid="canvas3d"
      />
    </div>
  );
}
