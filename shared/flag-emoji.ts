// shared/flag-emoji.ts
// Map a flag emoji to its ISO 3166-1 alpha-2 country code (lowercase).
//
// Country-flag emoji are a pair of Regional Indicator Symbols (U+1F1E6–U+1F1FF),
// one per letter, e.g. 🇺🇸 = 🇺 + 🇸 = "US". Windows/Chrome ship no flag glyphs,
// so we render flags from bundled SVGs (attached_assets/aac-icons/flags/<iso>.svg)
// keyed by this code instead of relying on the system emoji font.

const RI_BASE = 0x1f1e6; // 🇦
const RI_LAST = 0x1f1ff; // 🇿

/**
 * Returns the lowercase ISO code for a country-flag emoji (e.g. "🇺🇸" → "us"),
 * or null if the string isn't exactly one regional-indicator pair. Subdivision
 * flags (🏴 + tag sequence), ⚑/🏁/🏳️/🏴 etc. are intentionally not handled —
 * they fall back to normal emoji rendering.
 */
export function flagEmojiToIso(s: string): string | null {
  const cps = Array.from(s); // split on code points (regional indicators are astral)
  if (cps.length !== 2) return null;
  const a = cps[0].codePointAt(0)!;
  const b = cps[1].codePointAt(0)!;
  if (a < RI_BASE || a > RI_LAST || b < RI_BASE || b > RI_LAST) return null;
  return (
    String.fromCharCode(97 + (a - RI_BASE)) + String.fromCharCode(97 + (b - RI_BASE))
  );
}
