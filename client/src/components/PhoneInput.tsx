// client/src/components/PhoneInput.tsx
//
// Country-aware phone input. Always emits an E.164 string (or "" when empty)
// via onChange — callers store and submit the canonical form. The country
// dropdown disambiguates domestic-format input ("0507414948" + IL → "+972…").
//
// On mount, if the incoming value is already E.164, the country selector is
// initialized from the dial code. If it's a domestic-format string, we show
// it as-is and let the user pick the country.

import { useEffect, useMemo, useState } from "react";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toE164 } from "@shared/phone";

interface CountryEntry {
  iso: string;        // ISO 3166-1 alpha-2
  dial: string;       // E.164 dial code without "+"
  name: string;       // English name (UI label)
  flag: string;       // emoji flag for compact display
}

// Curated list of supported countries — same set toE164 knows about, plus
// future expansion candidates. Order: project's primary markets first.
export const PHONE_COUNTRIES: CountryEntry[] = [
  { iso: "IL", dial: "972", name: "Israel",         flag: "🇮🇱" },
  { iso: "US", dial: "1",   name: "United States",  flag: "🇺🇸" },
  { iso: "GB", dial: "44",  name: "United Kingdom", flag: "🇬🇧" },
  { iso: "CA", dial: "1",   name: "Canada",         flag: "🇨🇦" },
  { iso: "AU", dial: "61",  name: "Australia",      flag: "🇦🇺" },
  { iso: "DE", dial: "49",  name: "Germany",        flag: "🇩🇪" },
  { iso: "FR", dial: "33",  name: "France",         flag: "🇫🇷" },
  { iso: "ES", dial: "34",  name: "Spain",          flag: "🇪🇸" },
  { iso: "IT", dial: "39",  name: "Italy",          flag: "🇮🇹" },
];

const DEFAULT_COUNTRY = "IL";

function countryFromE164(e164: string): string | null {
  if (!e164.startsWith("+")) return null;
  const digits = e164.slice(1);
  // Match the longest dial code first so "+1..." (NA) doesn't shadow "+1242"
  // (BS) once we add more — sort the list descending by dial length.
  const sorted = [...PHONE_COUNTRIES].sort((a, b) => b.dial.length - a.dial.length);
  for (const c of sorted) {
    if (digits.startsWith(c.dial)) return c.iso;
  }
  return null;
}

interface PhoneInputProps {
  /** Current value — should be E.164 once a valid number is entered. */
  value: string;
  /** Called with the canonical E.164 string, or "" when empty/invalid. */
  onChange: (e164: string) => void;
  /**
   * Default country when `value` is empty and not E.164. Falls back to IL.
   * Pass the related entity's country (student.country, user.country, etc.).
   */
  defaultCountry?: string | null;
  /** id for the input element (so a Label can target it). */
  id?: string;
  placeholder?: string;
  disabled?: boolean;
  /** When true, show a small inline error label under the input. */
  showInlineError?: boolean;
  /** Marks the input invalid for styling. */
  invalid?: boolean;
}

export function PhoneInput({
  value,
  onChange,
  defaultCountry,
  id,
  placeholder,
  disabled,
  showInlineError = true,
  invalid,
}: PhoneInputProps) {
  // Local UI state — the displayed input is the user's typing in domestic
  // format; we only convert to E.164 when emitting onChange.
  const [country, setCountry] = useState<string>(() => {
    return (
      countryFromE164(value) ??
      (defaultCountry ?? DEFAULT_COUNTRY).toUpperCase()
    );
  });
  const [localPart, setLocalPart] = useState<string>(() => {
    if (!value) return "";
    if (!value.startsWith("+")) return value;
    const c = countryFromE164(value);
    if (!c) return value;
    const dial = PHONE_COUNTRIES.find((x) => x.iso === c)?.dial;
    return dial ? value.slice(dial.length + 1) : value;
  });

  // Re-emit canonical E.164 whenever country or local-part changes. We avoid
  // emitting on the very first render — only after the user actually edits —
  // by keeping a ref-style flag. Simpler: always emit; it's idempotent.
  useEffect(() => {
    if (!localPart.trim()) {
      onChange("");
      return;
    }
    const e164 = toE164(localPart, country);
    onChange(e164 ?? "");
    // We deliberately exclude onChange from deps — its identity may change
    // each render in callers, which would loop us.
     
  }, [country, localPart]);

  const isInvalid = useMemo(() => {
    if (invalid) return true;
    if (!localPart.trim()) return false;
    return toE164(localPart, country) === null;
  }, [country, localPart, invalid]);

  const dialCode = PHONE_COUNTRIES.find((c) => c.iso === country)?.dial;

  return (
    <div className="space-y-1">
      <div className="flex gap-2">
        <Select value={country} onValueChange={setCountry} disabled={disabled}>
          <SelectTrigger className="w-[140px]" aria-label="Country">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PHONE_COUNTRIES.map((c) => (
              <SelectItem key={c.iso} value={c.iso}>
                <span className="mr-1">{c.flag}</span>
                {c.iso} +{c.dial}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          id={id}
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          value={localPart}
          onChange={(e) => setLocalPart(e.target.value)}
          placeholder={placeholder ?? (dialCode ? `e.g. 0501234567` : "")}
          disabled={disabled}
          className={isInvalid ? "border-destructive" : ""}
        />
      </div>
      {showInlineError && isInvalid && (
        <p className="text-xs text-destructive">
          Enter a valid phone number for the selected country.
        </p>
      )}
    </div>
  );
}
