// server/index.lambda.ts
// Lambda entry point - loads secrets before starting the app

import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

async function loadSecrets(): Promise<void> {
  // Skip if DATABASE_URL already exists (local dev or ECS)
  if (process.env.DATABASE_URL) {
    console.log('DATABASE_URL already set, skipping Secrets Manager');
    return;
  }

  const databaseSecretArn = process.env.DATABASE_SECRET_ARN;
  const appSecretsArn = process.env.APP_SECRETS_ARN;
  const region = process.env.AWS_SECRETS_REGION || process.env.AWS_REGION || 'il-central-1';

  if (!databaseSecretArn || !appSecretsArn) {
    throw new Error('DATABASE_SECRET_ARN and APP_SECRETS_ARN must be set in Lambda mode');
  }

  console.log('Loading secrets from AWS Secrets Manager...');
  
  const client = new SecretsManagerClient({ region });

  // Fetch database secrets
  const dbResponse = await client.send(
    new GetSecretValueCommand({ SecretId: databaseSecretArn })
  );
  const dbSecrets = JSON.parse(dbResponse.SecretString || '{}');
  
  // Fetch app secrets
  const appResponse = await client.send(
    new GetSecretValueCommand({ SecretId: appSecretsArn })
  );
  const appSecrets = JSON.parse(appResponse.SecretString || '{}');

  // Set environment variables BEFORE any other imports
  if (dbSecrets.DATABASE_URL) {
    process.env.DATABASE_URL = dbSecrets.DATABASE_URL;
    console.log('DATABASE_URL loaded from Secrets Manager');
  } else {
    throw new Error('DATABASE_URL not found in database secret');
  }

  // Set all app secrets as environment variables
  Object.entries(appSecrets).forEach(([key, value]) => {
    if (value && typeof value === 'string') {
      process.env[key] = value;
    }
  });

  console.log('All secrets loaded successfully');
}

// Main startup
async function main() {
  try {
    // MUST load secrets before importing anything that uses DATABASE_URL
    await loadSecrets();
    
    // Now dynamically import the app (db.ts will now have DATABASE_URL)
    // We import app.lambda.ts which has Lambda-specific adjustments
    await import('./app.lambda');
  } catch (error) {
    console.error('Failed to start Lambda:', error);
    throw error;
  }
}

main();
