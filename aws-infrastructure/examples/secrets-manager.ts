/**
 * AWS Secrets Manager Integration
 * 
 * This module provides utilities for fetching secrets from AWS Secrets Manager
 * Use this when you need to access secrets at runtime (not through ECS task definition)
 * 
 * File: server/lib/secrets.ts
 */

import { 
  SecretsManagerClient, 
  GetSecretValueCommand 
} from '@aws-sdk/client-secrets-manager';

// Initialize client - will use ECS task role automatically
const client = new SecretsManagerClient({
  region: process.env.AWS_REGION || 'il-central-1',
});

// Cache for secrets (to avoid repeated API calls)
const secretsCache = new Map<string, { value: string; expiresAt: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Fetch a secret from AWS Secrets Manager
 * Includes caching to reduce API calls
 */
export async function getSecret(secretId: string): Promise<string> {
  // Check cache first
  const cached = secretsCache.get(secretId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  try {
    const command = new GetSecretValueCommand({
      SecretId: secretId,
    });

    const response = await client.send(command);
    
    if (!response.SecretString) {
      throw new Error(`Secret ${secretId} has no string value`);
    }

    // Cache the result
    secretsCache.set(secretId, {
      value: response.SecretString,
      expiresAt: Date.now() + CACHE_TTL_MS,
    });

    return response.SecretString;
  } catch (error) {
    console.error(`Failed to fetch secret ${secretId}:`, error);
    throw error;
  }
}

/**
 * Fetch and parse a JSON secret
 */
export async function getJsonSecret<T = Record<string, string>>(
  secretId: string
): Promise<T> {
  const secretString = await getSecret(secretId);
  return JSON.parse(secretString) as T;
}

/**
 * Get a specific key from a JSON secret
 */
export async function getSecretKey(
  secretId: string, 
  key: string
): Promise<string | undefined> {
  const secret = await getJsonSecret(secretId);
  return (secret as Record<string, string>)[key];
}

/**
 * Clear the secrets cache (useful for forcing refresh)
 */
export function clearSecretsCache(): void {
  secretsCache.clear();
}

/**
 * Example usage in your application:
 * 
 * // For secrets injected via ECS task definition (recommended):
 * // These will be available as environment variables automatically
 * const dbUrl = process.env.DATABASE_URL;
 * const openaiKey = process.env.OPENAI_API_KEY;
 * 
 * // For secrets you need to fetch at runtime:
 * import { getSecretKey } from './lib/secrets';
 * 
 * const environment = process.env.NODE_ENV === 'production' ? 'prod' : 'staging';
 * const secretId = `cliniaccian-${environment}/app-secrets`;
 * 
 * const jwtSecret = await getSecretKey(secretId, 'JWT_SECRET');
 */

// =============================================================================
// Configuration loading example
// =============================================================================

interface AppConfig {
  database: {
    url: string;
    host: string;
    port: number;
    name: string;
    user: string;
    password: string;
  };
  session: {
    secret: string;
  };
  openai: {
    apiKey: string;
  };
  jwt: {
    secret: string;
  };
}

/**
 * Load all application configuration
 * Prefers environment variables (from ECS task definition)
 * Falls back to Secrets Manager for missing values
 */
export async function loadConfig(): Promise<AppConfig> {
  const environment = process.env.NODE_ENV === 'production' ? 'prod' : 'staging';
  
  // If environment variables are set (from ECS), use them
  if (process.env.DATABASE_URL) {
    return {
      database: {
        url: process.env.DATABASE_URL,
        host: process.env.DB_HOST || '',
        port: parseInt(process.env.DB_PORT || '5432'),
        name: process.env.DB_NAME || '',
        user: process.env.DB_USER || '',
        password: process.env.DB_PASSWORD || '',
      },
      session: {
        secret: process.env.SESSION_SECRET || '',
      },
      openai: {
        apiKey: process.env.OPENAI_API_KEY || '',
      },
      jwt: {
        secret: process.env.JWT_SECRET || '',
      },
    };
  }

  // Otherwise, fetch from Secrets Manager (for local development)
  console.log('Loading configuration from Secrets Manager...');
  
  const dbSecrets = await getJsonSecret<{
    DATABASE_URL: string;
    DB_HOST: string;
    DB_PORT: string;
    DB_NAME: string;
    DB_USER: string;
    DB_PASSWORD: string;
  }>(`cliniaccian-${environment}/database`);

  const appSecrets = await getJsonSecret<{
    SESSION_SECRET: string;
    OPENAI_API_KEY: string;
    JWT_SECRET: string;
  }>(`cliniaccian-${environment}/app-secrets`);

  return {
    database: {
      url: dbSecrets.DATABASE_URL,
      host: dbSecrets.DB_HOST,
      port: parseInt(dbSecrets.DB_PORT),
      name: dbSecrets.DB_NAME,
      user: dbSecrets.DB_USER,
      password: dbSecrets.DB_PASSWORD,
    },
    session: {
      secret: appSecrets.SESSION_SECRET,
    },
    openai: {
      apiKey: appSecrets.OPENAI_API_KEY,
    },
    jwt: {
      secret: appSecrets.JWT_SECRET,
    },
  };
}
