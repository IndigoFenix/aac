// src/hooks/useLicenseBilling.ts
//
// "Which license am I being asked to pay for?"
//
// A clinician's access comes from exactly one of two places: the license held
// by the INSTITUTE they are working in, or a PRIVATE license on their own user
// row (a solo SLP, a parent). Those are the two shapes the server puts the same
// six billing fields on, and the paywall must not care which it got — so this
// hook picks one and hands back a single, uniform block.
//
// The institute wins when both exist: it is the license whose expiry actually
// gates the work the clinician is doing right now.

import { useCallback } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { useInstitute } from '@/hooks/useInstitute';
import type { LicenseStatus } from '@shared/license-status';

export interface LicenseBillingInfo {
  licenseId: string;
  status: LicenseStatus;
  /** ISO date the license runs out. Null = perpetual, NOT expired. */
  expiresAt: string | null;
  /** Integer MINOR units (cents/agorot). Null = invoice customer: show the
   *  status, never a pay button — there is no self-serve price to charge. */
  priceAmount: number | null;
  priceCurrency: string | null;
  /** 'monthly' | 'yearly', or null for a license with no recurring plan. */
  subscriptionType: string | null;
  /** Whose license this is. Decides where the billing card is allowed to show. */
  scope: 'institute' | 'user';
  /** Only meaningful for scope 'institute' — a member who is not an admin may
   *  see the status but must not be offered the organisation's checkout. */
  canManage: boolean;
}

export interface UseLicenseBillingResult {
  info: LicenseBillingInfo | null;
  /** Pull fresh auth + institute state after a checkout completes. The webhook
   *  is what actually flips the row, so this is a re-read, not an optimistic
   *  update — call it on CHECKOUT_COMPLETED. */
  refresh: () => Promise<void>;
}

export function useLicenseBilling(): UseLicenseBillingResult {
  const { user, refetchUser } = useAuth();
  const { currentInstitute, refetchInstitutes } = useInstitute();

  const refresh = useCallback(async () => {
    await Promise.all([refetchUser(), refetchInstitutes()]);
  }, [refetchUser, refetchInstitutes]);

  let info: LicenseBillingInfo | null = null;

  if (currentInstitute?.licenseId) {
    info = {
      licenseId: currentInstitute.licenseId,
      status: currentInstitute.licenseStatus ?? 'none',
      expiresAt: currentInstitute.licenseExpiresAt ?? null,
      priceAmount: currentInstitute.licensePriceAmount ?? null,
      priceCurrency: currentInstitute.licensePriceCurrency ?? null,
      subscriptionType: currentInstitute.subscriptionType ?? null,
      scope: 'institute',
      canManage: currentInstitute.isAdmin === true,
    };
  } else if (user?.licenseId) {
    info = {
      licenseId: user.licenseId,
      status: user.licenseStatus ?? 'none',
      expiresAt: user.licenseExpiresAt ?? null,
      priceAmount: user.licensePriceAmount ?? null,
      priceCurrency: user.licensePriceCurrency ?? null,
      subscriptionType: user.licenseSubscriptionType ?? null,
      scope: 'user',
      canManage: true,
    };
  }

  return { info, refresh };
}

/** Days until `expiresAt`, rounded up. Null when there is no expiry. Negative
 *  once it has passed. */
export function daysUntil(expiresAt: string | null | undefined): number | null {
  if (!expiresAt) return null;
  const end = new Date(expiresAt).getTime();
  if (Number.isNaN(end)) return null;
  return Math.ceil((end - Date.now()) / (24 * 60 * 60 * 1000));
}

/** Money in the viewer's UI locale, from MINOR units. */
export function formatMoney(minorUnits: number, currency: string, locale: string): string {
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(minorUnits / 100);
  } catch {
    // Intl throws on an unknown ISO code rather than degrading.
    return `${(minorUnits / 100).toFixed(2)} ${currency}`;
  }
}

/** A date in the viewer's UI locale, e.g. "12 Oct 2026". */
export function formatDate(iso: string, locale: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(d);
}
