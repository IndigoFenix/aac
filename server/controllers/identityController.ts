import type { Request, Response } from "express";
import crypto from "crypto";
import { identityService } from "../services/identityService";
import { activityLogService } from "../services/activityLogService";
import { userRepository } from "../repositories";
import { insertIdentityProviderSchema, updateIdentityProviderSchema } from "@shared/schema";

const CALLBACK_BASE_URL = process.env.IDENTITY_CALLBACK_URL || process.env.APP_URL || "";

/**
 * After a successful SSO callback, when there's no current session, look up
 * the user by external identity and log them in. Returns the redirect URL
 * (success or error) for the caller to use. Used by both OIDC and SAML
 * callbacks so the unauthenticated SSO-login flow shares a single code path.
 */
async function loginViaExternalIdentity(
  req: Request,
  providerId: string,
  externalId: string,
  returnUrl: string,
): Promise<string> {
  const link = await identityService.findUserByExternalId(providerId, externalId);
  if (!link) {
    // No user has linked this external identity yet. We don't auto-create
    // — the user must register first, then link from their account.
    return `${returnUrl}?ssoError=no_account`;
  }
  const user = await userRepository.getUser(link.userId);
  if (!user) {
    return `${returnUrl}?ssoError=user_not_found`;
  }
  return new Promise<string>((resolve) => {
    (req as any).login(user, (err: Error | null) => {
      if (err) {
        console.error("SSO login error:", err);
        resolve(`${returnUrl}?ssoError=login_failed`);
        return;
      }
      activityLogService.log({
        userId: user.id,
        eventType: "auth_login_success",
        subjectType1: "user",
        subjectId1: user.id,
        details: {
          ip: req.ip,
          userAgent: req.get("user-agent") ?? null,
          sso: true,
          providerId,
        },
      });
      resolve(`${returnUrl}?ssoLoggedIn=true`);
    });
  });
}

export class IdentityController {
  // ==================== Public listing (for login page) ====================

  /**
   * GET /api/auth/identity-providers
   * Returns the list of active identity providers in a shape the login page
   * can render. Public — no auth required (the page is /login). Strips
   * secrets and any private OAuth/SAML config; only id, name, protocol, and
   * institute hint are returned.
   */
  async getPublicProviders(req: Request, res: Response): Promise<void> {
    try {
      const providers = await identityService.getActiveProviders();
      res.json({
        providers: providers.map((p) => ({
          id: p.id,
          name: p.name,
          protocol: p.protocol,
          instituteIdType: p.instituteIdType ?? null,
        })),
      });
    } catch (error: any) {
      console.error("Error fetching public identity providers:", error);
      res.status(500).json({ message: "Failed to fetch identity providers" });
    }
  }

  // ==================== Identity Status (for institute switching) ====================

  /**
   * GET /api/identity/status?instituteIdType=MOE
   * Check if the current user has a valid external identity for the given institute type.
   */
  async getStatus(req: Request, res: Response): Promise<void> {
    try {
      const user = req.user as any;
      const { instituteIdType } = req.query;

      if (!instituteIdType || typeof instituteIdType !== "string") {
        res.json({ required: false });
        return;
      }

      const provider = await identityService.getProviderByInstituteIdType(instituteIdType);
      if (!provider) {
        res.json({ required: false });
        return;
      }

      const status = await identityService.checkIdentityStatus(user.id, provider.id);

      res.json({
        required: true,
        linked: status.linked,
        expired: status.expired,
        expiresAt: status.expiresAt ? status.expiresAt.toISOString() : null,
        daysUntilExpiry: status.daysUntilExpiry,
        provider: {
          id: provider.id,
          name: provider.name,
          protocol: provider.protocol,
        },
      });
    } catch (error: any) {
      console.error("Error checking identity status:", error);
      res.status(500).json({ message: "Failed to check identity status" });
    }
  }

  /**
   * GET /api/identity/user
   * Get all external identities for the current user.
   */
  async getUserIdentities(req: Request, res: Response): Promise<void> {
    try {
      const user = req.user as any;
      const identities = await identityService.getUserIdentities(user.id);
      res.json({ identities });
    } catch (error: any) {
      console.error("Error fetching user identities:", error);
      res.status(500).json({ message: "Failed to fetch identities" });
    }
  }

  // ==================== OAuth/OIDC Linking Flow ====================

  /**
   * GET /api/identity/link/:providerId
   * Initiate the external identity linking flow.
   * Stores state in session and redirects to the provider.
   * Branches by protocol: OIDC/OAuth2 → authorization URL; SAML → AuthnRequest URL.
   */
  async initiateLink(req: Request, res: Response): Promise<void> {
    try {
      const { providerId } = req.params;
      const { returnUrl } = req.query;

      const provider = await identityService.getProvider(providerId);
      if (!provider) {
        res.status(404).json({ message: "Identity provider not found" });
        return;
      }

      const state = crypto.randomBytes(32).toString("hex");

      // Store state in session for CSRF verification on callback
      (req.session as any).identityLinkState = {
        state,
        providerId,
        returnUrl: typeof returnUrl === "string" ? returnUrl : "/",
      };

      let redirectTo: string;
      if (provider.protocol === "saml") {
        // RelayState carries our state token; IdP echoes it back on the ACS POST.
        redirectTo = await identityService.buildSamlLoginUrl(providerId, state);
      } else {
        const redirectUri = `${CALLBACK_BASE_URL}/api/identity/callback/${providerId}`;
        redirectTo = await identityService.getAuthorizationUrl(
          providerId,
          redirectUri,
          state,
        );
      }

      res.redirect(redirectTo);
    } catch (error: any) {
      console.error("Error initiating identity link:", error);
      res.status(500).json({ message: "Failed to initiate identity linking" });
    }
  }

  /**
   * POST /api/identity/saml/acs/:providerId
   * SAML Assertion Consumer Service. The IdP POSTs a form-encoded body
   * containing SAMLResponse and (optionally) RelayState. We verify the
   * RelayState against the session, validate the assertion, and link the
   * identity to the current user.
   */
  async handleSamlAcs(req: Request, res: Response): Promise<void> {
    const sessionState = (req.session as any).identityLinkState;
    const returnUrl = sessionState?.returnUrl || "/";
    delete (req.session as any).identityLinkState;

    try {
      const { providerId } = req.params;
      const user = req.user as any;

      const samlResponse = (req.body?.SAMLResponse ?? "") as string;
      const relayState = (req.body?.RelayState ?? "") as string;

      if (!samlResponse) {
        res.redirect(`${returnUrl}?identityError=missing_saml_response`);
        return;
      }

      // CSRF: RelayState must match the state we stored at initiation
      if (!sessionState || sessionState.state !== relayState || sessionState.providerId !== providerId) {
        res.redirect(`${returnUrl}?identityError=invalid_relay_state`);
        return;
      }

      const result = await identityService.handleSamlCallback(providerId, samlResponse);

      if (user) {
        // Authenticated → link external identity to current user.
        await identityService.linkIdentity(
          user.id,
          providerId,
          result.externalId,
          result.email,
          result.claims,
        );
        res.redirect(`${returnUrl}?identityLinked=true`);
      } else {
        // Unauthenticated → log in via existing external identity.
        const target = await loginViaExternalIdentity(req, providerId, result.externalId, returnUrl);
        res.redirect(target);
      }
    } catch (error: any) {
      console.error("Error handling SAML ACS:", error);
      res.redirect(`${returnUrl}?identityError=saml_validation_failed`);
    }
  }

  /**
   * GET /api/identity/saml/metadata/:providerId
   * Returns SP metadata XML for IdP onboarding. Public — no auth required.
   */
  async getSamlMetadata(req: Request, res: Response): Promise<void> {
    try {
      const { providerId } = req.params;
      const xml = await identityService.getSamlMetadata(providerId);
      res.setHeader("Content-Type", "application/xml; charset=utf-8");
      res.send(xml);
    } catch (error: any) {
      console.error("Error generating SAML metadata:", error);
      res.status(500).json({ message: "Failed to generate SAML metadata" });
    }
  }

  /**
   * GET /api/identity/saml/slo/:providerId?returnUrl=...
   * Initiate SP-initiated SAML Single Logout. Builds a signed
   * LogoutRequest URL and redirects the user to the IdP. The IdP will
   * eventually POST a LogoutResponse to our SLS endpoint.
   */
  async initiateSamlLogout(req: Request, res: Response): Promise<void> {
    try {
      const { providerId } = req.params;
      const { returnUrl } = req.query;
      const user = req.user as any;
      if (!user) {
        res.status(401).json({ message: "Authentication required" });
        return;
      }

      const state = crypto.randomBytes(32).toString("hex");
      (req.session as any).samlLogoutState = {
        state,
        providerId,
        returnUrl: typeof returnUrl === "string" ? returnUrl : "/",
      };

      const url = await identityService.buildSamlLogoutUrl(providerId, user.id, state);
      res.redirect(url);
    } catch (error: any) {
      console.error("Error initiating SAML logout:", error);
      res.status(500).json({ message: "Failed to initiate SAML logout" });
    }
  }

  /**
   * POST /api/identity/saml/sls/:providerId
   * SAML Single Logout Service. Receives the IdP's LogoutResponse after
   * we initiated SP-initiated logout, validates it, terminates our session.
   */
  async handleSamlSlo(req: Request, res: Response): Promise<void> {
    const sessionState = (req.session as any).samlLogoutState;
    const returnUrl = sessionState?.returnUrl || "/";
    delete (req.session as any).samlLogoutState;

    try {
      const { providerId } = req.params;
      const samlResponse = (req.body?.SAMLResponse ?? "") as string;
      const relayState = (req.body?.RelayState ?? "") as string;

      if (!samlResponse) {
        res.redirect(`${returnUrl}?logoutError=missing_saml_response`);
        return;
      }
      if (!sessionState || sessionState.state !== relayState || sessionState.providerId !== providerId) {
        res.redirect(`${returnUrl}?logoutError=invalid_relay_state`);
        return;
      }

      const loggedOut = await identityService.handleSamlLogoutCallback(providerId, samlResponse);
      if (!loggedOut) {
        res.redirect(`${returnUrl}?logoutError=idp_did_not_confirm`);
        return;
      }

      // Terminate the local session too. Use req.logout if available
      // (passport), then destroy the express session.
      const finishRedirect = () => {
        req.session?.destroy(() => {
          res.redirect(`${returnUrl}?loggedOut=true`);
        });
      };
      if (typeof (req as any).logout === "function") {
        (req as any).logout((err: Error | null) => {
          if (err) console.error("req.logout error during SAML SLO:", err);
          finishRedirect();
        });
      } else {
        finishRedirect();
      }
    } catch (error: any) {
      console.error("Error handling SAML SLO:", error);
      res.redirect(`${returnUrl}?logoutError=slo_validation_failed`);
    }
  }

  /**
   * GET /api/identity/callback/:providerId
   * Handle the OAuth/OIDC callback after the user authenticates with the external provider.
   */
  async handleCallback(req: Request, res: Response): Promise<void> {
    try {
      const { providerId } = req.params;
      const { error: oauthError, state } = req.query;
      const user = req.user as any;

      const sessionState = (req.session as any).identityLinkState;
      const returnUrl = sessionState?.returnUrl || "/";

      // Clean up session state
      delete (req.session as any).identityLinkState;

      if (oauthError) {
        res.redirect(`${returnUrl}?identityError=${encodeURIComponent(oauthError as string)}`);
        return;
      }

      // Verify state to prevent CSRF
      if (!sessionState || sessionState.state !== state || sessionState.providerId !== providerId) {
        res.redirect(`${returnUrl}?identityError=invalid_state`);
        return;
      }

      // Build the full callback URL including query params for openid-client
      const callbackUrl = new URL(
        `${CALLBACK_BASE_URL}/api/identity/callback/${providerId}`,
      );
      for (const [key, value] of Object.entries(req.query)) {
        if (typeof value === "string") callbackUrl.searchParams.set(key, value);
      }

      const result = await identityService.handleCallback(
        providerId,
        callbackUrl,
        sessionState.state,
      );

      if (user) {
        // Authenticated → link external identity to current user.
        await identityService.linkIdentity(
          user.id,
          providerId,
          result.externalId,
          result.email,
          result.claims,
        );
        res.redirect(`${returnUrl}?identityLinked=true`);
      } else {
        // Unauthenticated → log in via existing external identity.
        const target = await loginViaExternalIdentity(req, providerId, result.externalId, returnUrl);
        res.redirect(target);
      }
    } catch (error: any) {
      console.error("Error handling identity callback:", error);
      const sessionState = (req.session as any).identityLinkState;
      const returnUrl = sessionState?.returnUrl || "/";
      delete (req.session as any).identityLinkState;
      res.redirect(`${returnUrl}?identityError=callback_failed`);
    }
  }

  /**
   * DELETE /api/identity/link/:providerId
   * Unlink an external identity from the current user.
   */
  async unlinkIdentity(req: Request, res: Response): Promise<void> {
    try {
      const user = req.user as any;
      const { providerId } = req.params;

      const removed = await identityService.unlinkIdentity(user.id, providerId);
      if (!removed) {
        res.status(404).json({ message: "Identity link not found" });
        return;
      }
      res.json({ success: true });
    } catch (error: any) {
      console.error("Error unlinking identity:", error);
      res.status(500).json({ message: "Failed to unlink identity" });
    }
  }

  // ==================== Admin: Identity Provider CRUD ====================

  /**
   * GET /api/admin/identity-providers
   */
  async getProviders(req: Request, res: Response): Promise<void> {
    try {
      const providers = await identityService.getAllProviders();
      // Strip client secrets from response
      const safe = providers.map(({ clientSecret, ...rest }) => rest);
      res.json({ providers: safe });
    } catch (error: any) {
      console.error("Error fetching identity providers:", error);
      res.status(500).json({ message: "Failed to fetch identity providers" });
    }
  }

  /**
   * GET /api/admin/identity-providers/:id
   */
  async getProvider(req: Request, res: Response): Promise<void> {
    try {
      const provider = await identityService.getProvider(req.params.id);
      if (!provider) {
        res.status(404).json({ message: "Identity provider not found" });
        return;
      }
      // Strip client secret
      const { clientSecret, ...safe } = provider;
      res.json({ provider: safe });
    } catch (error: any) {
      console.error("Error fetching identity provider:", error);
      res.status(500).json({ message: "Failed to fetch identity provider" });
    }
  }

  /**
   * POST /api/admin/identity-providers
   */
  async createProvider(req: Request, res: Response): Promise<void> {
    try {
      const parsed = insertIdentityProviderSchema.parse(req.body);
      const provider = await identityService.createProvider(parsed);
      const { clientSecret, ...safe } = provider;
      res.status(201).json({ provider: safe });
    } catch (error: any) {
      if (error.name === "ZodError") {
        res.status(400).json({ message: "Invalid data", errors: error.errors });
        return;
      }
      console.error("Error creating identity provider:", error);
      res.status(500).json({ message: "Failed to create identity provider" });
    }
  }

  /**
   * PATCH /api/admin/identity-providers/:id
   */
  async updateProvider(req: Request, res: Response): Promise<void> {
    try {
      const parsed = updateIdentityProviderSchema.parse(req.body);
      const provider = await identityService.updateProvider(req.params.id, parsed);
      if (!provider) {
        res.status(404).json({ message: "Identity provider not found" });
        return;
      }
      const { clientSecret, ...safe } = provider;
      res.json({ provider: safe });
    } catch (error: any) {
      if (error.name === "ZodError") {
        res.status(400).json({ message: "Invalid data", errors: error.errors });
        return;
      }
      console.error("Error updating identity provider:", error);
      res.status(500).json({ message: "Failed to update identity provider" });
    }
  }

  /**
   * DELETE /api/admin/identity-providers/:id
   */
  async deleteProvider(req: Request, res: Response): Promise<void> {
    try {
      const removed = await identityService.deleteProvider(req.params.id);
      if (!removed) {
        res.status(404).json({ message: "Identity provider not found" });
        return;
      }
      res.json({ success: true });
    } catch (error: any) {
      console.error("Error deleting identity provider:", error);
      res.status(500).json({ message: "Failed to delete identity provider" });
    }
  }
}

export const identityController = new IdentityController();
