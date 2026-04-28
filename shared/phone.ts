// shared/phone.ts
// E.164 phone-number normalization. Lightweight — no third-party library; we
// handle the common shapes our clinicians actually enter:
//   "+972507414948"   → already E.164, kept as-is
//   "0507414948" + IL → "+972507414948" (drop trunk 0, prepend country dial)
//   "(555) 123-4567"  → "+15551234567" (with US default country)
//   "972-50-741-4948" → "+972507414948"
// Anything we can't confidently reach E.164 returns null so the caller can
// surface a meaningful error instead of dispatching SMS to junk.

const COUNTRY_DIAL_CODES: Record<string, string> = {
  IL: "972",
  US: "1",
  CA: "1",
  GB: "44",
  DE: "49",
  FR: "33",
  ES: "34",
  IT: "39",
  AU: "61",
  // Extend as new markets onboard. Two-letter ISO 3166-1 alpha-2 → E.164 dial.
};

/** True iff `s` is exactly an E.164 string. */
export function isE164(s: string): boolean {
  return /^\+[1-9]\d{6,14}$/.test(s);
}

/**
 * Normalize a user-entered phone string to E.164. Returns null when the
 * input cannot be unambiguously placed in E.164 (e.g. local-format input
 * with no countryHint, or unsupported country code).
 */
export function toE164(phone: string, countryHint?: string | null): string | null {
  if (!phone) return null;
  // Strip whitespace, dashes, parens, dots — anything that's not + or digit.
  const stripped = phone.trim().replace(/[\s\-(). ]/g, "");
  if (!stripped) return null;

  // Already E.164.
  if (stripped.startsWith("+")) {
    return isE164(stripped) ? stripped : null;
  }

  // "00" international prefix: convert to "+".
  if (stripped.startsWith("00")) {
    const candidate = "+" + stripped.slice(2);
    return isE164(candidate) ? candidate : null;
  }

  // Pure digits — needs a country to disambiguate.
  if (!/^\d+$/.test(stripped)) return null;

  const country = countryHint?.toUpperCase();
  const dial = country ? COUNTRY_DIAL_CODES[country] : undefined;
  if (!dial) return null;

  // Domestic format with a leading trunk 0 (common in IL, GB, DE, FR, etc.).
  // North American Numbering Plan (US/CA) does NOT use a trunk 0, so don't
  // strip it there.
  let digits = stripped;
  if (country !== "US" && country !== "CA" && digits.startsWith("0")) {
    digits = digits.slice(1);
  }

  const candidate = `+${dial}${digits}`;
  return isE164(candidate) ? candidate : null;
}
