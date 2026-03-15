import type { Express, Request } from "express";
import { DropboxService } from './dropboxService';
import { generatePKCEVerifier, createPKCEChallenge } from './encryption';
import { db } from '../db';
import { boards, dropboxConnections, dropboxBackups, User } from '@shared/schema';
import { eq, and, desc } from 'drizzle-orm';

interface AuthenticatedRequest extends Request {
  user?: User;
}

// PKCE state storage (in production, use Redis or database)
const pkceStates = new Map<string, { verifier: string; userId: string; timestamp: number }>();

// Clean up expired PKCE states every hour
setInterval(() => {
  const now = Date.now();
  const entries = Array.from(pkceStates.entries());
  for (const [key, value] of entries) {
    if (now - value.timestamp > 3600000) { // 1 hour
      pkceStates.delete(key);
    }
  }
}, 3600000);

export function registerDropboxRoutes(app: Express): void {
  const dropboxService = new DropboxService();

  /**
   * Start OAuth flow with PKCE
   */
  app.post("/api/integrations/dropbox/oauth/start", async (req: AuthenticatedRequest, res) => {
    if (!req.user) {
      return res.status(401).json({ error: "Authentication required" });
    }

    try {
      const verifier = generatePKCEVerifier();
      const challenge = await createPKCEChallenge(verifier);
      const state = generatePKCEVerifier(); // Use as state parameter

      // Store PKCE state
      pkceStates.set(state, {
        verifier,
        userId: req.user.id,
        timestamp: Date.now()
      });

      const clientId = process.env.DROPBOX_CLIENT_ID;
      const redirectUri = `${req.protocol}://${req.get('host')}/api/integrations/dropbox/oauth/callback`;

      const authUrl = new URL('https://www.dropbox.com/oauth2/authorize');
      authUrl.searchParams.append('client_id', clientId || '');
      authUrl.searchParams.append('redirect_uri', redirectUri);
      authUrl.searchParams.append('response_type', 'code');
      authUrl.searchParams.append('code_challenge', challenge);
      authUrl.searchParams.append('code_challenge_method', 'S256');
      authUrl.searchParams.append('state', state);
      authUrl.searchParams.append('scope', 'files.content.write files.content.read sharing.write account_info.read');

      res.json({ redirectUrl: authUrl.toString() });
    } catch (error) {
      console.error('OAuth start error:', error);
      res.status(500).json({ error: "Failed to start OAuth flow" });
    }
  });

  /**
   * Handle OAuth callback
   */
  app.get("/api/integrations/dropbox/oauth/callback", async (req, res) => {
    const { code, state, error: oauthError } = req.query;

    if (oauthError) {
      return res.redirect(`/?error=oauth_denied`);
    }

    if (!code || !state) {
      return res.redirect(`/?error=oauth_invalid`);
    }

    try {
      // Retrieve PKCE state
      const pkceState = pkceStates.get(state as string);
      if (!pkceState) {
        return res.redirect(`/?error=oauth_expired`);
      }

      // Clean up used state
      pkceStates.delete(state as string);

      const redirectUri = `${req.protocol}://${req.get('host')}/api/integrations/dropbox/oauth/callback`;

      // Exchange code for tokens
      const tokens = await dropboxService.exchangeCodeForTokens(
        code as string,
        pkceState.verifier,
        redirectUri
      );

      // Get account info
      const accountInfo = await dropboxService.getAccountInfo(tokens.accessToken);

      // Store tokens
      await dropboxService.storeUserTokens(pkceState.userId, tokens, accountInfo);

      res.redirect(`/?dropbox_connected=true`);
    } catch (error) {
      console.error('OAuth callback error:', error);
      res.redirect(`/?error=oauth_failed`);
    }
  });

  /**
   * Get Dropbox connection status
   */
  app.get("/api/integrations/dropbox/status", async (req: AuthenticatedRequest, res) => {
    if (!req.user) {
      return res.status(401).json({ error: "Authentication required" });
    }

    try {
      const [connection] = await db
        .select()
        .from(dropboxConnections)
        .where(eq(dropboxConnections.userId, req.user.id));

      if (!connection) {
        return res.json({ connected: false });
      }

      // Get last backup
      const [lastBackup] = await db
        .select()
        .from(dropboxBackups)
        .where(eq(dropboxBackups.userId, req.user.id))
        .orderBy(desc(dropboxBackups.createdAt))
        .limit(1);

      res.json({
        connected: true,
        email: connection.dropboxEmail,
        folderPath: connection.backupFolderPath,
        autoBackupEnabled: connection.autoBackupEnabled,
        lastBackup: lastBackup ? {
          fileName: lastBackup.fileName,
          createdAt: lastBackup.createdAt,
          status: lastBackup.status,
          shareableUrl: lastBackup.shareableUrl
        } : null
      });
    } catch (error) {
      console.error('Status check error:', error);
      res.status(500).json({ error: "Failed to get status" });
    }
  });

  /**
   * Update Dropbox settings
   */
  app.post("/api/integrations/dropbox/settings", async (req: AuthenticatedRequest, res) => {
    if (!req.user) {
      return res.status(401).json({ error: "Authentication required" });
    }

    try {
      const { folderPath, autoBackup } = req.body;

      if (!folderPath || typeof autoBackup !== 'boolean') {
        return res.status(400).json({ error: "Invalid settings data" });
      }

      // Update settings
      await db
        .update(dropboxConnections)
        .set({
          backupFolderPath: folderPath,
          autoBackupEnabled: autoBackup,
          updatedAt: new Date()
        })
        .where(eq(dropboxConnections.userId, req.user.id));

      res.json({ success: true });
    } catch (error) {
      console.error('Settings update error:', error);
      res.status(500).json({ error: "Failed to update settings" });
    }
  });

  /**
   * Upload board to Dropbox — uses overwrite mode so re-exporting replaces the file
   */
  app.post("/api/integrations/dropbox/upload", async (req: AuthenticatedRequest, res) => {
    if (!req.user) {
      return res.status(401).json({ error: "Authentication required" });
    }

    try {
      const { boardId, fileType, fileName, fileData } = req.body;

      if (!boardId || !fileType || !fileName || !fileData) {
        return res.status(400).json({ error: "Board ID, file type, file name, and file data required" });
      }

      // Validate file type
      const validTypes = ['gridset', 'snappkg', 'touchchat', 'obz', 'master_aac'];
      if (!validTypes.includes(fileType)) {
        return res.status(400).json({ error: "Invalid file type" });
      }

      // Get user tokens
      const userTokenResult = await dropboxService.getUserTokens(req.user.id);
      if (!userTokenResult) {
        return res.status(400).json({ error: "Dropbox not connected" });
      }

      const { accessToken, connection } = userTokenResult;

      // Convert base64 data to buffer
      const fileBuffer = Buffer.from(fileData, 'base64');

      // Generate full path (flat, so overwrite works by filename)
      const filePath = dropboxService.generateFilePath(connection.backupFolderPath, fileName);

      // Create backup record
      const [backupRecord] = await db
        .insert(dropboxBackups)
        .values({
          userId: req.user.id,
          boardName: boardId,
          fileType,
          fileName,
          dropboxPath: filePath,
          fileSizeBytes: fileBuffer.length,
          status: 'uploading'
        })
        .returning();

      const startTime = Date.now();

      try {
        // Ensure folder exists
        await dropboxService.ensureFolderExists(accessToken, connection.backupFolderPath);

        // Upload file with overwrite mode
        const uploadResult = await dropboxService.uploadFile(accessToken, filePath, fileBuffer, { overwrite: true });

        // Create shareable link
        const shareableUrl = await dropboxService.createShareableLink(accessToken, uploadResult.path);

        // Update backup record
        await db
          .update(dropboxBackups)
          .set({
            status: 'completed',
            dropboxFileId: uploadResult.fileId,
            shareableUrl,
            uploadDurationMs: Date.now() - startTime,
            completedAt: new Date()
          })
          .where(eq(dropboxBackups.id, backupRecord.id));

        res.json({
          success: true,
          path: uploadResult.path,
          url: shareableUrl,
          size: uploadResult.size,
          fileName
        });

      } catch (uploadError) {
        // Update backup record with error
        await db
          .update(dropboxBackups)
          .set({
            status: 'failed',
            errorMessage: (uploadError as Error).message,
            uploadDurationMs: Date.now() - startTime
          })
          .where(eq(dropboxBackups.id, backupRecord.id));

        throw uploadError;
      }

    } catch (error) {
      console.error('Upload error:', error);
      res.status(500).json({ error: (error as Error).message || "Upload failed" });
    }
  });

  /**
   * List .gridset files available in the user's Dropbox backup folder
   */
  app.get("/api/integrations/dropbox/files", async (req: AuthenticatedRequest, res) => {
    if (!req.user) {
      return res.status(401).json({ error: "Authentication required" });
    }

    try {
      const userTokenResult = await dropboxService.getUserTokens(req.user.id);
      if (!userTokenResult) {
        return res.status(400).json({ error: "Dropbox not connected" });
      }

      const { accessToken, connection } = userTokenResult;
      const files = await dropboxService.listFiles(accessToken, connection.backupFolderPath, ['gridset', 'obz']);

      res.json({ files });
    } catch (error) {
      console.error('List files error:', error);
      res.status(500).json({ error: (error as Error).message || "Failed to list files" });
    }
  });

  /**
   * Download a file from Dropbox (returns base64 data)
   */
  app.post("/api/integrations/dropbox/download", async (req: AuthenticatedRequest, res) => {
    if (!req.user) {
      return res.status(401).json({ error: "Authentication required" });
    }

    try {
      const { filePath } = req.body;
      if (!filePath) {
        return res.status(400).json({ error: "filePath required" });
      }

      const userTokenResult = await dropboxService.getUserTokens(req.user.id);
      if (!userTokenResult) {
        return res.status(400).json({ error: "Dropbox not connected" });
      }

      const { accessToken } = userTokenResult;
      const fileBuffer = await dropboxService.downloadFile(accessToken, filePath);

      res.json({ fileData: fileBuffer.toString('base64') });
    } catch (error) {
      console.error('Download error:', error);
      res.status(500).json({ error: (error as Error).message || "Download failed" });
    }
  });

  /**
   * Get last backup info for a specific board (by name)
   */
  app.get("/api/integrations/dropbox/board-status/:boardName", async (req: AuthenticatedRequest, res) => {
    if (!req.user) {
      return res.status(401).json({ error: "Authentication required" });
    }

    try {
      const { boardName } = req.params;
      const [lastBackup] = await db
        .select()
        .from(dropboxBackups)
        .where(
          and(
            eq(dropboxBackups.userId, req.user.id),
            eq(dropboxBackups.boardName, boardName),
            eq(dropboxBackups.status, 'completed')
          )
        )
        .orderBy(desc(dropboxBackups.createdAt))
        .limit(1);

      if (!lastBackup) {
        return res.json({ exported: false });
      }

      res.json({
        exported: true,
        lastExportedAt: lastBackup.completedAt || lastBackup.createdAt,
        fileName: lastBackup.fileName,
        shareableUrl: lastBackup.shareableUrl
      });
    } catch (error) {
      console.error('Board status error:', error);
      res.status(500).json({ error: "Failed to get board status" });
    }
  });

  /**
   * Disconnect Dropbox
   */
  app.delete("/api/integrations/dropbox/connection", async (req: AuthenticatedRequest, res) => {
    if (!req.user) {
      return res.status(401).json({ error: "Authentication required" });
    }

    try {
      await dropboxService.deleteUserConnection(req.user.id);
      res.json({ success: true });
    } catch (error) {
      console.error('Disconnect error:', error);
      res.status(500).json({ error: "Failed to disconnect" });
    }
  });

  /**
   * Get backup history
   */
  app.get("/api/integrations/dropbox/backups", async (req: AuthenticatedRequest, res) => {
    if (!req.user) {
      return res.status(401).json({ error: "Authentication required" });
    }

    try {
      const backups = await db
        .select({
          id: dropboxBackups.id,
          fileName: dropboxBackups.fileName,
          fileType: dropboxBackups.fileType,
          fileSizeBytes: dropboxBackups.fileSizeBytes,
          status: dropboxBackups.status,
          shareableUrl: dropboxBackups.shareableUrl,
          createdAt: dropboxBackups.createdAt,
          completedAt: dropboxBackups.completedAt,
          boardName: dropboxBackups.boardName
        })
        .from(dropboxBackups)
        .where(eq(dropboxBackups.userId, req.user.id))
        .orderBy(desc(dropboxBackups.createdAt))
        .limit(50);

      res.json({ backups });
    } catch (error) {
      console.error('Backup history error:', error);
      res.status(500).json({ error: "Failed to get backup history" });
    }
  });
}
