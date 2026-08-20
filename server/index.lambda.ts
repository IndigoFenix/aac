// server/index.lambda.ts
// Lambda entry point - loads secrets before starting the app

import { loadAwsSecrets } from './config/aws-secrets';

// Main startup
async function main() {
  try {
    // MUST load secrets before importing anything that uses DATABASE_URL.
    // Lambda's Terraform env is minimal, so keys in the secret override it
    // (historical behaviour — which is why stale SMTP_*/EMAIL_* keys in the
    // secret shadow EMAIL_FROM here; see lambda.tf).
    if (process.env.DATABASE_URL) {
      console.log('DATABASE_URL already set, skipping Secrets Manager');
    } else {
      await loadAwsSecrets({ override: true });
    }

    // Now dynamically import the app (db.ts will now have DATABASE_URL)
    // We import app.lambda.ts which has Lambda-specific adjustments
    await import('./app.lambda');
  } catch (error) {
    console.error('Failed to start Lambda:', error);
    throw error;
  }
}

main();
