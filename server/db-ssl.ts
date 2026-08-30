// server/db-ssl.ts
// One place that decides how runtime Postgres connections do TLS.
//
// Until now both runtime connections (server/db.ts and the realtime
// postgres-bus) passed `rejectUnauthorized: false`: the link was encrypted but
// the server certificate was never checked, so an in-VPC MITM would go
// unnoticed. The AWS RDS CA bundle has always been in the image
// (Dockerfile copies rds-ca-bundle.pem to both /app and /app/dist) and the
// migration/test paths already verify against it — only the runtime did not.
//
// AKIM information-security appendix §4.1 asks for a current, standard
// encrypted channel; docs/AKIM_COMPLIANCE_ASSESSMENT.md §4 tracked this as an
// open item. See also docs/AKIM_ANNEX_RESPONSES.md.
//
// Behaviour, deliberately narrow so nothing that works today breaks:
//   * sslmode=disable in the URL      → TLS off (plain local Postgres).
//   * RDS host + CA bundle on disk    → verify the certificate against it.
//   * anything else (Render, Neon, a
//     local RDS-less box, missing pem) → previous behaviour, with a warning.
//
// The host check matters: the bundle only chains AWS RDS certificates, so
// applying it to Render's Postgres would break staging on boot.
//
// rds-ca-bundle.pem is AWS's GLOBAL trust store
// (https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem, refreshed
// 2026-08-30). It must stay global: the file previously held only the us-east-2
// roots, so verifying an il-central-1 endpoint against it would have failed the
// handshake — which is also why `scripts/migrate.ts`, which has always verified,
// could not have reached the production database.

import fs from "fs";
import path from "path";
import type { ConnectionOptions } from "tls";

export type DbSslConfig = false | ConnectionOptions;

/** Where the Dockerfile puts the bundle, plus the repo root for local runs. */
const CA_BUNDLE_CANDIDATES = [
  path.resolve(process.cwd(), "rds-ca-bundle.pem"),
  path.resolve(process.cwd(), "dist", "rds-ca-bundle.pem"),
];

let cachedCa: string | null | undefined;

/** Read the RDS CA bundle once; null when it is not shipped alongside us. */
function loadCaBundle(): string | null {
  if (cachedCa !== undefined) return cachedCa;
  for (const candidate of CA_BUNDLE_CANDIDATES) {
    try {
      if (fs.existsSync(candidate)) {
        cachedCa = fs.readFileSync(candidate, "utf8");
        return cachedCa;
      }
    } catch {
      // Unreadable path — fall through to the next candidate.
    }
  }
  cachedCa = null;
  return cachedCa;
}

/** True for the hosts the AWS bundle can actually validate. */
function isRdsHost(databaseUrl: string): boolean {
  try {
    return new URL(databaseUrl).hostname.endsWith(".rds.amazonaws.com");
  } catch {
    return false;
  }
}

/**
 * SSL options for a node-postgres Pool/Client, given the raw DATABASE_URL
 * (pass the URL *before* sslmode is stripped — this reads it).
 */
export function resolveDbSsl(databaseUrl: string | undefined): DbSslConfig {
  if (!databaseUrl) return { rejectUnauthorized: false };

  if (/[?&]sslmode=disable/.test(databaseUrl)) return false;

  if (isRdsHost(databaseUrl)) {
    const ca = loadCaBundle();
    if (ca) return { ca, rejectUnauthorized: true };
    console.warn(
      "[db] RDS host but rds-ca-bundle.pem was not found — connecting without " +
        "certificate verification. Check the image build.",
    );
  }

  return { rejectUnauthorized: false };
}

/** Test seam: drop the memoized bundle so a test can change the filesystem. */
export function __resetCaBundleCache(): void {
  cachedCa = undefined;
}
