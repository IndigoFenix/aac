// Idempotent seed script for an identity provider. Looks up by name; updates
// in place if found, otherwise inserts. Reads all settings from env so the
// same script can seed the IL MoE Sapakim sandbox, the production MoE row,
// or any future IdP (US districts, UK DfE, internal Keycloak, etc.) by
// pointing at a different .env file.
//
// Usage:
//   tsx scripts/seed-identity-provider.ts
//
// Required env:
//   IDP_NAME                 — display name (used as upsert key)
//   IDP_PROTOCOL             — "oidc" | "oauth2" | "saml"
//   IDP_INSTITUTE_ID_TYPE    — slug used by institutes opting into this IdP
//
// SAML env (when IDP_PROTOCOL=saml):
//   SAML_SSO_URL             — IdP SSO endpoint
//   SAML_X509_CERT           — IdP signing certificate (PEM)
//   SAML_ENTITY_ID           — IdP entity ID (optional)
//   SAML_NAME_ID_FORMAT      — defaults to emailAddress
//   SAML_SLO_URL             — IdP single-logout URL (optional)
//   SAML_SP_ENTITY_ID        — override SP entity ID (else derived from APP_URL)
//   SAML_SP_PRIVATE_KEY      — PEM, only when SAML_SIGN_REQUESTS=true
//   SAML_SP_CERTIFICATE      — PEM, only when SAML_SIGN_REQUESTS=true
//   SAML_SIGN_REQUESTS       — "true" to sign AuthnRequests
//   SAML_WANT_ASSERTIONS_SIGNED — "true"|"false"; default "true"
//
// OIDC/OAuth2 env (when IDP_PROTOCOL=oidc|oauth2):
//   IDP_CLIENT_ID, IDP_CLIENT_SECRET, IDP_DISCOVERY_URL (oidc),
//   IDP_AUTHORIZATION_URL, IDP_TOKEN_URL, IDP_USERINFO_URL (oauth2),
//   IDP_SCOPES (default "openid email profile")
//
// Common env:
//   IDP_REVERIFICATION_DAYS  — integer or empty for never
//   IDP_CLAIM_MAPPINGS       — JSON object of canonical → source-key arrays
//                              e.g. {"externalId":["nameID"],"nationalIdNumber":["teudat_zehut"]}

import "dotenv/config";
import { identityService } from "../server/services/identityService";

function envBool(name: string, defaultVal: boolean): boolean {
  const v = process.env[name];
  if (v == null) return defaultVal;
  return v.toLowerCase() === "true" || v === "1";
}

function envInt(name: string): number | null {
  const v = process.env[name];
  if (!v) return null;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Required env var ${name} is not set`);
  return v;
}

async function main() {
  const name = requireEnv("IDP_NAME");
  const protocol = requireEnv("IDP_PROTOCOL") as "oidc" | "oauth2" | "saml";
  if (!["oidc", "oauth2", "saml"].includes(protocol)) {
    throw new Error(`IDP_PROTOCOL must be one of oidc|oauth2|saml; got ${protocol}`);
  }

  let claimMappings: Record<string, unknown> = {};
  if (process.env.IDP_CLAIM_MAPPINGS) {
    try {
      claimMappings = JSON.parse(process.env.IDP_CLAIM_MAPPINGS);
    } catch (err) {
      throw new Error(`IDP_CLAIM_MAPPINGS is not valid JSON: ${(err as Error).message}`);
    }
  }

  const common = {
    name,
    protocol,
    instituteIdType: process.env.IDP_INSTITUTE_ID_TYPE || null,
    reverificationDays: envInt("IDP_REVERIFICATION_DAYS"),
    claimMappings,
    isActive: true,
  };

  let body: Record<string, unknown>;
  if (protocol === "saml") {
    body = {
      ...common,
      samlSsoUrl: requireEnv("SAML_SSO_URL"),
      samlX509Cert: requireEnv("SAML_X509_CERT"),
      samlEntityId: process.env.SAML_ENTITY_ID || null,
      samlNameIdFormat: process.env.SAML_NAME_ID_FORMAT
        || "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
      samlSloUrl: process.env.SAML_SLO_URL || null,
      samlSpEntityId: process.env.SAML_SP_ENTITY_ID || null,
      samlSignAuthnRequests: envBool("SAML_SIGN_REQUESTS", false),
      samlWantAssertionsSigned: envBool("SAML_WANT_ASSERTIONS_SIGNED", true),
      samlSpCertificate: process.env.SAML_SP_CERTIFICATE || null,
      samlSpPrivateKey: process.env.SAML_SP_PRIVATE_KEY || null,
    };
  } else {
    body = {
      ...common,
      clientId: requireEnv("IDP_CLIENT_ID"),
      clientSecret: requireEnv("IDP_CLIENT_SECRET"),
      scopes: process.env.IDP_SCOPES || "openid email profile",
      discoveryUrl: process.env.IDP_DISCOVERY_URL || null,
      authorizationUrl: process.env.IDP_AUTHORIZATION_URL || null,
      tokenUrl: process.env.IDP_TOKEN_URL || null,
      userinfoUrl: process.env.IDP_USERINFO_URL || null,
    };
  }

  // Upsert by name. Get all and find the match — there's no by-name lookup
  // because name is not unique by schema (only display label).
  const existing = (await identityService.getAllProviders()).find((p) => p.name === name);

  if (existing) {
    console.log(`Updating existing provider "${name}" (id=${existing.id})`);
    await identityService.updateProvider(existing.id, body as Parameters<typeof identityService.updateProvider>[1]);
    console.log(`  ✓ updated`);
    console.log(`  SAML metadata URL: /api/identity/saml/metadata/${existing.id}`);
  } else {
    console.log(`Creating new provider "${name}"`);
    const created = await identityService.createProvider(body as Parameters<typeof identityService.createProvider>[0]);
    console.log(`  ✓ created (id=${created.id})`);
    if (protocol === "saml") {
      console.log(`  SAML metadata URL: /api/identity/saml/metadata/${created.id}`);
    }
  }

  process.exit(0);
}

main().catch((err) => {
  console.error("Seed failed:", err.message);
  process.exit(1);
});
