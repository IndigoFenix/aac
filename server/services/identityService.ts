import * as client from "openid-client";
import memoize from "memoizee";
import { identityProviderRepository } from "../repositories/identityProviderRepository";
import { encrypt, decrypt } from "./encryption";
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
    const encrypted = await encrypt(data.clientSecret);
    return identityProviderRepository.create({
      ...data,
      clientSecret: encrypted,
    });
  }

  async updateProvider(id: string, data: UpdateIdentityProvider): Promise<IdentityProvider | undefined> {
    const updateData = { ...data };
    if (data.clientSecret) {
      updateData.clientSecret = await encrypt(data.clientSecret);
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
  ): Promise<{ externalId: string; email?: string; claims: Record<string, unknown> }> {
    const provider = await identityProviderRepository.getById(providerId);
    if (!provider) throw new Error("Identity provider not found");

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
      const externalId = claims.sub as string;
      const email = claims.email as string | undefined;
      return { externalId, email, claims };
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
    const externalId = (claims.sub || claims.id) as string;
    const email = claims.email as string | undefined;
    return { externalId, email, claims };
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
   */
  async checkIdentityStatus(
    userId: string,
    providerId: string,
  ): Promise<{ linked: boolean; expired: boolean; identity?: UserExternalIdentity }> {
    const identity = await identityProviderRepository.getExternalIdentity(userId, providerId);
    if (!identity) return { linked: false, expired: false };

    const provider = await identityProviderRepository.getById(providerId);
    if (!provider) return { linked: false, expired: false };

    if (provider.reverificationDays != null && identity.verifiedAt) {
      const expiresAt = new Date(identity.verifiedAt);
      expiresAt.setDate(expiresAt.getDate() + provider.reverificationDays);
      if (new Date() > expiresAt) {
        return { linked: true, expired: true, identity };
      }
    }

    return { linked: true, expired: false, identity };
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
}

export const identityService = new IdentityService();
