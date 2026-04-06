import type { Request, Response } from "express";
import crypto from "crypto";
import { identityService } from "../services/identityService";
import { insertIdentityProviderSchema, updateIdentityProviderSchema } from "@shared/schema";

const CALLBACK_BASE_URL = process.env.IDENTITY_CALLBACK_URL || process.env.APP_URL || "";

export class IdentityController {
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
        provider: {
          id: provider.id,
          name: provider.name,
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
   */
  async initiateLink(req: Request, res: Response): Promise<void> {
    try {
      const { providerId } = req.params;
      const { returnUrl } = req.query;

      const state = crypto.randomBytes(32).toString("hex");
      const redirectUri = `${CALLBACK_BASE_URL}/api/identity/callback/${providerId}`;

      // Store state in session for verification
      (req.session as any).identityLinkState = {
        state,
        providerId,
        returnUrl: typeof returnUrl === "string" ? returnUrl : "/",
      };

      const authUrl = await identityService.getAuthorizationUrl(
        providerId,
        redirectUri,
        state,
      );

      res.redirect(authUrl);
    } catch (error: any) {
      console.error("Error initiating identity link:", error);
      res.status(500).json({ message: "Failed to initiate identity linking" });
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

      // Link the identity to the current user
      await identityService.linkIdentity(
        user.id,
        providerId,
        result.externalId,
        result.email,
        result.claims,
      );

      res.redirect(`${returnUrl}?identityLinked=true`);
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
