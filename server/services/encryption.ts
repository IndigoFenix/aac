import { createCipheriv, createDecipheriv, randomBytes, scrypt } from 'crypto';
import { promisify } from 'util';

const scryptAsync = promisify(scrypt);

// Get encryption key from environment. The dev fallback only applies outside
// production; assertRequiredSecrets() (called at prod startup) refuses to boot
// if ENCRYPTION_KEY is unset or left at this fallback in production.
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'fallback-key-for-dev-only-32chars';

// Legacy ciphertext (3-part `iv:authTag:ciphertext`) was keyed with a constant
// scrypt salt. New ciphertext uses a per-record random salt stored in the
// envelope (`iv:salt:authTag:ciphertext`), so a precompute against the constant
// salt no longer targets every record/deployment. Decrypt accepts both formats.
const LEGACY_SALT = 'salt';

/**
 * Encrypts text using AES-256-GCM with a per-record random scrypt salt.
 * Output format: `iv:salt:authTag:ciphertext` (all hex).
 */
export async function encrypt(text: string): Promise<string> {
  try {
    // Per-record random salt for the scrypt KDF.
    const salt = randomBytes(16);
    const key = await scryptAsync(ENCRYPTION_KEY, salt, 32) as Buffer;

    // Generate random IV
    const iv = randomBytes(16);

    // Create cipher
    const cipher = createCipheriv('aes-256-gcm', key, iv);

    // Encrypt the text
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');

    // Get the authentication tag
    const authTag = cipher.getAuthTag();

    // Combine IV, salt, authTag, and encrypted data
    return (
      iv.toString('hex') + ':' + salt.toString('hex') + ':' + authTag.toString('hex') + ':' + encrypted
    );
  } catch (error) {
    console.error('Encryption error:', error);
    throw new Error('Failed to encrypt data');
  }
}

/**
 * Decrypts text using AES-256-GCM. Accepts the current 4-part format
 * (`iv:salt:authTag:ciphertext`) and the legacy 3-part format
 * (`iv:authTag:ciphertext`, constant salt) for backward compatibility.
 */
export async function decrypt(encryptedData: string): Promise<string> {
  try {
    const parts = encryptedData.split(':');

    let iv: Buffer;
    let saltOrLegacy: Buffer | string;
    let authTag: Buffer;
    let encrypted: string;

    if (parts.length === 4) {
      iv = Buffer.from(parts[0], 'hex');
      saltOrLegacy = Buffer.from(parts[1], 'hex');
      authTag = Buffer.from(parts[2], 'hex');
      encrypted = parts[3];
    } else if (parts.length === 3) {
      // Legacy records keyed with the constant salt.
      iv = Buffer.from(parts[0], 'hex');
      saltOrLegacy = LEGACY_SALT;
      authTag = Buffer.from(parts[1], 'hex');
      encrypted = parts[2];
    } else {
      throw new Error('Invalid encrypted data format');
    }

    const key = await scryptAsync(ENCRYPTION_KEY, saltOrLegacy, 32) as Buffer;

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