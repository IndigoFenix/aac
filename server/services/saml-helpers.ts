// SAML 2.0 helper. Wraps `@node-saml/node-saml` so the rest of the
// identity service can stay protocol-agnostic. One SAML client is built
// per provider (cheap; `new SAML(config)` is just option parsing).
//
// We deliberately use HTTP-Redirect binding for AuthnRequests (sent by us)
// and HTTP-POST binding for SAML Responses (sent by the IdP to our ACS).

import { SAML, type SamlConfig, type Profile, ValidateInResponseTo } from "@node-saml/node-saml";
import type { IdentityProvider } from "@shared/schema";
import { decrypt } from "./encryption";

const CALLBACK_BASE_URL = process.env.IDENTITY_CALLBACK_URL || process.env.APP_URL || "";

/** Path on our server that IdPs POST SAML Responses to. */
export function samlAcsPath(providerId: string): string {
  return `/api/identity/saml/acs/${providerId}`;
}

/** Path that returns SP metadata XML for a provider. */
export function samlMetadataPath(providerId: string): string {
  return `/api/identity/saml/metadata/${providerId}`;
}

/** Path that the IdP POSTs LogoutResponse / LogoutRequest to. */
export function samlSloPath(providerId: string): string {
  return `/api/identity/saml/sls/${providerId}`;
}

/** Default SP entity ID when the provider doesn't override it. */
export function defaultSpEntityId(providerId: string): string {
  return `${CALLBACK_BASE_URL}/api/identity/saml/sp/${providerId}`;
}

async function buildSamlConfig(provider: IdentityProvider): Promise<SamlConfig> {
  if (provider.protocol !== "saml") {
    throw new Error(`Provider ${provider.id} is not SAML (protocol=${provider.protocol})`);
  }
  if (!provider.samlSsoUrl) throw new Error("SAML provider missing samlSsoUrl");
  if (!provider.samlX509Cert) throw new Error("SAML provider missing samlX509Cert");

  const issuer = provider.samlSpEntityId || defaultSpEntityId(provider.id);
  const callbackUrl = `${CALLBACK_BASE_URL}${samlAcsPath(provider.id)}`;

  const config: SamlConfig = {
    idpCert: provider.samlX509Cert,
    issuer,
    callbackUrl,
    entryPoint: provider.samlSsoUrl,
    logoutUrl: provider.samlSloUrl ?? undefined,
    identifierFormat: provider.samlNameIdFormat ?? null,
    wantAssertionsSigned: provider.samlWantAssertionsSigned ?? true,
    // The library defaults to "always"; we accept "ifPresent" since some
    // IdPs (notably IL MoE) may omit InResponseTo on IdP-initiated SSO.
    validateInResponseTo: ValidateInResponseTo.ifPresent,
  };

  if (provider.samlSignAuthnRequests && provider.samlSpPrivateKey) {
    config.privateKey = await decrypt(provider.samlSpPrivateKey);
    config.signatureAlgorithm = "sha256";
    if (provider.samlSpCertificate) {
      config.publicCert = provider.samlSpCertificate;
    }
  }

  return config;
}

/** Build a SAML client for a provider. Constructor is cheap; no caching. */
export async function buildSamlClient(provider: IdentityProvider): Promise<SAML> {
  const cfg = await buildSamlConfig(provider);
  return new SAML(cfg);
}

/** Returns the IdP redirect URL (HTTP-Redirect binding) that begins SSO. */
export async function buildSamlLoginUrl(
  provider: IdentityProvider,
  relayState: string,
): Promise<string> {
  const saml = await buildSamlClient(provider);
  return saml.getAuthorizeUrlAsync(relayState, undefined, {});
}

/** Validates a POST'd SAMLResponse and returns the extracted profile. */
export async function validateSamlResponse(
  provider: IdentityProvider,
  samlResponse: string,
): Promise<Profile> {
  const saml = await buildSamlClient(provider);
  const { profile, loggedOut } = await saml.validatePostResponseAsync({ SAMLResponse: samlResponse });
  if (loggedOut) {
    throw new Error("SAML response is a logout, not an authn response");
  }
  if (!profile) {
    throw new Error("SAML response had no profile");
  }
  return profile;
}

/**
 * Build the IdP redirect URL that begins SP-initiated Single Logout.
 * The user's SAML profile (stored on `user_external_identities.claims`)
 * carries `nameID` and `sessionIndex` — both required by SAML for the
 * IdP to correlate the logout with the original SSO session.
 */
export async function buildSamlLogoutUrl(
  provider: IdentityProvider,
  profile: Profile,
  relayState: string,
): Promise<string> {
  if (!provider.samlSloUrl) {
    throw new Error("SAML provider has no samlSloUrl — Single Logout not supported");
  }
  const saml = await buildSamlClient(provider);
  return saml.getLogoutUrlAsync(profile, relayState, {});
}

/**
 * Validate a POST'd LogoutResponse from the IdP (the response to a
 * LogoutRequest we initiated). Returns true if the IdP confirmed the
 * logout. Throws on signature/format errors.
 */
export async function validateSamlLogoutResponse(
  provider: IdentityProvider,
  samlResponse: string,
): Promise<boolean> {
  const saml = await buildSamlClient(provider);
  const { loggedOut } = await saml.validatePostResponseAsync({ SAMLResponse: samlResponse });
  return loggedOut;
}

/** Returns SP metadata XML for the IdP onboarding handshake. */
export async function generateSpMetadata(provider: IdentityProvider): Promise<string> {
  const saml = await buildSamlClient(provider);
  // First arg = decryption cert (we don't decrypt); second = signing cert
  // published in metadata. Library accepts null for either when omitted.
  const signingCert = provider.samlSpCertificate || null;
  return saml.generateServiceProviderMetadata(null, signingCert);
}

/** Normalize a SAML Profile into the canonical claim shape we use across protocols. */
export function profileToClaims(profile: Profile): Record<string, unknown> {
  // Keep ALL attributes; the claim-mapping layer (§1.2) reads from this.
  // node-saml flattens attributes onto the profile, plus nameID/email.
  const claims: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(profile)) {
    // Drop internal callable fields
    if (typeof v === "function") continue;
    claims[k] = v;
  }
  return claims;
}
