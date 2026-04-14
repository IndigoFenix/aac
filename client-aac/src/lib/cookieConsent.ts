/**
 * Cookie consent state, stored in localStorage.
 *
 * The banner writes one of these on user choice. Code that wants to set
 * non-essential cookies (future analytics / marketing) should gate on
 * `hasCookieConsent("analytics")` etc.
 *
 * `necessary` is always true — includes auth/session cookies and the consent
 * record itself. It exists only to document the data shape.
 */

export type CookieCategory = "necessary" | "functional" | "analytics" | "marketing";

export interface CookieConsentRecord {
  version: 1;
  necessary: true;
  functional: boolean;
  analytics: boolean;
  marketing: boolean;
  decidedAt: string; // ISO timestamp
}

const STORAGE_KEY = "cookie-consent";

export function readCookieConsent(): CookieConsentRecord | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    // Legacy value (the first iteration stored the plain string "accepted")
    if (raw === "accepted") {
      return {
        version: 1,
        necessary: true,
        functional: true,
        analytics: true,
        marketing: true,
        decidedAt: new Date(0).toISOString(),
      };
    }
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && parsed.version === 1) {
      return parsed as CookieConsentRecord;
    }
    return null;
  } catch {
    return null;
  }
}

export function writeCookieConsent(choice: "all" | "essential"): CookieConsentRecord {
  const record: CookieConsentRecord = {
    version: 1,
    necessary: true,
    functional: choice === "all",
    analytics: choice === "all",
    marketing: choice === "all",
    decidedAt: new Date().toISOString(),
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(record));
  return record;
}

export function hasCookieConsent(category: CookieCategory): boolean {
  if (category === "necessary") return true;
  const record = readCookieConsent();
  if (!record) return false;
  return record[category] === true;
}

export function hasDecidedCookieConsent(): boolean {
  return readCookieConsent() !== null;
}
