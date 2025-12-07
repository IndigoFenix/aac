import { createCipheriv, createDecipheriv, randomBytes, scrypt } from 'crypto';
import { promisify } from 'util';

const scryptAsync = promisify(scrypt);

// Get encryption key from environment
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'fallback-key-for-dev-only-32chars';

/**
 * Encrypts text using AES-256-GCM
 */
export async function encrypt(text: string): Promise<string> {
  try {
    // Create a key from the encryption key
    const key = await scryptAsync(ENCRYPTION_KEY, 'salt', 32) as Buffer;
    
    // Generate random IV
    const iv = randomBytes(16);
    
    // Create cipher
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    
    // Encrypt the text
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    
    // Get the authentication tag
    const authTag = cipher.getAuthTag();
    
    // Combine IV, authTag, and encrypted data
    const result = iv.toString('hex') + ':' + authTag.toString('hex') + ':' + encrypted;
    
    return result;
  } catch (error) {
    console.error('Encryption error:', error);
    throw new Error('Failed to encrypt data');
  }
}

/**
 * Decrypts text using AES-256-GCM
 */
export async function decrypt(encryptedData: string): Promise<string> {
  try {
    // Split the encrypted data
    const parts = encryptedData.split(':');
    if (parts.length !== 3) {
      throw new Error('Invalid encrypted data format');
    }
    
    const iv = Buffer.from(parts[0], 'hex');
    const authTag = Buffer.from(parts[1], 'hex');
    const encrypted = parts[2];
    
    // Create a key from the encryption key
    const key = await scryptAsync(ENCRYPTION_KEY, 'salt', 32) as Buffer;
    
    // Create decipher
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    
    // Decrypt the text
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    
    return decrypted;
  } catch (error) {
    console.error('Decryption error:', error);
    throw new Error('Failed to decrypt data');
  }
}

/**
 * Generates a cryptographically secure random string for PKCE
 */
export function generatePKCEVerifier(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Creates a PKCE challenge from a verifier
 */
export async function createPKCEChallenge(verifier: string): Promise<string> {
  const { createHash } = await import('crypto');
  return createHash('sha256').update(verifier).digest('base64url');
}