// Client-side regime resolution. Reads regimes off the currently selected
// institute's license permissions and exposes typed helpers.
//
// Use this anywhere UI needs to branch on compliance regime (e.g. picking
// the right accessibility-statement variant, showing an MoE login button,
// gating an audit-retention setting). Never read
// `licensePermissions.complianceRegimes` directly — go through this hook.

import { useMemo } from "react";
import { useInstitute } from "@/hooks/useInstitute";
import {
  type RegimeSlug,
  type RegimeBundle,
  getRegimeBundle,
  normalizeRegimes,
  hasRegime as hasRegimeIn,
  hasCountry as hasCountryIn,
  resolveAccessibilityStandard,
} from "@shared/regime";

export interface UseRegimesResult {
  regimes: RegimeSlug[];
  bundles: RegimeBundle[];
  hasRegime: (slug: RegimeSlug) => boolean;
  hasCountry: (country: string) => boolean;
  accessibilityStandard: ReturnType<typeof resolveAccessibilityStandard>;
}

export function useRegimes(): UseRegimesResult {
  const { currentInstitute } = useInstitute();

  return useMemo(() => {
    const raw = currentInstitute?.licensePermissions?.complianceRegimes;
    const regimes = normalizeRegimes(raw);
    const bundles = regimes
      .map(getRegimeBundle)
      .filter((b): b is RegimeBundle => b !== null);
    return {
      regimes,
      bundles,
      hasRegime: (slug: RegimeSlug) => hasRegimeIn(regimes, slug),
      hasCountry: (country: string) => hasCountryIn(regimes, country),
      accessibilityStandard: resolveAccessibilityStandard(regimes),
    };
  }, [currentInstitute?.licensePermissions?.complianceRegimes]);
}
