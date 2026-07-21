// games/world-lab/src/hdr-probe.ts
//
// EXACT MAX-RADIANCE PROBE for the star-flash hunt.
//
// The flash is a soft blooming circle, and that shape is itself evidence: a
// single blown-out texel pushed through UnrealBloomPass's mip pyramid renders
// as exactly that — a star's glow with no star at its centre. So the question
// is not "what is drawing a big disc" but "what one texel went enormous".
//
// Finding that texel needs an EXACT maximum, not a sampled one — a 4×4 tap
// downsample would step straight over a single hot pixel. So this does a proper
// power-of-two max-reduction: halve the image repeatedly, each step taking the
// max of an exact 2×2 block, until one texel remains. That texel carries the
// largest radiance in the frame AND the uv it came from, so a flagged frame can
// say not just "something overflowed" but "at (0.31, 0.72)".
//
// It runs as a Pass with `needsSwap = false` that never writes to the
// composer's buffers — it only reads. The rendered image is bit-identical with
// the probe in or out, which matters: a diagnostic that perturbs the pipeline
// cannot be trusted to have observed the original bug.
//
// Placed AFTER RenderPass and BEFORE the sanitize pass, so it sees raw scene
// radiance — including the Inf that the sanitize pass is about to clamp to
// HDR_CLAMP and hand to the bloom pyramid.

import * as THREE from "three";
import { Pass, FullScreenQuad } from "three/examples/jsm/postprocessing/Pass.js";

/** Half-float saturates above this — anything at or past it is already Inf by
 *  the time it lands in the composer's HalfFloat target. */
export const HALF_MAX = 65504;

export interface HdrPeak {
  /** Largest single channel value in the frame (may be Infinity). */
  value: number;
  /** Where it was, in uv (0-1, origin bottom-left). */
  u: number;
  v: number;
  /** True if any texel in the frame was NaN or at half-float saturation. */
  bad: boolean;
  /** Full linear RGB at the peak texel, read back only when the peak is
   *  interesting (see RGB_READ_ABOVE). The HUE is the evidence: a warm-white
   *  spike is the star's specular, a saturated primary is something else. */
  rgb: [number, number, number] | null;
}

/** Only pay for the second readback when the peak is worth explaining. The
 *  scene idles around 1.5-3.5, so this never fires on a normal frame. */
const RGB_READ_ABOVE = 50;

const SEED_FRAG = /* glsl */ `
  uniform sampler2D tSrc;
  varying vec2 vUv;
  void main() {
    vec3 c = texture2D(tSrc, vUv).rgb;
    float m = max(max(c.r, c.g), c.b);
    // NaN fails self-comparison. Give it a value that wins every max so it
    // cannot be hidden by a brighter neighbour, and flag it.
    bool isNan = !(m == m);
    float flag = (isNan || m >= ${HALF_MAX}.0) ? 1.0 : 0.0;
    gl_FragColor = vec4(isNan ? 1.0 / 0.0 : m, vUv.x, vUv.y, flag);
  }`;

const REDUCE_FRAG = /* glsl */ `
  uniform sampler2D tSrc;
  uniform vec2 tTexel;
  varying vec2 vUv;
  void main() {
    // Exact 2x2 max — no tap can be skipped, so a lone hot texel survives
    // every level of the reduction down to the final 1x1.
    vec4 a = texture2D(tSrc, vUv + tTexel * vec2(-0.5, -0.5));
    vec4 b = texture2D(tSrc, vUv + tTexel * vec2( 0.5, -0.5));
    vec4 c = texture2D(tSrc, vUv + tTexel * vec2(-0.5,  0.5));
    vec4 d = texture2D(tSrc, vUv + tTexel * vec2( 0.5,  0.5));
    vec4 best = a;
    if (b.r > best.r) best = b;
    if (c.r > best.r) best = c;
    if (d.r > best.r) best = d;
    // The flag is a frame-wide OR — a NaN anywhere must be reported even if
    // some other texel carries the larger magnitude.
    best.a = max(max(a.a, b.a), max(c.a, d.a));
    gl_FragColor = best;
  }`;

const COPY_FRAG = /* glsl */ `
  uniform sampler2D tSrc;
  varying vec2 vUv;
  void main() { gl_FragColor = texture2D(tSrc, vUv); }`;

const VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`;

export class HdrProbePass extends Pass {
  private seedMat: THREE.ShaderMaterial;
  private reduceMat: THREE.ShaderMaterial;
  private copyMat: THREE.ShaderMaterial;
  private quad: FullScreenQuad;
  private chain: THREE.WebGLRenderTarget[] = [];
  /** Full-res non-multisampled FloatType copy of the raw scene. The composer's
   *  own buffers are multisampled, and reading pixels back from a multisampled
   *  target is unreliable — so the peak texel's RGB is sampled from here. */
  private rgbCopy: THREE.WebGLRenderTarget | null = null;
  private chainW = 0;
  private chainH = 0;
  private readBuf = new Float32Array(4);
  private rgbBuf = new Float32Array(4);
  /** Set false to skip the whole probe (it costs a readback stall per frame). */
  public active = true;
  /** Last frame's peak, or null if the probe has not run. */
  public peak: HdrPeak | null = null;

  constructor() {
    super();
    // Read-only: never writes the composer's buffers, so the presented image is
    // identical with the probe present or absent.
    this.needsSwap = false;
    this.seedMat = new THREE.ShaderMaterial({
      uniforms: { tSrc: { value: null } },
      vertexShader: VERT, fragmentShader: SEED_FRAG,
      depthTest: false, depthWrite: false,
    });
    this.reduceMat = new THREE.ShaderMaterial({
      uniforms: { tSrc: { value: null }, tTexel: { value: new THREE.Vector2() } },
      vertexShader: VERT, fragmentShader: REDUCE_FRAG,
      depthTest: false, depthWrite: false,
    });
    this.copyMat = new THREE.ShaderMaterial({
      uniforms: { tSrc: { value: null } },
      vertexShader: VERT, fragmentShader: COPY_FRAG,
      depthTest: false, depthWrite: false,
    });
    this.quad = new FullScreenQuad(this.seedMat);
  }

  private buildChain(w: number, h: number): void {
    for (const rt of this.chain) rt.dispose();
    this.chain = [];
    let cw = w, ch = h;
    // FloatType, not HalfFloat: the whole point is to observe values that
    // OVERFLOW half-float, so the probe must not saturate where the thing it
    // is measuring saturates. Nearest filtering keeps the max exact.
    const make = (x: number, y: number) => new THREE.WebGLRenderTarget(x, y, {
      type: THREE.FloatType, format: THREE.RGBAFormat,
      minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
      depthBuffer: false, stencilBuffer: false,
    });
    this.chain.push(make(cw, ch));
    while (cw > 1 || ch > 1) {
      cw = Math.max(1, Math.ceil(cw / 2));
      ch = Math.max(1, Math.ceil(ch / 2));
      this.chain.push(make(cw, ch));
    }
    this.rgbCopy?.dispose();
    this.rgbCopy = make(w, h);
    this.chainW = w;
    this.chainH = h;
  }

  render(
    renderer: THREE.WebGLRenderer,
    _writeBuffer: THREE.WebGLRenderTarget,
    readBuffer: THREE.WebGLRenderTarget,
  ): void {
    if (!this.active) return;
    const w = readBuffer.width, h = readBuffer.height;
    if (!w || !h) return;
    if (w !== this.chainW || h !== this.chainH) this.buildChain(w, h);

    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    renderer.autoClear = false;

    // Keep a readable full-res copy of the raw radiance, so the peak texel's
    // actual RGB can be sampled once we know where it is.
    this.copyMat.uniforms.tSrc.value = readBuffer.texture;
    this.quad.material = this.copyMat;
    renderer.setRenderTarget(this.rgbCopy!);
    this.quad.render(renderer);

    // Seed: raw radiance → (maxChannel, u, v, badFlag).
    this.seedMat.uniforms.tSrc.value = readBuffer.texture;
    this.quad.material = this.seedMat;
    renderer.setRenderTarget(this.chain[0]!);
    this.quad.render(renderer);

    // Halve to 1x1, exact 2x2 max at every level.
    this.quad.material = this.reduceMat;
    for (let i = 1; i < this.chain.length; i++) {
      const src = this.chain[i - 1]!;
      this.reduceMat.uniforms.tSrc.value = src.texture;
      (this.reduceMat.uniforms.tTexel.value as THREE.Vector2)
        .set(1 / src.width, 1 / src.height);
      renderer.setRenderTarget(this.chain[i]!);
      this.quad.render(renderer);
    }

    const last = this.chain[this.chain.length - 1]!;
    try {
      renderer.readRenderTargetPixels(last, 0, 0, 1, 1, this.readBuf);
      const value = this.readBuf[0]!;
      const u = this.readBuf[1]!;
      const v = this.readBuf[2]!;
      let rgb: [number, number, number] | null = null;
      if ((!Number.isFinite(value) || value > RGB_READ_ABOVE) && this.rgbCopy) {
        // FLOOR, not round. The carried uv is a texel CENTRE, (i + 0.5) / w, so
        // `u * w` is exactly `i + 0.5` and Math.round takes it to i + 1 — one
        // texel to the right of the peak. For a firefly that is a SINGLE texel
        // that reads a normal neighbour, which is why the first captures
        // reported peaks in the thousands alongside an RGB under 1.3.
        const px = Math.min(w - 1, Math.max(0, Math.floor(u * w)));
        const py = Math.min(h - 1, Math.max(0, Math.floor(v * h)));
        renderer.readRenderTargetPixels(this.rgbCopy, px, py, 1, 1, this.rgbBuf);
        rgb = [this.rgbBuf[0]!, this.rgbBuf[1]!, this.rgbBuf[2]!];
      }
      this.peak = { value, u, v, bad: this.readBuf[3]! > 0.5, rgb };
    } catch {
      this.peak = null;
    }

    renderer.setRenderTarget(prevTarget);
    renderer.autoClear = prevAutoClear;
  }

  /** Read the RAW pre-bloom scene back as viewable PNGs.
   *
   *  The frame the watcher saves is the FINAL composite, where the bloom has
   *  smeared the spike into a soft disc that hides its own source. This is the
   *  image BEFORE the bloom pyramid, so the culprit appears at its true size
   *  and shape — one texel, a sliver, a whole triangle, a sphere — which is the
   *  difference between "something is bright" and knowing what drew it.
   *
   *  Log-mapped, not linear: the frame spans ~1.5 background to ~1e4 spike, and
   *  a linear map would show nothing but a white dot on black.
   *
   *  Returns a full view and a 64px crop centred on the peak. EXPENSIVE (a
   *  full-res float readback) — flagged frames only. */
  captureRaw(renderer: THREE.WebGLRenderer, peakU: number, peakV: number): {
    full: string; crop: string;
  } | null {
    const rt = this.rgbCopy;
    if (!rt) return null;
    const w = rt.width, h = rt.height;
    const buf = new Float32Array(w * h * 4);
    try {
      renderer.readRenderTargetPixels(rt, 0, 0, w, h, buf);
    } catch {
      return null;
    }

    const toneMap = (x: number): number => {
      if (!Number.isFinite(x)) return 255;
      // log1p over a decade range, so 1.5 and 16000 are both legible.
      return Math.max(0, Math.min(255, (Math.log1p(Math.max(0, x)) / Math.log1p(2e4)) * 255));
    };

    const draw = (
      sx: number, sy: number, sw: number, sh: number, scale: number,
    ): string => {
      const c = document.createElement("canvas");
      c.width = sw * scale; c.height = sh * scale;
      const ctx = c.getContext("2d")!;
      const img = ctx.createImageData(sw, sh);
      for (let y = 0; y < sh; y++) {
        for (let x = 0; x < sw; x++) {
          // Source is bottom-up (GL); ImageData is top-down.
          const si = ((sy + y) * w + (sx + x)) * 4;
          const di = ((sh - 1 - y) * sw + x) * 4;
          img.data[di] = toneMap(buf[si]!);
          img.data[di + 1] = toneMap(buf[si + 1]!);
          img.data[di + 2] = toneMap(buf[si + 2]!);
          img.data[di + 3] = 255;
        }
      }
      if (scale === 1) {
        ctx.putImageData(img, 0, 0);
      } else {
        const tmp = document.createElement("canvas");
        tmp.width = sw; tmp.height = sh;
        tmp.getContext("2d")!.putImageData(img, 0, 0);
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(tmp, 0, 0, c.width, c.height);
      }
      return c.toDataURL("image/png");
    };

    const R = 32;
    const cx = Math.min(w - 1, Math.max(0, Math.round(peakU * w)));
    const cy = Math.min(h - 1, Math.max(0, Math.round(peakV * h)));
    const x0 = Math.max(0, Math.min(w - 2 * R, cx - R));
    const y0 = Math.max(0, Math.min(h - 2 * R, cy - R));
    return {
      full: draw(0, 0, w, h, 1),
      crop: draw(x0, y0, Math.min(2 * R, w), Math.min(2 * R, h), 6),
    };
  }

  dispose(): void {
    for (const rt of this.chain) rt.dispose();
    this.chain = [];
    this.rgbCopy?.dispose();
    this.rgbCopy = null;
    this.seedMat.dispose();
    this.reduceMat.dispose();
    this.copyMat.dispose();
    this.quad.dispose();
  }
}
