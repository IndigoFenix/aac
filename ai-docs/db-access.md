# Database access (staging + production) — for AI agents and scripts

How to reach the two live databases from this repo, what always goes wrong,
and the safety rules. Written 2026-08-31 after a long compliance session that
exercised every path below.

## The two databases

| | Where | How to reach it |
|---|---|---|
| **Staging** | AWS RDS `aac-test`, us-east-2 (Ohio) | `DATABASE_URL` in `.env` — **`.env` IS staging.** Direct TLS, no tunnel. |
| **Production** | AWS RDS `aivota-prod-postgres`, il-central-1 | SSM tunnel (below) + credentials from Secrets Manager. |

The jest test DB is a third thing: `TEST_DATABASE_URL` (see
`server/tests/global-setup.ts`), which the integration config migrates itself.
Never point a test at `.env`'s `DATABASE_URL` — that is real staging data.

## Production: the tunnel

There is no VPN and no SSH. The bastion has **no ingress rules and no key
pair** — the only path is AWS SSM Session Manager, authenticated by IAM:

```bash
npm run db-tunnel        # scripts/db-tunnel.sh — leave running in its own terminal
```

That discovers the bastion by tag (`Name=aivota-prod-bastion`), the RDS
endpoint by instance id, and port-forwards `localhost:5432 →
aivota-prod-postgres:5432` via `AWS-StartPortForwardingSessionToRemoteHost`.
Requires the `aac` AWS profile and the Session Manager plugin (both installed
on the dev box). **An agent cannot open the tunnel for the user in a useful
way — it must stay running. Ask the user to open it**, then verify with a TCP
probe before doing work:

```bash
(exec 3<>/dev/tcp/127.0.0.1/5432) 2>/dev/null && echo OPEN || echo CLOSED
```

`ECONNREFUSED` mid-script means the tunnel dropped — ask the user to reopen
it; do not retry in a loop.

## Production: credentials + TLS (the part everyone gets wrong)

Credentials come from Secrets Manager (never from `.env`):

```js
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
process.env.AWS_PROFILE ||= "aac";
const sm = new SecretsManagerClient({ region: "il-central-1" });
// canonical id first; older scripts also try aivota-prod-database-credentials, aivota-prod-db
const r = await sm.send(new GetSecretValueCommand({ SecretId: "aivota-prod/database" }));
const u = new URL(JSON.parse(r.SecretString).DATABASE_URL);
u.hostname = "localhost";          // through the tunnel
u.searchParams.delete("sslmode");  // we pass ssl config explicitly
```

TLS through the tunnel — this exact shape, no other works:

```js
import fs from "fs";
const CA = fs.readFileSync("rds-ca-bundle.pem", "utf8"); // repo root; AWS GLOBAL bundle
new pg.Client({ connectionString: u.toString(),
  ssl: { ca: CA, checkServerIdentity: () => undefined } });
```

Why: `rds.force_ssl = 1`, so `ssl: false` is rejected
(`no pg_hba.conf entry ... no encryption`); full verification fails because
the tunnel presents the RDS certificate on `localhost` (hostname mismatch).
So: verify the **chain** against the CA, relax only the **hostname** check.
Staging is direct (no tunnel), so plain `ssl: { ca: CA }` works there.

Working examples to copy: `scripts/migrate-sessions-to-prod.ts` (both
connections, dry-run flags, verified deletes), `scripts/db-tunnel.sh`,
`scripts/dr-restore-drill.ts` (tunnel to a non-default local port).

## Gotchas that have burned sessions

- **A pg error can have an empty `.message`** — the substance is in `.code`
  and `.detail`. Always print both, or a real failure reads as `FAILED:` with
  nothing after it.
- **One-off `.mjs` scripts must run from the repo root** (`node` resolves
  `pg` from `node_modules` relative to the script). A script written to a
  temp/scratchpad dir fails with `ERR_MODULE_NOT_FOUND` — copy it to
  `./.something.tmp.mjs`, run, delete.
- **jsonb rows must never round-trip through JS objects** when copying
  between databases — node-pg mangles them on re-insert. Use
  `row_to_json(t)::text` on the way out and
  `json_populate_record(null::table, $1::json)` on the way in.
- **Port 5432 belongs to the tunnel.** Anything opening its own forward (the
  DR drill) must use another local port (the drill refuses 5432).
- **IAM auth exists as an alternative** for humans: DB user
  `aivota_engineer` (DML-only), token via
  `aws rds generate-db-auth-token` minted against the **real RDS hostname**
  (not localhost) — see `docs/INFRASTRUCTURE.md` "Access & hardening".
  Scripts stay on the Secrets Manager password.

## Safety rules (non-negotiable)

- **Dry-run by default.** Any script that writes takes an explicit `--apply`;
  any delete refuses unless the copy is verified present at the destination
  (count AND content-hash, not count alone).
- **Never run `scripts/migrate.ts` unilaterally** — it migrates a LIVE
  database. Generating a migration (`npm run db:generate`) is fine; applying
  it is the user's call.
- **Staging holds real personal data** (pre-cutover history). Reads for
  diagnosis are fine; deleting or moving anything needs the user's explicit
  per-account decision — precedent and per-user rulings are in the session
  memory and `docs/AKIM_REMEDIATION_PLAN.md`.
- Log what you did (ids, counts, hashes) to a file so the action is
  reconstructible.
