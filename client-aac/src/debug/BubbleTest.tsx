// client-aac/src/debug/BubbleTest.tsx
//
// Standalone visual harness for the in-world speech-bubble glyph rendering.
// Served via bubble-test.html (a separate Vite entry, no auth/router), so it can
// be screenshotted headless to verify the rasterization + bubble draw pipeline.
//
// It exercises the REAL pipeline: glyphBubbleImageUrl (GlyphCompositor → SVG →
// data URL) + layoutBubble/paintBubble from the shared world engine, exactly as
// render2d does. Plus a diagnostics panel (data-URL length, decoded naturalWidth
// ×Height, computed aspect) and the raw rasterized <img> for each case.

import { useEffect, useRef, useState } from "react";
import { glyphBubbleImageUrl } from "@/lib/glyphRaster";
import { layoutBubble, paintBubble, imageAspect } from "@shared/world-engine/speech-bubble";

const CASES: Array<{ glyph: string; text: string; rtl?: boolean }> = [
  { glyph: "i_me+want+eat", text: "I want to eat" },
  { glyph: "i_me+want+go+home", text: "I want to go home" },
  { glyph: "go+here", text: "go here" },
  { glyph: "i_me+want+more+play", text: "I want more play" },
  { glyph: "i_me+want+eat", text: "אני רוצה לאכול", rtl: true },
];

interface Diag {
  glyph: string;
  urlLen: number;
  natW: number;
  natH: number;
  aspect: number;
  bmpW: number;
  bmpH: number;
  url: string | null;
}

// Replicate SocialWorldCanvas's WORKER-path fulfillGlyph: decode the SVG data URL
// via <img>, draw to a canvas, then createImageBitmap(canvas). This is the image
// TYPE (ImageBitmap) the 3D OffscreenCanvas renderer actually draws.
async function decodeToBitmap(url: string): Promise<ImageBitmap | null> {
  try {
    const img = new Image();
    img.decoding = "async";
    img.src = url;
    await img.decode();
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    if (!w || !h) return null;
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const c = canvas.getContext("2d");
    if (!c) return null;
    c.drawImage(img, 0, 0, w, h);
    return await createImageBitmap(canvas);
  } catch { return null; }
}

export default function BubbleTest() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [diags, setDiags] = useState<Diag[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const out: Diag[] = [];
      const images: Array<HTMLImageElement | null> = [];
      const bitmaps: Array<ImageBitmap | null> = [];
      for (const c of CASES) {
        // Force the document direction for the RTL case so glyphBubbleImageUrl
        // (which reads document.documentElement.dir) renders it right-to-left.
        document.documentElement.dir = c.rtl ? "rtl" : "ltr";
        const url = await glyphBubbleImageUrl(c.glyph);
        let img: HTMLImageElement | null = null;
        let natW = 0;
        let natH = 0;
        if (url) {
          img = new Image();
          img.src = url;
          try {
            await img.decode();
            natW = img.naturalWidth;
            natH = img.naturalHeight;
          } catch { /* decode failed */ }
        }
        const bmp = url ? await decodeToBitmap(url) : null;
        images.push(img);
        bitmaps.push(bmp);
        out.push({
          glyph: c.glyph,
          urlLen: url?.length ?? 0,
          natW,
          natH,
          aspect: img ? imageAspect(img) : 0,
          bmpW: bmp?.width ?? 0,
          bmpH: bmp?.height ?? 0,
          url,
        });
      }
      document.documentElement.dir = "ltr";
      if (cancelled) return;
      setDiags(out);

      // Paint each bubble onto the canvas exactly like render2d does.
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext("2d");
      if (!canvas || !ctx) return;
      ctx.fillStyle = "#7c9bd6";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      // Two bands: HTMLImageElement (render2d / main path) and ImageBitmap
      // (3D OffscreenCanvas worker path) — both must look identical.
      const draw = (sources: Array<CanvasImageSource | null>, label: string, bandY: number) => {
        ctx.fillStyle = "#11203a";
        ctx.font = "600 16px system-ui, sans-serif";
        ctx.textAlign = "left";
        ctx.textBaseline = "top";
        ctx.fillText(label, 20, bandY - 24);
        let x = 20;
        let rowMax = 0;
        let rowY = bandY;
        for (let i = 0; i < CASES.length; i++) {
          const c = CASES[i];
          const src = sources[i];
          const aspect = src ? imageAspect(src) : 0;
          const layout = layoutBubble(ctx, c.text, aspect);
          if (x + layout.width > canvas.width - 20) { x = 20; rowY += rowMax + 24; rowMax = 0; }
          ctx.save();
          ctx.translate(x, rowY);
          paintBubble(ctx, layout, src ? [src] : [], 1);
          ctx.restore();
          x += layout.width + 24;
          rowMax = Math.max(rowMax, layout.height);
        }
      };
      draw(images, "HTMLImageElement (render2d / main path)", 36);
      draw(bitmaps, "ImageBitmap (3D worker path)", 300);
    })();
    return () => { cancelled = true; };
  }, []);

  return (
    <div style={{ fontFamily: "system-ui, sans-serif", padding: 16 }}>
      <h2>Speech-bubble glyph render test</h2>
      <canvas
        ref={canvasRef}
        width={1100}
        height={620}
        style={{ border: "1px solid #333", display: "block", marginBottom: 16 }}
        data-testid="bubble-canvas"
      />
      <h3>Raw rasterized glyph images (direct &lt;img&gt;)</h3>
      <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginBottom: 16 }}>
        {diags.map((d, i) => (
          <div key={i} style={{ border: "1px solid #ccc", padding: 8, background: "#eef" }}>
            <div style={{ fontSize: 12, marginBottom: 4 }}>{d.glyph}</div>
            {d.url ? (
              <img src={d.url} alt={d.glyph} style={{ height: 80, background: "#fff" }} />
            ) : (
              <div style={{ color: "red" }}>NO URL</div>
            )}
          </div>
        ))}
      </div>
      <h3>Diagnostics</h3>
      <table style={{ borderCollapse: "collapse", fontSize: 13 }} data-testid="diag-table">
        <thead>
          <tr>
            {["glyph", "urlLen", "natW", "natH", "aspect", "bmpW", "bmpH"].map((h) => (
              <th key={h} style={{ border: "1px solid #999", padding: "2px 8px", textAlign: "left" }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {diags.map((d, i) => (
            <tr key={i} style={{ background: d.natW > 0 ? "#dfd" : "#fdd" }}>
              <td style={{ border: "1px solid #999", padding: "2px 8px" }}>{d.glyph}</td>
              <td style={{ border: "1px solid #999", padding: "2px 8px" }}>{d.urlLen}</td>
              <td style={{ border: "1px solid #999", padding: "2px 8px" }}>{d.natW}</td>
              <td style={{ border: "1px solid #999", padding: "2px 8px" }}>{d.natH}</td>
              <td style={{ border: "1px solid #999", padding: "2px 8px" }}>{d.aspect.toFixed(3)}</td>
              <td style={{ border: "1px solid #999", padding: "2px 8px" }}>{d.bmpW}</td>
              <td style={{ border: "1px solid #999", padding: "2px 8px" }}>{d.bmpH}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
