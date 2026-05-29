// shared/social-bot/ProceduralFace.tsx
//
// Anchor-point SVG face for the social bot. The same affect tuple the
// director produces — (valence, arousal, rapport, smirk, gx, gy) — drives
// every geometric anchor. `amplitude = expressiveness × legibility` is the
// expressive ceiling: drop either toward 0 and the same emotion barely
// registers (that's how the higher difficulty levels feel "harder to read").
//
// This component is pure render + interpolation. No state machine, no
// presets, no controls — the server-side DirectedSession owns the target
// values and pushes them over the WS; this component lerps from prior to
// target each frame so transitions are smooth.

import { useEffect, useRef, useState } from "react";
import type * as React from "react";

export interface FaceTarget {
  /** -1 .. 1 — pleasure axis. */
  v: number;
  /** -1 .. 1 — energy axis. */
  a: number;
  /** -1 .. 1 — felt connection to the user. */
  r: number;
  /** -1 .. 1 — asymmetric mouth corner lift (e.g. smirk = 0.5..1). */
  smirk: number;
  /** -1 .. 1 — pupil horizontal offset. */
  gx: number;
  /** -1 .. 1 — pupil vertical offset (-down +up). */
  gy: number;
}

export type NoseShape = "circle" | "ellipse_v" | "ellipse_h" | "triangle";
export type HairStyle = "tuft" | "messy" | "bun" | "spike";
export type EarStyle = "round" | "pointed" | "floppy";
export type AccessoryKind = "hat" | "glasses" | "bowtie" | "flower";

export interface FaceAppearance {
  /** Skin hue base (degrees, full wheel for muppet-style colors). */
  hue: number;
  /** 0–100. Higher = more vivid muppet color; lower = more natural skin. */
  saturation: number;
  /** 0–100. */
  lightness: number;
  headRx: number;
  headRy: number;
  eyeDX: number;
  browW: number;
  /** Nose shape — gives the silhouette some character. */
  nose: NoseShape;
  /** Optional hair tuft. */
  hair?: { color: string; style: HairStyle };
  /** Optional ears flanking the head. */
  ears?: { style: EarStyle; color?: string };
  /** Optional accessory. May also drive a conversational interest. */
  accessory?: { kind: AccessoryKind; color: string };
}

export const NEUTRAL_FACE: FaceTarget = { v: 0, a: 0, r: 0.2, smirk: 0, gx: 0, gy: 0 };

interface Props {
  target: FaceTarget;
  appearance: FaceAppearance;
  /** 0..1 trait — how legibly mood shows. Multiplied into amplitude. */
  expressiveness?: number;
  /** 0..1 — drops at higher difficulty so the same mood is harder to read. */
  legibility?: number;
  /** Instantaneous mouth-amplitude (0..1) from audio playback. Adds to the
   *  expression-driven mouth open so the mouth flaps in sync with speech.
   *  Not lerped — it reads the current audio analyser RMS each render. */
  speakingLevel?: number;
  /** Override the container's sizing — use a fixed width/height in headers. */
  style?: React.CSSProperties;
  className?: string;
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

export function ProceduralFace({
  target,
  appearance,
  expressiveness = 0.85,
  legibility = 1,
  speakingLevel = 0,
  style,
  className,
}: Props) {
  // Live-interpolated state (separate from target so animation is smooth).
  const [cur, setCur] = useState<FaceTarget>(NEUTRAL_FACE);
  const tref = useRef(target);
  tref.current = target;

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      setCur((c) => {
        const t = tref.current;
        const k = 0.14; // lerp factor per frame — ~7 frames to converge 50%
        return {
          v: lerp(c.v, t.v, k),
          a: lerp(c.a, t.a, k),
          r: lerp(c.r, t.r, k),
          smirk: lerp(c.smirk, t.smirk, k),
          gx: lerp(c.gx, t.gx, k),
          gy: lerp(c.gy, t.gy, k),
        };
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  // ── Mapping: state → anchor geometry ─────────────────────────────────────
  const amp = clamp(expressiveness * legibility, 0.06, 1);
  const { v, a, r, smirk, gx, gy } = cur;
  const joy = Math.max(0, v);
  const neg = Math.max(0, -v);
  const sad = neg * Math.max(0, -a);  // low-v + low-a → grief shape
  const anger = neg * Math.max(0, a); // low-v + high-a → furrow

  const skin = `hsl(${appearance.hue} ${appearance.saturation}% ${appearance.lightness}%)`;
  const skinShade = `hsl(${appearance.hue} ${Math.max(0, appearance.saturation - 10)}% ${Math.max(0, appearance.lightness - 12)}%)`;
  const blush = clamp((joy * Math.max(0, a) + Math.max(0, r) * 0.5) * amp, 0, 0.85);

  const CX = 180;
  const eyeY = 172;
  const browY0 = 140;
  const mouthY = 252;
  const eyeLX = CX - appearance.eyeDX;
  const eyeRX = CX + appearance.eyeDX;

  // Eyes: open with arousal, squint with a big smile
  const eyeOpen = clamp(15 + a * 9 * amp - joy * 6 * amp, 2.5, 26);
  const pupX = gx * 7;
  const pupY = gy * 6;

  // Brows: raise with arousal; inner up = sad, inner down + in = anger
  const browRaise = a * 11 * amp;
  const innerDY = (-sad * 11 + anger * 11) * amp;
  const innerDX = anger * 5 * amp;
  const arch = clamp(a, 0, 1) * 6 * amp;

  // Mouth: curvature = valence; corners lift with joy; smirk is asymmetric.
  // Speech amplitude is added on top — not lerped, so the mouth flaps in
  // sync with the audio analyser's per-frame RMS. Coefficient picked so a
  // typical TTS RMS (~0.3) gives a visibly-open mouth, peak (~0.8) caps
  // out around the same height as a wide grin.
  const curve = v * 24 * amp;
  const cornerLift = joy * 9 * amp;
  const expressionOpen = clamp((Math.max(0, a) * 0.6 + joy * Math.max(0, a) * 0.4) * amp, 0, 1) * 26;
  const speechOpen = clamp(speakingLevel, 0, 1) * 26;
  const mouthOpen = Math.min(45, expressionOpen + speechOpen);
  const mhw = 36;
  const lCornerY = mouthY - cornerLift + smirk * 7 * amp;
  const rCornerY = mouthY - cornerLift - smirk * 9 * amp;

  const brow = (cx: number, mirror: boolean) => {
    const ix = cx + (mirror ? 1 : -1) * innerDX;
    const ox = cx + (mirror ? -1 : 1) * appearance.browW;
    const iy = browY0 - browRaise + innerDY;
    const oy = browY0 - browRaise + 2;
    const mx = (ix + ox) / 2;
    const my = Math.min(iy, oy) - arch;
    return `M ${ix} ${iy} Q ${mx} ${my} ${ox} ${oy}`;
  };

  const mouthPath = mouthOpen > 4
    ? `M ${CX - mhw} ${lCornerY} Q ${CX} ${mouthY + curve - mouthOpen} ${CX + mhw} ${rCornerY}
       Q ${CX} ${mouthY + curve + mouthOpen} ${CX - mhw} ${lCornerY} Z`
    : `M ${CX - mhw} ${lCornerY} Q ${CX} ${mouthY + curve} ${CX + mhw} ${rCornerY}`;

  // ── Decorations ─────────────────────────────────────────────────────────
  const earColor = appearance.ears?.color || skinShade;
  const hairColor = appearance.hair?.color || "#3b2a1a";
  const noseFill = skinShade;
  const noseY = (eyeY + mouthY) / 2 + 6;

  return (
    <svg
      viewBox="0 0 360 380"
      width="100%"
      className={className}
      style={style}
      xmlns="http://www.w3.org/2000/svg"
    >
      {/* Ears (behind the head) */}
      {appearance.ears && (() => {
        const exL = CX - appearance.headRx + 6;
        const exR = CX + appearance.headRx - 6;
        const ey = 196;
        const style = appearance.ears.style;
        const ear = (cx: number, side: 1 | -1) => {
          if (style === "round") {
            return <circle cx={cx + side * 14} cy={ey} r={18} fill={earColor} stroke={skinShade} strokeWidth={2} />;
          }
          if (style === "pointed") {
            const tx = cx + side * 32;
            return <polygon points={`${cx},${ey - 20} ${cx},${ey + 16} ${tx},${ey - 6}`} fill={earColor} stroke={skinShade} strokeWidth={2} />;
          }
          // floppy
          return <ellipse cx={cx + side * 12} cy={ey + 12} rx={12} ry={26} fill={earColor} stroke={skinShade} strokeWidth={2} />;
        };
        return <g>{ear(exL, -1)}{ear(exR, 1)}</g>;
      })()}

      {/* Head */}
      <ellipse
        cx={CX} cy={196}
        rx={appearance.headRx} ry={appearance.headRy}
        fill={skin}
        stroke={skinShade} strokeWidth={2}
      />
      <ellipse
        cx={CX} cy={196}
        rx={appearance.headRx} ry={appearance.headRy}
        fill="none" stroke="#00000010" strokeWidth={8}
      />

      {/* Hair (sits on top of head, occluded by accessories on top) */}
      {appearance.hair && (() => {
        const topY = 196 - appearance.headRy + 4;
        switch (appearance.hair.style) {
          case "tuft":
            return <path d={`M ${CX - 18} ${topY + 6} Q ${CX} ${topY - 22} ${CX + 18} ${topY + 6}`} fill={hairColor} />;
          case "messy":
            return (
              <g fill={hairColor}>
                <path d={`M ${CX - 30} ${topY + 8} Q ${CX - 22} ${topY - 18} ${CX - 6} ${topY + 4}`} />
                <path d={`M ${CX - 4} ${topY + 4} Q ${CX + 6} ${topY - 24} ${CX + 18} ${topY + 6}`} />
                <path d={`M ${CX + 14} ${topY + 6} Q ${CX + 26} ${topY - 16} ${CX + 34} ${topY + 10}`} />
              </g>
            );
          case "bun":
            return <circle cx={CX} cy={topY - 6} r={18} fill={hairColor} stroke={`hsl(0 0% 0% / 0.2)`} strokeWidth={1} />;
          case "spike":
            return (
              <g fill={hairColor}>
                <polygon points={`${CX - 28},${topY + 6} ${CX - 18},${topY - 24} ${CX - 10},${topY + 4}`} />
                <polygon points={`${CX - 10},${topY + 4} ${CX},${topY - 30} ${CX + 10},${topY + 4}`} />
                <polygon points={`${CX + 10},${topY + 4} ${CX + 18},${topY - 22} ${CX + 28},${topY + 6}`} />
              </g>
            );
        }
      })()}

      {/* Cheeks / blush */}
      <circle
        cx={eyeLX - 6} cy={216} r={17}
        fill={`hsl(${(appearance.hue + 340) % 360} 80% 70%)`}
        opacity={blush}
      />
      <circle
        cx={eyeRX + 6} cy={216} r={17}
        fill={`hsl(${(appearance.hue + 340) % 360} 80% 70%)`}
        opacity={blush}
      />

      {/* Eyes */}
      {[eyeLX, eyeRX].map((ex, i) => (
        <g key={i}>
          <ellipse cx={ex} cy={eyeY} rx={15} ry={eyeOpen} fill="#fffdf8" stroke="#d8c7b2" strokeWidth={1.5} />
          <circle cx={ex + pupX} cy={eyeY + pupY} r={clamp(eyeOpen * 0.42, 2, 7)} fill="#2c2420" />
          <circle cx={ex + pupX + 1.5} cy={eyeY + pupY - 1.5} r={1.4} fill="#fff" opacity={0.9} />
        </g>
      ))}

      {/* Brows */}
      <path d={brow(eyeLX, false)} fill="none" stroke="#5b4636" strokeWidth={6} strokeLinecap="round" />
      <path d={brow(eyeRX, true)} fill="none" stroke="#5b4636" strokeWidth={6} strokeLinecap="round" />

      {/* Nose */}
      {(() => {
        switch (appearance.nose) {
          case "circle":
            return <circle cx={CX} cy={noseY} r={8} fill={noseFill} stroke={skinShade} strokeWidth={1.5} />;
          case "ellipse_v":
            return <ellipse cx={CX} cy={noseY} rx={6} ry={11} fill={noseFill} stroke={skinShade} strokeWidth={1.5} />;
          case "ellipse_h":
            return <ellipse cx={CX} cy={noseY} rx={12} ry={6} fill={noseFill} stroke={skinShade} strokeWidth={1.5} />;
          case "triangle":
            return (
              <polygon
                points={`${CX},${noseY - 10} ${CX - 10},${noseY + 8} ${CX + 10},${noseY + 8}`}
                fill={noseFill} stroke={skinShade} strokeWidth={1.5}
              />
            );
        }
      })()}

      {/* Mouth */}
      <path
        d={mouthPath}
        fill={mouthOpen > 4 ? "#7a3b3b" : "none"}
        stroke="#7a3b3b" strokeWidth={5}
        strokeLinecap="round" strokeLinejoin="round"
      />

      {/* Accessory (rendered last so it sits on top of everything) */}
      {appearance.accessory && (() => {
        const accColor = appearance.accessory.color;
        const accStroke = "hsl(0 0% 0% / 0.35)";
        const topY = 196 - appearance.headRy;
        switch (appearance.accessory.kind) {
          case "hat":
            // Brim + crown — simple top hat / pillbox silhouette
            return (
              <g>
                <rect x={CX - appearance.headRx + 8} y={topY - 4} width={appearance.headRx * 2 - 16} height={8} fill={accColor} stroke={accStroke} strokeWidth={1} rx={2} />
                <rect x={CX - 30} y={topY - 32} width={60} height={30} fill={accColor} stroke={accStroke} strokeWidth={1} rx={4} />
              </g>
            );
          case "glasses":
            return (
              <g fill="none" stroke={accColor} strokeWidth={3}>
                <circle cx={eyeLX} cy={eyeY} r={20} />
                <circle cx={eyeRX} cy={eyeY} r={20} />
                <line x1={eyeLX + 20} y1={eyeY} x2={eyeRX - 20} y2={eyeY} />
              </g>
            );
          case "bowtie": {
            const by = mouthY + 60;
            return (
              <g fill={accColor} stroke={accStroke} strokeWidth={1}>
                <polygon points={`${CX - 26},${by - 12} ${CX - 6},${by} ${CX - 26},${by + 12}`} />
                <polygon points={`${CX + 26},${by - 12} ${CX + 6},${by} ${CX + 26},${by + 12}`} />
                <rect x={CX - 7} y={by - 7} width={14} height={14} rx={2} />
              </g>
            );
          }
          case "flower": {
            // Tucked at the right temple
            const fx = CX + appearance.headRx * 0.65;
            const fy = 196 - appearance.headRy * 0.4;
            const petals: [number, number][] = [[0, -10], [9, -3], [6, 8], [-6, 8], [-9, -3]];
            return (
              <g>
                {petals.map(([dx, dy], i) => (
                  <circle key={i} cx={fx + dx} cy={fy + dy} r={6} fill={accColor} stroke={accStroke} strokeWidth={0.8} />
                ))}
                <circle cx={fx} cy={fy} r={3} fill="#fff5c0" />
              </g>
            );
          }
        }
      })()}
    </svg>
  );
}

// Random appearance generator (server-side, called once per session).
//
// Skin hues span the full wheel for a muppet-style palette; saturation is
// kept high (50-80%) so colors read as deliberate character choices, not
// muted realism. Nose / hair / ears / accessory are rolled independently
// so most characters have at least one distinctive feature but few have
// all four.

const NOSES: NoseShape[] = ["circle", "ellipse_v", "ellipse_h", "triangle"];
const HAIR_STYLES: HairStyle[] = ["tuft", "messy", "bun", "spike"];
const EAR_STYLES: EarStyle[] = ["round", "pointed", "floppy"];
const ACCESSORIES: AccessoryKind[] = ["hat", "glasses", "bowtie", "flower"];

function pick<T>(arr: ReadonlyArray<T>, rng: () => number): T {
  return arr[Math.floor(rng() * arr.length)];
}

/** Pick a vivid color (HSL string) for hair / accessory tints. */
function vividHsl(rng: () => number): string {
  const hue = Math.floor(rng() * 360);
  const sat = 60 + Math.floor(rng() * 30);
  const lit = 45 + Math.floor(rng() * 25);
  return `hsl(${hue} ${sat}% ${lit}%)`;
}

export function randomAppearance(rng: () => number = Math.random): FaceAppearance {
  // Skin: full hue wheel, vivid by default. ~15% chance of a softer
  // human-ish skin tone so the cast isn't 100% felt-bright.
  const naturalSkin = rng() < 0.15;
  const hue = naturalSkin ? 18 + Math.floor(rng() * 30) : Math.floor(rng() * 360);
  const saturation = naturalSkin ? 35 + Math.floor(rng() * 20) : 55 + Math.floor(rng() * 25);
  const lightness = naturalSkin ? 65 + Math.floor(rng() * 12) : 58 + Math.floor(rng() * 18);

  // Optional pieces — gate independently. The frequencies below give a
  // roughly equal mix of plain / one-accessory / fully-decked muppets.
  const hair = rng() < 0.6 ? { color: vividHsl(rng), style: pick(HAIR_STYLES, rng) } : undefined;
  const ears = rng() < 0.4
    ? { style: pick(EAR_STYLES, rng), color: rng() < 0.5 ? undefined : vividHsl(rng) }
    : undefined;
  const accessory = rng() < 0.5
    ? { kind: pick(ACCESSORIES, rng), color: vividHsl(rng) }
    : undefined;

  return {
    hue,
    saturation,
    lightness,
    headRx: 100 + rng() * 14,
    headRy: 116 + rng() * 16,
    eyeDX: 42 + rng() * 10,
    browW: 30 + rng() * 8,
    nose: pick(NOSES, rng),
    hair,
    ears,
    accessory,
  };
}
