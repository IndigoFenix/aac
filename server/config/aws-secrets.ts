// server/config/aws-secrets.ts
// Loads the database + app secrets from AWS Secrets Manager into process.env.
// Shared by both AWS entry points (index.lambda.ts, index.prod.ts) so a key
// added to the `app-secrets` JSON reaches the server on either path without a
// Terraform change.
//
// MUST run before any module that reads process.env at import time (db.ts
// reads DATABASE_URL when it is first imported) — callers dynamically import
// the app after awaiting this.

import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

export interface LoadAwsSecretsOptions {
  /**
   * Whether a key in the secret replaces a value already present in
   * process.env. Lambda historically overrode (its Terraform env is minimal);
   * ECS sets its operational env (EMAIL_FROM, APP_URL, REALTIME_BUS, ...) in
   * the task definition and must keep it, so it passes `false`.
   */
  override: boolean;
  log?: (message: string) => void;
  /** Test seam: returns the raw SecretString for an ARN. Defaults to Secrets Manager. */
  fetchSecret?: (secretId: string) => Promise<string | undefined>;
}

/**
 * Returns true when secrets were loaded, false when skipped because the
 * process already had DATABASE_URL (local dev, docker-compose, Render).
 * Throws when the ARNs are missing or the database secret lacks DATABASE_URL.
 */
export async function loadAwsSecrets(opts: LoadAwsSecretsOptions): Promise<boolean> {
  const log = opts.log ?? ((m: string) => console.log(m));

  const databaseSecretArn = process.env.DATABASE_SECRET_ARN;
  const appSecretsArn = process.env.APP_SECRETS_ARN;

  if (!databaseSecretArn && !appSecretsArn) {
    if (process.env.DATABASE_URL) {
      log('No Secrets Manager ARNs configured; using process environment as-is');
      return false;
    }
    throw new Error('DATABASE_SECRET_ARN and APP_SECRETS_ARN must be set when DATABASE_URL is absent');
  }

  const fetchSecret = opts.fetchSecret ?? (() => {
    const region = process.env.AWS_SECRETS_REGION || process.env.AWS_REGION || 'il-central-1';
    const client = new SecretsManagerClient({ region });
    return async (secretId: string) =>
      (await client.send(new GetSecretValueCommand({ SecretId: secretId }))).SecretString;
  })();

  log('Loading secrets from AWS Secrets Manager...');

  const fetchJson = async (secretId: string): Promise<Record<string, unknown>> =>
    JSON.parse((await fetchSecret(secretId)) || '{}');

  let applied = 0;
  let kept = 0;
  const apply = (key: string, value: unknown) => {
    if (value === null || value === undefined || value === '') return;
    // A secret value can legitimately be an OBJECT. GOOGLE_APPLICATION_CREDENTIALS_JSON
    // is a service-account key, and the natural way to paste one into the AWS
    // console is as nested JSON — at which point `typeof value === "string"` is
    // false and the key was silently DROPPED. Vertex then fell back to ADC, which
    // does not exist in Lambda or ECS, so Gemini quietly downgraded to the AI
    // Studio API key. That downgrade is precisely the failure this whole change
    // exists to remove, so serialize rather than skip.
    const str = typeof value === 'string' ? value : JSON.stringify(value);
    if (process.env[key] !== undefined && !opts.override) {
      kept++;
      return;
    }
    process.env[key] = str;
    applied++;
  };

  if (databaseSecretArn) {
    const dbSecrets = await fetchJson(databaseSecretArn);
    if (!dbSecrets.DATABASE_URL && !process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL not found in database secret');
    }
    // DATABASE_URL is special-cased: the database secret is authoritative on
    // Lambda, while ECS may already inject it via the task definition.
    apply('DATABASE_URL', dbSecrets.DATABASE_URL);
  }

  if (appSecretsArn) {
    const appSecrets = await fetchJson(appSecretsArn);
    for (const [key, value] of Object.entries(appSecrets)) apply(key, value);
  }

  log(`Secrets loaded: ${applied} applied${kept ? `, ${kept} kept from environment` : ''}`);
  return true;
}
