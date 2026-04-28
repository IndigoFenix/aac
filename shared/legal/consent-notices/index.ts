// Registry of informed-consent notice variants. Each variant is keyed by
// (country, locale, version). The hash for each variant is computed from
// its rendered content; consent records persist the hash so audit can
// reproduce exactly what the signer saw.
//
// Adding a new variant: write a sibling file (e.g. us-2026-04.ts), import
// it here, append to ALL_VARIANTS. The active version per country is set
// in ACTIVE_VERSION_BY_COUNTRY.

import type { ConsentNoticeContent, ConsentNoticeVariant } from "../types.js";
import { IL_2026_04_VARIANTS } from "./il-2026-04.js";

const ALL_VARIANTS: ReadonlyArray<ConsentNoticeVariant> = [
  ...IL_2026_04_VARIANTS,
];

// Active version per country. Adding a new version of an existing country's
// notice = update this map; older versions remain in ALL_VARIANTS for
// reproducing what historical signers saw.
const ACTIVE_VERSION_BY_COUNTRY: Record<string, string> = {
  IL: "IL.2026.04",
};

// Fallback for countries that don't yet have a localized notice. Until a
// US/EU/etc. notice is written, signing for those countries will fail
// at the consent-write boundary — by design — to prevent a deployment
// from accidentally collecting consent under the wrong legal frame.
function getActiveVersionForCountry(country: string): string | undefined {
  return ACTIVE_VERSION_BY_COUNTRY[country.toUpperCase()];
}

export function lookupConsentNotice(args: {
  country: string;
  locale: string;
  version?: string; // when omitted, returns the active version
}): ConsentNoticeVariant | undefined {
  const country = args.country.toUpperCase();
  const version = args.version ?? getActiveVersionForCountry(country);
  if (!version) return undefined;

  const exact = ALL_VARIANTS.find(
    (v) => v.country === country && v.locale === args.locale && v.version === version,
  );
  if (exact) return exact;

  // Fall back to the country's English variant if the requested locale isn't
  // available yet. Keeps the flow operational while translations land.
  if (args.locale !== "en") {
    return ALL_VARIANTS.find(
      (v) => v.country === country && v.locale === "en" && v.version === version,
    );
  }
  return undefined;
}

export function listLocalesForCountryVersion(country: string, version: string): string[] {
  const c = country.toUpperCase();
  return ALL_VARIANTS
    .filter((v) => v.country === c && v.version === version)
    .map((v) => v.locale);
}

/**
 * Render a notice variant's content into a deterministic string for hashing.
 * Order of fields is fixed so two equivalent variants always hash identically.
 */
export function renderNoticeForHashing(content: ConsentNoticeContent): string {
  return [
    content.title,
    content.purposeStatement,
    content.voluntarinessStatement,
    content.thirdPartyTransfersStatement,
    content.retentionStatement,
    content.rightsStatement,
  ].join("\n---\n");
}
