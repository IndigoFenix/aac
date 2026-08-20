// server/index.prod.ts
// Container (ECS / docker) entry point. Resolves secrets, then boots the app.
//
// Kept deliberately thin: db.ts reads DATABASE_URL at import time, so the
// real server (app.prod.ts) must be imported only after the environment is
// complete. esbuild inlines the dynamic import into the single bundle.

import 'dotenv/config';
import { loadAwsSecrets } from './config/aws-secrets';

async function main() {
  try {
    if (process.env.APP_SECRETS_ARN || process.env.DATABASE_SECRET_ARN) {
      // Values the task definition sets explicitly (EMAIL_FROM, APP_URL,
      // REALTIME_BUS, ALLOWED_ORIGINS, ...) win over keys in the secret.
      await loadAwsSecrets({ override: false });
    }
    await import('./app.prod');
  } catch (error) {
    console.error('Failed to start server:', error);
    // Let the orchestrator see the failure rather than a half-booted task.
    process.exit(1);
  }
}

main();
