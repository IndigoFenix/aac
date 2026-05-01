/**
 * identify.ts
 *
 * Anonymous-visitor identification for the CRM landing-page chat.
 *
 * - Reads the client IP from the headers Cloudflare/Express set, then hashes it
 *   with a server-side salt (CRM_IP_SALT). Raw IPs are never persisted — this
 *   keeps the lead store light on personal data while still giving us an
 *   identifier stable enough to recognize returning visitors.
 * - Reads `cf-ipcountry` if Cloudflare fronts the deploy. Absent → null. We do
 *   not bundle a geo-IP database in this PR; the country column is best-effort.
 * - Returns a customer record (existing or newly created), reusing the most
 *   recent ip_hash match. Two coworkers behind one NAT will be merged at the
 *   IP layer; the public widget pairs this with a localStorage client id to
 *   reduce that collision rate (see crmChatController).
 */

import { createHash } from "crypto";
import type { Request } from "express";
import { crmRepository } from "../../repositories/crmRepository";
import type { CrmPotentialCustomer } from "@shared/schema";

const DEFAULT_DEV_SALT = "dev-only-crm-ip-salt";

function getIpSalt(): string {
  const salt = process.env.CRM_IP_SALT;
  if (salt && salt.length > 0) return salt;
  if (process.env.NODE_ENV === "production") {
    // We don't want a silent default in prod — make the misconfiguration loud.
    throw new Error("CRM_IP_SALT environment variable is required in production");
  }
  return DEFAULT_DEV_SALT;
}

export function hashIp(ip: string): string {
  return createHash("sha256").update(`${getIpSalt()}:${ip}`).digest("hex");
}

/**
 * Extract the most accurate client IP we can given the deploys's proxy chain.
 * Order: Cloudflare → first hop of XFF → req.ip (express trust-proxy aware).
 */
export function getClientIp(req: Request): string {
  const cf = req.headers["cf-connecting-ip"];
  if (typeof cf === "string" && cf.length > 0) return cf.trim();

  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.length > 0) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }

  return req.ip ?? "0.0.0.0";
}

export function getCountryCode(req: Request): string | null {
  const cc = req.headers["cf-ipcountry"];
  if (typeof cc === "string" && /^[A-Za-z]{2}$/.test(cc)) {
    return cc.toUpperCase();
  }
  return null;
}

export interface IdentifiedVisitor {
  customer: CrmPotentialCustomer;
  isReturning: boolean;
  ipHash: string;
}

/**
 * Find or create a customer row for this request. Updates last_seen_at on
 * matches; sets country/region only on first creation (we don't overwrite on
 * return — prevents a CF-less hop from clobbering a value populated earlier).
 */
export async function identifyVisitor(req: Request): Promise<IdentifiedVisitor> {
  const ip = getClientIp(req);
  const ipHash = hashIp(ip);
  const countryCode = getCountryCode(req);

  const existing = await crmRepository.findCustomerByIpHash(ipHash);
  if (existing) {
    await crmRepository.touchLastSeen(existing.id);
    return { customer: existing, isReturning: true, ipHash };
  }

  const created = await crmRepository.createCustomer({
    ipHash,
    countryCode,
    region: null,
  });
  return { customer: created, isReturning: false, ipHash };
}
