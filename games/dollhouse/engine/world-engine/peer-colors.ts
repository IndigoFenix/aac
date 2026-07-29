// shared/world-engine/peer-colors.ts
//
// THE peer-identity palette — one FNV-1a hash → hue for every surface that
// tints something by participant id: the 2D renderer's avatar discs, the 3D
// renderer's capsules/possession glows, a remote peer's spark light, and the
// client's video-tile borders. Pure and import-free on purpose: a client can
// colour a video tile without pulling three (or anything else) in.
//
// One family, one formula. render2d/render3d used to carry private copies of
// the same hash with slightly different saturations; both now derive from
// here, so a participant is the SAME colour in every view and on every tile.

/** Stable hue (0..359) from a participant id — FNV-1a over the id's chars.
 *  The exact hash render2d/render3d always used; exported so any surface can
 *  derive its own shade of the same family. */
export function peerHueForId(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h = (h ^ id.charCodeAt(i)) >>> 0;
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h % 360;
}

/** The canonical peer colour — hsl(hue, 60%, 55%) as a `#rrggbb` hex string.
 *  Readable on light and dark ground, never a bright specular (seizure rule). */
export function colorHexForId(id: string): string {
  return hslToHex(peerHueForId(id), 0.6, 0.55);
}

/** Standard HSL→hex (h in degrees, s/l 0..1). Private — the palette exports
 *  ids-to-colours, not a general colour library. */
function hslToHex(h: number, s: number, l: number): string {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number): string => {
    const k = (n + h / 30) % 12;
    const c = l - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1)));
    return Math.round(255 * c)
      .toString(16)
      .padStart(2, "0");
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}
