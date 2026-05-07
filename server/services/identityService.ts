import * as client from "openid-client";
import memoize from "memoizee";
import { identityProviderRepository } from "../repositories/identityProviderRepository";
import { encrypt, decrypt } from "./encryption";
import { autoProvisionFromProfile as autoProvisionImpl } from "./identity-auto-provision";
import type { User } from "@shared/schema";
import {
  applyClaimMapping,
  type ClaimMapping,
  type CanonicalProfile,
} from "./identity-claim-mapping";
import {
  buildSamlLoginUrl,
  validateSamlResponse,
  generateSpMetadata,
  profileToClaims,
  buildSamlLogoutUrl,
  validateSamlLogoutResponse,
} from "./saml-helpers";
import type {
  IdentityProvider,
  InsertIdentityProvider,
  UpdateIdentityProvider,
  UserExternalIdentity,
} from "@shared/schema";

// Cache OIDC configs per provider for 1 hour
const oidcConfigCache = memoize(
  async (providerId: string, discoveryUrl: string, clientId: string, clientSecret: string) => {
    return await client.discovery(
      new URL(discoveryUrl),
      clientId,
      clientSecret,
    );
  },
  { maxAge: 3600 * 1000, primitive: true },
);

export class IdentityService {
  // ==================== Provider CRUD ====================

  async getAllProviders(): Promise<IdentityProvider[]> {
    return identityProviderRepository.getAll();
  }

  async getActiveProviders(): Promise<IdentityProvider[]> {
    return identityProviderRepository.getActive();
  }

  async getProvider(id: string): Promise<IdentityProvider | undefined> {
    return identityProviderRepository.getById(id);
  }

  async getProviderByInstituteIdType(idType: string): Promise<IdentityProvider | undefined> {
    return identityProviderRepository.getByInstituteIdType(idType);
  }

  async createProvider(data: InsertIdentityProvider): Promise<IdentityProvider> {
    const toInsert: InsertIdentityProvider = { ...data };
    // OIDC/OAuth2: encrypt client secret. SAML: encrypt SP private key (no shared secret).
    if (data.clientSecret) {
      toInsert.clientSecret = await encrypt(data.clientSecret);
    }
    if (data.samlSpPrivateKey) {
      toInsert.samlSpPrivateKey = await encrypt(data.samlSpPrivateKey);
    }
    return identityProviderRepository.create(toInsert);
  }

  async updateProvider(id: string, data: UpdateIdentityProvider): Promise<IdentityProvider | undefined> {
    const updateData = { ...data };
    if (data.clientSecret) {
      updateData.clientSecret = await encrypt(data.clientSecret);
    }
    if (data.samlSpPrivateKey) {
      updateData.samlSpPrivateKey = await encrypt(data.samlSpPrivateKey);
    }
    return identityProviderRepository.update(id, updateData);
  }

  async deleteProvider(id: string): Promise<boolean> {
    return identityProviderRepository.delete(id);
  }

  // ==================== OIDC / OAuth2 Flows ====================

  /**
   * Build the authorization URL to redirect the user to the external provider.
   */
  async getAuthorizationUrl(
    providerId: string,
    redirectUri: string,
    state: string,
  ): Promise<string> {
    const provider = await identityProviderRepository.getById(providerId);
    if (!provider) throw new Error("Identity provider not found");
    if (!provider.isActive) throw new Error("Identity provider is not active");

    const scopes = provider.scopes || "openid email profile";

    if (provider.protocol === "saml") {
      throw new Error("SAML providers do not use getAuthorizationUrl — call buildSamlLoginRequest instead");
    }

    if (!provider.clientId || !provider.clientSecret) {
      throw new Error("OIDC/OAuth2 providers require clientId and clientSecret");
    }

    if (provider.protocol === "oidc" && provider.discoveryUrl) {
      const secret = await decrypt(provider.clientSecret);
      const config = await oidcConfigCache(
        provider.id,
        provider.discoveryUrl,
        provider.clientId,
        secret,
      );
      const params = new URLSearchParams({
        client_id: provider.clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: scopes,
        state,
      });
      const authEndpoint = config.serverMetadata().authorization_endpoint;
      if (!authEndpoint) throw new Error("No authorization endpoint found in OIDC config");
      return `${authEndpoint}?${params.toString()}`;
    }

    // OAuth2 fallback (manual URLs)
    if (!provider.authorizationUrl) {
      throw new Error("No authorization URL configured for this provider");
    }
    const params = new URLSearchParams({
      client_id: provider.clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: scopes,
      state,
    });
    return `${provider.authorizationUrl}?${params.toString()}`;
  }

  /**
   * Exchange the authorization code for tokens and extract user claims.
   * @param callbackUrl The full callback URL including query parameters (code, state, etc.)
   * @param expectedState The state value to verify against CSRF
   */
  async handleCallback(
    providerId: string,
    callbackUrl: URL,
    expectedState?: string,
  ): Promise<{ externalId: string; email?: string; claims: Record<string, unknown>; profile: CanonicalProfile }> {
    const provider = await identityProviderRepository.getById(providerId);
    if (!provider) throw new Error("Identity provider not found");

    if (provider.protocol === "saml") {
      throw new Error("SAML providers do not use handleCallback — call handleSamlCallback instead");
    }
    if (!provider.clientId || !provider.clientSecret) {
      throw new Error("OIDC/OAuth2 providers require clientId and clientSecret");
    }

    const secret = await decrypt(provider.clientSecret);

    if (provider.protocol === "oidc" && provider.discoveryUrl) {
      const config = await oidcConfigCache(
        provider.id,
        provider.discoveryUrl,
        provider.clientId,
        secret,
      );
      const tokens = await client.authorizationCodeGrant(config, callbackUrl, {
        expectedState,
      });
      const claims = tokens.claims() as Record<string, unknown> | undefined;
      if (!claims) throw new Error("No claims returned from OIDC provider");
      const profile = applyClaimMapping(claims, provider.claimMappings as ClaimMapping | null);
      return { externalId: profile.externalId, email: profile.email, claims, profile };
    }

    // OAuth2 fallback — manual token exchange
    const code = callbackUrl.searchParams.get("code");
    if (!code) throw new Error("No authorization code in callback URL");

    if (!provider.tokenUrl) {
      throw new Error("No token URL configured for this provider");
    }
    // Build redirect URI without query params for token exchange
    const redirectUri = `${callbackUrl.origin}${callbackUrl.pathname}`;
    const tokenResponse = await fetch(provider.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: provider.clientId,
        client_secret: secret,
      }),
    });
    if (!tokenResponse.ok) {
      throw new Error(`Token exchange failed: ${tokenResponse.statusText}`);
    }
    const tokenData = await tokenResponse.json() as Record<string, unknown>;
    const accessToken = tokenData.access_token as string;

    // Fetch user info
    if (!provider.userinfoUrl) {
      throw new Error("No userinfo URL configured for this provider");
    }
    const userinfoResponse = await fetch(provider.userinfoUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!userinfoResponse.ok) {
      throw new Error(`Userinfo fetch failed: ${userinfoResponse.statusText}`);
    }
    const claims = await userinfoResponse.json() as Record<string, unknown>;
    const profile = applyClaimMapping(claims, provider.claimMappings as ClaimMapping | null);
    return { externalId: profile.externalId, email: profile.email, claims, profile };
  }

  // ==================== SAML 2.0 Flows ====================

  /**
   * Build the IdP redirect URL (HTTP-Redirect binding) that begins SSO.
   * Caller is expected to redirect the user to this URL.
   */
  async buildSamlLoginUrl(providerId: string, relayState: string): Promise<string> {
    const provider = await identityProviderRepository.getById(providerId);
    if (!provider) throw new Error("Identity provider not found");
    if (!provider.isActive) throw new Error("Identity provider is not active");
    if (provider.protocol !== "saml") throw new Error(`Provider ${providerId} is not SAML`);
    return buildSamlLoginUrl(provider, relayState);
  }

  /**
   * Validate a SAML POST response and return canonical claims.
   * Returns the same shape as `handleCallback` for caller symmetry.
   */
  async handleSamlCallback(
    providerId: string,
    samlResponse: string,
  ): Promise<{ externalId: string; email?: string; claims: Record<string, unknown>; profile: CanonicalProfile }> {
    const provider = await identityProviderRepository.getById(providerId);
    if (!provider) throw new Error("Identity provider not found");
    if (provider.protocol !== "saml") throw new Error(`Provider ${providerId} is not SAML`);

    const samlProfile = await validateSamlResponse(provider, samlResponse);
    const claims = profileToClaims(samlProfile);
    const profile = applyClaimMapping(claims, provider.claimMappings as ClaimMapping | null);
    return { externalId: profile.externalId, email: profile.email, claims, profile };
  }

  /**
   * Generate the SP metadata XML for a SAML provider. Used by IdP onboarding.
   */
  async getSamlMetadata(providerId: string): Promise<string> {
    const provider = await identityProviderRepository.getById(providerId);
    if (!provider) throw new Error("Identity provider not found");
    if (provider.protocol !== "saml") throw new Error(`Provider ${providerId} is not SAML`);
    return generateSpMetadata(provider);
  }

  /**
   * Build the IdP redirect URL for SP-initiated SAML Single Logout.
   * Looks up the user's stored claims (which carry nameID + sessionIndex
   * from the original SSO assertion) and asks node-saml to construct the
   * signed LogoutRequest URL.
   *
   * Throws if the provider isn't SAML, has no SLO URL configured, or the
   * user has no linked identity for this provider.
   */
  async buildSamlLogoutUrl(
    providerId: string,
    userId: string,
    relayState: string,
  ): Promise<string> {
    const provider = await identityProviderRepository.getById(providerId);
    if (!provider) throw new Error("Identity provider not found");
    if (provider.protocol !== "saml") throw new Error(`Provider ${providerId} is not SAML`);

    const identity = await identityProviderRepository.getExternalIdentity(userId, providerId);
    if (!identity) throw new Error("No SAML identity linked for this user");
    const claims = (identity.claims ?? {}) as Record<string, unknown>;
    const nameID = (claims.nameID ?? claims.sub) as string | undefined;
    if (!nameID) throw new Error("Stored SAML claims missing nameID — cannot construct LogoutRequest");

    // node-saml's Profile shape — only nameID/nameIDFormat/sessionIndex are
    // load-bearing for logout. Issuer is filled from provider.samlEntityId.
    const profile = {
      nameID,
      nameIDFormat: (claims.nameIDFormat as string | undefined)
        || provider.samlNameIdFormat
        || "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
      sessionIndex: claims.sessionIndex as string | undefined,
      issuer: provider.samlEntityId ?? "",
    };

    return buildSamlLogoutUrl(provider, profile as never, relayState);
  }

  /**
   * Validate a POST'd LogoutResponse from the IdP. Returns true if the IdP
   * confirmed the logout.
   */
  async handleSamlLogoutCallback(
    providerId: string,
    samlResponse: string,
  ): Promise<boolean> {
    const provider = await identityProviderRepository.getById(providerId);
    if (!provider) throw new Error("Identity provider not found");
    if (provider.protocol !== "saml") throw new Error(`Provider ${providerId} is not SAML`);
    return validateSamlLogoutResponse(provider, samlResponse);
  }

  // ==================== Identity Linking ====================

  /**
   * Link an external identity to a user (or update existing link).
   */
  async linkIdentity(
    userId: string,
    providerId: string,
    externalId: string,
    email?: string,
    claims?: Record<string, unknown>,
  ): Promise<UserExternalIdentity> {
    return identityProviderRepository.upsertExternalIdentity({
      userId,
      providerId,
      externalId,
      email: email ?? null,
      claims: claims ?? {},
      verifiedAt: new Date(),
    });
  }

  /**
   * Check if a user has a valid (non-expired) identity for a provider.
   * Returns expiresAt and daysUntilExpiry when the provider enforces re-verification.
   */
  async checkIdentityStatus(
    userId: string,
    providerId: string,
  ): Promise<{
    linked: boolean;
    expired: boolean;
    expiresAt: Date | null;
    daysUntilExpiry: number | null;
    identity?: UserExternalIdentity;
  }> {
    const identity = await identityProviderRepository.getExternalIdentity(userId, providerId);
    if (!identity) return { linked: false, expired: false, expiresAt: null, daysUntilExpiry: null };

    const provider = await identityProviderRepository.getById(providerId);
    if (!provider) return { linked: false, expired: false, expiresAt: null, daysUntilExpiry: null };

    if (provider.reverificationDays != null && identity.verifiedAt) {
      const expiresAt = new Date(identity.verifiedAt);
      expiresAt.setDate(expiresAt.getDate() + provider.reverificationDays);
      const now = Date.now();
      const daysUntilExpiry = Math.ceil((expiresAt.getTime() - now) / (24 * 60 * 60 * 1000));
      if (now > expiresAt.getTime()) {
        return { linked: true, expired: true, expiresAt, daysUntilExpiry, identity };
      }
      return { linked: true, expired: false, expiresAt, daysUntilExpiry, identity };
    }

    return { linked: true, expired: false, expiresAt: null, daysUntilExpiry: null, identity };
  }

  /**
   * Find a user by their external identity (for login flows like Google OAuth).
   */
  async findUserByExternalId(
    providerId: string,
    externalId: string,
  ): Promise<UserExternalIdentity | undefined> {
    return identityProviderRepository.getExternalIdentityByExternalId(providerId, externalId);
  }

  /**
   * Get all external identities for a user.
   */
  async getUserIdentities(userId: string): Promise<UserExternalIdentity[]> {
    return identityProviderRepository.getExternalIdentitiesByUser(userId);
  }

  /**
   * Remove an external identity link.
   */
  async unlinkIdentity(userId: string, providerId: string): Promise<boolean> {
    return identityProviderRepository.deleteExternalIdentity(userId, providerId);
  }

  /**
   * Auto-provision a new user from a canonical SSO profile and link the
   * external identity. Implementation lives in `identity-auto-provision.ts`
   * so it can be unit-tested without pulling the openid-client transitive
   * deps (which Jest's CJS runtime can't load).
   */
  async autoProvisionFromProfile(
    provider: IdentityProvider,
    profile: CanonicalProfile,
  ): Promise<{ user: User; created: boolean }> {
    return autoProvisionImpl(provider, profile);
  }
}

export const identityService = new IdentityService();
