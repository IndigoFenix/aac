// server/config/env-guards.ts
// Fail-fast validation of security-critical environment variables.
//
// Several modules fall back to constant or process-ephemeral values when their
// secret env var is unset (so local dev "just works"). In production those
// fallbacks are dangerous: a committed constant lets an attacker forge session /
// MFA-challenge tokens or decrypt stored IdP secrets, and a per-process random
// MFA key locks every MFA user out on restart / multi-instance. This guard runs
// at production startup and refuses to boot if any required secret is missing or
// left at its insecure dev fallback.

/** Required secrets and the insecure dev fallback we must never run with in prod. */
const REQUIRED_SECRETS: Array<{ name: string; devFallback?: string; minLength?: number }> = [
  { name: "SESSION_SECRET", devFallback: "fallback-secret-key-for-dev" },
  { name: "ENCRYPTION_KEY", devFallback: "fallback-key-for-dev-only-32chars", minLength: 32 },
  // No constant fallback in code (it derives a per-process random key), but it
  // MUST be pinned in prod or stored MFA secrets become undecryptable on restart.
  { name: "MFA_ENCRYPTION_KEY" },
  { name: "MFA_TOKEN_SECRET", devFallback: "mfa-token-secret-fallback" },
];

/**
 * Throw if, in production, any security-critical secret is unset or equals its
 * insecure dev fallback. No-op outside production. Call once at startup, before
 * the server begins accepting traffic.
 */
export function assertRequiredSecrets(): void {
  if (process.env.NODE_ENV !== "production") return;

  const problems: string[] = [];
  for (const { name, devFallback, minLength } of REQUIRED_SECRETS) {
    const value = process.env[name];
    if (!value) {
      problems.push(`${name} is not set`);
      continue;
    }
    if (devFallback && value === devFallback) {
      problems.push(`${name} is set to its insecure dev fallback`);
    }
    if (minLength && value.length < minLength) {
      problems.push(`${name} must be at least ${minLength} characters`);
    }
  }

  if (problems.length > 0) {
    throw new Error(
      "Refusing to start in production — insecure secret configuration:\n  - " +
        problems.join("\n  - ") +
        "\nProvide these via AWS Secrets Manager / environment before deploying.",
    );
  }
}

/**
 * Non-fatal production config warnings. The consent gate (CONSENT_GATE_ENABLED)
 * is the lawful-basis enforcement for processing minors' PHI; when it is off in
 * production, AAC sessions / report writes / share creation proceed with NO
 * active consent record. We warn loudly rather than throw, because a legacy
 * backfill window may legitimately run with the gate off — but it must be a
 * deliberate, visible choice, not a silent default.
 */
export function warnOnInsecureProductionConfig(): void {
  if (process.env.NODE_ENV !== "production") return;
  if (process.env.CONSENT_GATE_ENABLED !== "true") {
    console.warn(
      "[SECURITY WARNING] CONSENT_GATE_ENABLED is not 'true' in production — " +
        "informed-consent enforcement is INERT. Minors' PHI can be processed " +
        "without an active consent record. Set CONSENT_GATE_ENABLED=true unless " +
        "you are deliberately running a consent backfill window.",
    );
  }
}
