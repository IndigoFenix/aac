import { encrypt, decrypt } from './encryption';
import { db } from '../db';
import { dropboxConnections, dropboxBackups } from '@shared/schema';
import { eq } from 'drizzle-orm';

export interface DropboxTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
}

export interface DropboxUploadResult {
  path: string;
  url?: string;
  rev: string;
  size: number;
  fileId?: string;
}

export interface DropboxAccountInfo {
  accountId: string;
  email: string;
  displayName: string;
}

export class DropboxService {
  private clientId: string;
  private clientSecret: string;
  private maxFileSize = 150 * 1024 * 1024; // 150MB

  constructor() {
    this.clientId = process.env.DROPBOX_CLIENT_ID || '';
    this.clientSecret = process.env.DROPBOX_CLIENT_SECRET || '';
    
    if (!this.clientId || !this.clientSecret) {
      console.warn('Dropbox credentials not configured. Dropbox functionality will be disabled. Set DROPBOX_CLIENT_ID and DROPBOX_CLIENT_SECRET environment variables to enable.');
    }
  }

  private checkCredentials(): void {
    if (!this.clientId || !this.clientSecret) {
      throw new Error('Dropbox credentials not configured. Set DROPBOX_CLIENT_ID and DROPBOX_CLIENT_SECRET environment variables.');
    }
  }

  /**
   * Exchange authorization code for access tokens
   */
  async exchangeCodeForTokens(code: string, codeVerifier: string, redirectUri: string): Promise<DropboxTokens> {
    this.checkCredentials();
    const tokenUrl = 'https://api.dropboxapi.com/oauth2/token';
    
    const params = new URLSearchParams({
      code,
      grant_type: 'authorization_code',
      client_id: this.clientId,
      client_secret: this.clientSecret,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier
    });

    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString()
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Token exchange failed: ${error}`);
    }

    const data = await response.json();
    
    const expiresAt = new Date();
    expiresAt.setSeconds(expiresAt.getSeconds() + data.expires_in);

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt
    };
  }

  /**
   * Refresh access token using refresh token
   */
  async refreshAccessToken(refreshToken: string): Promise<DropboxTokens> {
    const tokenUrl = 'https://api.dropboxapi.com/oauth2/token';
    
    const params = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: this.clientId,
      client_secret: this.clientSecret
    });

    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString()
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Token refresh failed: ${error}`);
    }

    const data = await response.json();
    
    const expiresAt = new Date();
    expiresAt.setSeconds(expiresAt.getSeconds() + data.expires_in);

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token || refreshToken, // Some providers don't return new refresh token
      expiresAt
    };
  }

  /**
   * Get current user account information
   */
  async getAccountInfo(accessToken: string): Promise<DropboxAccountInfo> {
    const response = await fetch('https://api.dropboxapi.com/2/users/get_current_account', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`
      }
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to get account info: ${error}`);
    }

    const data = await response.json();
    
    return {
      accountId: data.account_id,
      email: data.email,
      displayName: data.name.display_name
    };
  }

  /**
   * Ensure folder exists, create if not
   */
  async ensureFolderExists(accessToken: string, folderPath: string): Promise<void> {
    try {
      // Check if folder exists
      const response = await fetch('https://api.dropboxapi.com/2/files/get_metadata', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          path: folderPath
        })
      });

      if (response.ok) {
        return; // Folder exists
      }

      // Create folder
      await fetch('https://api.dropboxapi.com/2/files/create_folder_v2', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          path: folderPath,
          autorename: false
        })
      });
    } catch (error) {
      console.error('Error ensuring folder exists:', error);
      // Continue anyway, upload will create parent folders if needed
    }
  }

  /**
   * Upload file to Dropbox
   */
  async uploadFile(
    accessToken: string,
    filePath: string,
    fileData: Buffer,
    options: { overwrite?: boolean; autorename?: boolean } = {}
  ): Promise<DropboxUploadResult> {
    const fileSize = fileData.length;

    if (fileSize > this.maxFileSize) {
      throw new Error(`File size ${fileSize} bytes exceeds maximum allowed size of ${this.maxFileSize} bytes`);
    }

    // Use overwrite mode so re-exporting the same board replaces the existing file
    const mode = options.overwrite ? 'overwrite' : 'add';

    // For files under 150MB, use simple upload
    const response = await fetch('https://content.dropboxapi.com/2/files/upload', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/octet-stream',
        'Dropbox-API-Arg': JSON.stringify({
          path: filePath,
          mode,
          autorename: options.autorename ?? false,
          mute: false,
          strict_conflict: false
        })
      },
      body: fileData
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Upload failed: ${error}`);
    }

    const result = await response.json();

    return {
      path: result.path_lower,
      rev: result.rev,
      size: result.size,
      fileId: result.id
    };
  }

  /**
   * Create shareable link for uploaded file
   */
  async createShareableLink(accessToken: string, filePath: string): Promise<string> {
    try {
      const response = await fetch('https://api.dropboxapi.com/2/sharing/create_shared_link_with_settings', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          path: filePath,
          settings: {
            audience: 'public',
            access: 'viewer',
            requested_visibility: 'public'
          }
        })
      });

      if (response.ok) {
        const data = await response.json();
        return data.url;
      }

      // If link already exists, try to get existing link
      const listResponse = await fetch('https://api.dropboxapi.com/2/sharing/list_shared_links', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          path: filePath,
          direct_only: true
        })
      });

      if (listResponse.ok) {
        const listData = await listResponse.json();
        if (listData.links && listData.links.length > 0) {
          return listData.links[0].url;
        }
      }

      throw new Error('Failed to create or retrieve shareable link');
    } catch (error) {
      console.error('Error creating shareable link:', error);
      return ''; // Return empty string if link creation fails
    }
  }

  /**
   * Store encrypted tokens in database
   */
  async storeUserTokens(
    userId: string, 
    tokens: DropboxTokens, 
    accountInfo: DropboxAccountInfo,
    folderPath?: string
  ): Promise<void> {
    
    const encryptedAccessToken = await encrypt(tokens.accessToken);
    const encryptedRefreshToken = tokens.refreshToken ? await encrypt(tokens.refreshToken) : null;

    // Check if connection exists
    const [existingConnection] = await db
      .select()
      .from(dropboxConnections)
      .where(eq(dropboxConnections.userId, userId));

    if (existingConnection) {
      // Update existing connection
      await db
        .update(dropboxConnections)
        .set({
          dropboxAccountId: accountInfo.accountId,
          dropboxEmail: accountInfo.email,
          encryptedAccessToken,
          encryptedRefreshToken,
          tokenExpiresAt: tokens.expiresAt,
          backupFolderPath: folderPath || existingConnection.backupFolderPath,
          updatedAt: new Date()
        })
        .where(eq(dropboxConnections.userId, userId));
    } else {
      // Create new connection
      await db
        .insert(dropboxConnections)
        .values({
          userId,
          dropboxAccountId: accountInfo.accountId,
          dropboxEmail: accountInfo.email,
          encryptedAccessToken,
          encryptedRefreshToken,
          tokenExpiresAt: tokens.expiresAt,
          backupFolderPath: folderPath || '/Apps/SyntAACx/Backups'
        });
    }
  }

  /**
   * Get and refresh user tokens if needed
   */
  async getUserTokens(userId: string): Promise<{ accessToken: string; connection: any } | null> {
    const [connection] = await db
      .select()
      .from(dropboxConnections)
      .where(eq(dropboxConnections.userId, userId));

    if (!connection) {
      return null;
    }

    if (!connection.encryptedAccessToken) {
      throw new Error('No access token found for user Dropbox connection');
    }

    let accessToken = await decrypt(connection.encryptedAccessToken);
    
    // Check if token needs refresh. Treat a missing expiry as already-expired
    // (force refresh) rather than crashing on the Date constructor.
    const now = new Date();
    const expiresAt = connection.tokenExpiresAt
      ? new Date(connection.tokenExpiresAt)
      : new Date(0);
    
    if (expiresAt <= now) {
      // Token expired, refresh it
      const refreshToken = await decrypt(connection.encryptedRefreshToken!);
      const newTokens = await this.refreshAccessToken(refreshToken);
      
      // Update stored tokens
      const encryptedAccessToken = await encrypt(newTokens.accessToken);
      const encryptedRefreshToken = await encrypt(newTokens.refreshToken);
      
      await db
        .update(dropboxConnections)
        .set({
          encryptedAccessToken,
          encryptedRefreshToken,
          tokenExpiresAt: newTokens.expiresAt,
          updatedAt: new Date()
        })
        .where(eq(dropboxConnections.userId, userId));
      
      accessToken = newTokens.accessToken;
    }

    return { accessToken, connection };
  }

  /**
   * Delete user connection and all associated data
   */
  async deleteUserConnection(userId: string): Promise<void> {
    // Delete backups first (due to foreign key)
    await db
      .delete(dropboxBackups)
      .where(eq(dropboxBackups.userId, userId));
    
    // Delete connection
    await db
      .delete(dropboxConnections)
      .where(eq(dropboxConnections.userId, userId));
  }

  /**
   * Generate file path — flat structure under the backup folder (no date subfolders)
   * so that re-uploading the same board name overwrites the previous file.
   */
  generateFilePath(baseFolderPath: string, fileName: string): string {
    return `${baseFolderPath}/${fileName}`;
  }

  /**
   * List .gridset files in the user's Dropbox backup folder
   */
  async listFiles(
    accessToken: string,
    folderPath: string,
    extensions?: string[]
  ): Promise<{ name: string; path: string; size: number; modified: string }[]> {
    const response = await fetch('https://api.dropboxapi.com/2/files/list_folder', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        path: folderPath,
        recursive: true,
        limit: 200
      })
    });

    if (!response.ok) {
      const error = await response.text();
      // If folder doesn't exist, return empty list
      if (error.includes('path/not_found')) {
        return [];
      }
      throw new Error(`List files failed: ${error}`);
    }

    const data = await response.json();
    const entries: any[] = data.entries || [];

    return entries
      .filter((e: any) => {
        if (e['.tag'] !== 'file') return false;
        if (!extensions || extensions.length === 0) return true;
        return extensions.some(ext => e.name.toLowerCase().endsWith(`.${ext}`));
      })
      .map((e: any) => ({
        name: e.name,
        path: e.path_lower,
        size: e.size,
        modified: e.client_modified || e.server_modified
      }));
  }

  /**
   * Download a file from Dropbox and return the raw buffer
   */
  async downloadFile(accessToken: string, filePath: string): Promise<Buffer> {
    const response = await fetch('https://content.dropboxapi.com/2/files/download', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Dropbox-API-Arg': JSON.stringify({ path: filePath })
      }
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Download failed: ${error}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }
}