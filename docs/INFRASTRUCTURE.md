# CliniAACian Infrastructure Documentation

## Overview

CliniAACian uses GitHub Actions workflows for CI/CD and Terraform for AWS infrastructure management. The system supports **two deployment modes**:

1. **ECS Mode** - Container-based deployment using AWS ECS Fargate
2. **Lambda Mode** - Serverless deployment using AWS Lambda + S3/CloudFront

**Production (`main`) runs in ECS Mode as of 2026-08-20.** Lambda Mode is kept as a
manual rollback path. `staging` is not deployed to AWS at all — it runs on Render.

### Profiles

The compute path and the security posture are chosen by a Terraform var-file
layered on the auto-loaded base `terraform/terraform.tfvars`:

| Profile | File | Workflow | Compute | Security |
|---|---|---|---|---|
| `ecs-lean` (**default**) | `terraform/ecs-lean.tfvars` | `deploy.yml` | ECS Fargate, 1 task, no Redis | WAF/CloudTrail/flow logs/endpoints **off** |
| `hipaa` | `terraform/hipaa.tfvars` | `deploy.yml` (dispatch, or change `DEFAULT_PROFILE`) | ECS Fargate, 2+ tasks + Redis | everything **on**, multi-AZ `db.t3.medium` |
| `lean` (legacy) | `terraform/lean.tfvars` | `deploy-lambda.yml` (dispatch only) | Lambda + API Gateway | off |

Switching `ecs-lean → hipaa` recreates nothing: flags flip and sizes grow in
place against the same state. Keep the email-authentication block identical in
all three files.

---

## Two Build Architectures

### 1. ECS Deployment (`deploy.yml`) — ACTIVE

**Architecture:**
```
Internet → CloudFront → S3 (landing, clinician SPA, /aac web build)
              ↓ /api/* /auth/* /ws/* /health
           api.aivota.ai → ALB → ECS Fargate → RDS PostgreSQL
           ↑                                 ↓
   packaged AAC clients (direct)        ElastiCache (hipaa profile)
```

**Components:**
- Server-only Docker image (`Dockerfile`, `server/index.prod.ts` → `app.prod.ts`) on ECS Fargate
- ALB with HTTPS (regional ACM cert: apex, `www`, `app`, `api`), 300s idle timeout
  so WebSockets/SSE survive, sticky cookies
- `api.<domain>` → ALB: CloudFront's origin **and** the host the packaged AAC
  clients bake in (their WebSockets never traverse the CDN)
- Static frontends stay on S3 + CloudFront (`frontend_via_cloudfront = true`);
  set it to `false` to have Express serve them from the image instead
- Secrets: the task loads the whole `app-secrets` JSON at boot
  (`server/config/aws-secrets.ts`) — add a key to the secret, redeploy, done.
  Values set in the task definition (`EMAIL_FROM`, `APP_URL`, `REALTIME_BUS`,
  `ALLOWED_ORIGINS`, …) win over keys in the secret.
- Migrations run in the new task at boot under a Postgres advisory lock; the ECS
  circuit breaker rolls back if the task never passes `/health`
- Interval crons (consent thresholds, activity-log retention, erasure sweep,
  spend thresholds, package-link reconcile) are scheduled from ONE place,
  `server/services/maintenanceCrons.ts`, which BOTH entrypoints (`server/index.ts`
  and `server/app.prod.ts`) call — the production entrypoint used to call none of
  them. Each run takes a cluster-wide Postgres advisory lock
  (`server/services/cron-lock.ts`) so only one of the 2–10 tasks does the work.
  A wiring test pins that both entrypoints call it. The EventBridge
  `/internal/run-crons` workaround is Lambda-only.
- `SESSION_IDLE_TIMEOUT_MINUTES` is passed to the task from
  `var.session_timeout_minutes` (30 under `hipaa`) and drives the clinician/admin
  automatic-logoff in `server/session-lifetime.ts`. The variable existed in every
  tfvars and was read by nothing until 2026-08-26.
- Auto-scaling `ecs_desired_count … ecs_autoscaling_max` on CPU/memory

**Deploy flow:** Terraform apply (profile) → build frontends → build/push image →
S3 sync + CloudFront invalidation → render new image onto the latest task-definition
revision → `wait-for-service-stability` → `GET api.<domain>/health`.

### 2. Lambda Deployment (`deploy-lambda.yml`) — LEGACY / ROLLBACK

**Architecture:**
```
Internet → CloudFront CDN → S3 (Static Frontend)
              ↓
           Lambda (API) → RDS PostgreSQL
```

**Components:**
- Static frontend served from S3 via CloudFront
- Lambda functions (container image) for API
- Function URL or API Gateway for invocation
- Two-phase deployment (build image first, then deploy)

**Best for:** Cost optimization, variable traffic patterns, pay-per-request pricing.

---

## Privacy & Security Architecture

### Data Classification

| Data Type | Storage | Encryption | Access |
|-----------|---------|------------|--------|
| PHI (Protected Health Info) | S3 Uploads Bucket | KMS (customer-managed) | Application only |
| Database | RDS PostgreSQL | KMS + SSL enforced | Private subnet only |
| Secrets | AWS Secrets Manager | KMS | IAM-controlled |
| Logs (CloudWatch groups) | CloudWatch Logs | KMS (customer-managed) | Audit access |
| Logs (S3 logs bucket) | S3 | SSE-S3 (AES256) — `storage.tf` | Audit access; bucket policy denies non-TLS |

### Compliance Tags

All infrastructure is tagged for compliance tracking:
- `Compliance: HIPAA-FERPA`
- `DataClass: PHI` (on uploads bucket)
- `ManagedBy: Terraform`

### Network Security (Defense in Depth)

```
┌─────────────────────────────────────────────────────────────┐
│                         VPC (10.0.0.0/16)                   │
│  ┌─────────────────────┐    ┌─────────────────────────────┐ │
│  │   Public Subnets    │    │      Private Subnets        │ │
│  │  ┌───────────────┐  │    │  ┌──────┐ ┌─────┐ ┌──────┐  │ │
│  │  │     ALB       │──┼────┼──│ ECS  │ │ RDS │ │Redis │  │ │
│  │  │  (HTTPS only) │  │    │  │      │ │     │ │      │  │ │
│  │  └───────────────┘  │    │  └──────┘ └─────┘ └──────┘  │ │
│  └─────────────────────┘    └─────────────────────────────┘ │
│                                      ↑                      │
│                              VPC Endpoints                  │
│                         (S3, ECR, Secrets Manager)          │
└─────────────────────────────────────────────────────────────┘
```

**Security Groups:**
- ALB: Accepts 443 (HTTPS) and 80 (redirect to HTTPS)
- ECS: Only accepts traffic from ALB on port 5000
- RDS: Only accepts connections from ECS/Lambda + bastion
- Bastion: **no ingress rules at all**, no public IP, no SSH key pair. The only
  shell is `aws ssm start-session --target <instance-id>` (`terraform/bastion.tf`,
  `terraform/security.tf`). There is nothing to IP-allowlist.

### Encryption

| Layer | Method |
|-------|--------|
| Public ingress | TLS 1.2+ enforced (CloudFront `TLSv1.2_2021`, ALB `ELBSecurityPolicy-TLS13-1-2-2021-06`), HTTP→HTTPS redirect |
| ALB → ECS task | **Plaintext HTTP** inside the private subnets — the target group is `protocol = "HTTP"` (`ecs.tf`). Not end-to-end TLS |
| Database | RDS encryption at rest (CMK) + `rds.force_ssl = 1` |
| S3 Uploads | KMS customer-managed key; bucket policy denies non-TLS requests and PUTs that name any SSE method other than `aws:kms` |
| S3 Logs | S3 managed encryption (AES256); bucket policy denies non-TLS requests |
| Secrets | Secrets Manager with KMS |
| CloudWatch Logs | KMS encryption (all Terraform-managed groups) |
| TURN control channel | Plaintext (coturn). Media itself is DTLS-SRTP end-to-end; the relay never decrypts it |

**RDS server-certificate verification — closed 2026-08-30.** `server/db.ts` and
`server/services/realtime/postgres-bus.ts` resolve their TLS config through
`server/db-ssl.ts`: `*.rds.amazonaws.com` hosts are verified against the AWS
**global** CA bundle (`rds-ca-bundle.pem`) with `rejectUnauthorized: true`;
non-RDS hosts (Render staging, local Postgres) keep the relaxed config by
design. Pinned by `server/tests/db-ssl.test.ts`, including a test that the
bundle stays global (il-central-1 roots present).

---

## Secrets Management

Secrets are stored in AWS Secrets Manager, not in environment variables or code.

Secret names are `aivota-{env}/…` (`local.name_prefix` in `terraform/main.tf` is
`aivota-${var.environment}`), i.e. `aivota-prod/database` and
`aivota-prod/app-secrets`.

### Database Secret (`aivota-{env}/database`)
- DATABASE_URL
- DB_HOST, DB_PORT, DB_NAME
- DB_USER, DB_PASSWORD (randomly generated, 32 chars)

Automatic rotation is **not configured** — the `aws_secretsmanager_secret_rotation`
block in `terraform/secrets.tf` is commented out. Rotation for the RDS master and
the app secrets is planned, not implemented.

### Application Secrets (`aivota-{env}/app-secrets`)
- SESSION_SECRET
- ENCRYPTION_KEY
- OPENAI_API_KEY
- STRIPE_SECRET_KEY
- Google OAuth credentials
- Dropbox credentials

`JWT_SECRET` used to be listed here. It is **dead** — no code signs or verifies a
JWT (no `jsonwebtoken`/`jose` import anywhere in `server/` or `shared/`). Delete
it from the secret; an unused credential is only attack surface.

**Gemini — required for the AAC.** All Gemini agents (Speaker, Observer AND the
Board Manager) authenticate through **Vertex AI**, so these three must be in the
secret:
- `GOOGLE_CLOUD_PROJECT_ID`
- `GOOGLE_CLOUD_LOCATION` (defaults to `us-central1` if absent)
- `GOOGLE_APPLICATION_CREDENTIALS_JSON` — the service-account key

`GEMINI_API_KEY` (an AI Studio key) is the FALLBACK used only when no project is
configured. It is free-tier and will hit a daily cap under real session load: on
2026-08-20 the Board Manager was the last agent still on it, and when the cap hit
every board rebuild returned RESOURCE_EXHAUSTED while the Speaker — already on
Vertex — carried on as if nothing were wrong. Treat a deployment that falls back
to the API key as broken, not degraded; both runtimes log a warning when it does.

The credentials key may be stored as a JSON string OR as a nested JSON object —
`loadAwsSecrets` serializes non-string values, which Lambda and ECS share.

Transactional email needs **no secret**: SES authenticates via the Lambda/ECS
role (see [EMAIL.md](EMAIL.md)). The old SMTP_*/RESEND_*/EMAIL_* keys are
obsolete and should be deleted from the app-secrets JSON — on Lambda every key
in it becomes an env var and would override the Terraform-set config.

#### Paddle (billing)

Paddle keeps **sandbox and live accounts entirely separate**, each with its own
API key, client token and webhook secret; nothing crosses between them. All of
these are keys in the `app-secrets` JSON — the ECS task loads that whole
document at boot, so **adding them needs no Terraform change** (see the profiles
note at the top of this file).

| Key | Purpose |
| --- | --- |
| `PADDLE_ENVIRONMENT` | `sandbox` (default) or `production`. Selects which of the pairs below is read — set it FIRST, or a live key sits unused next to a sandbox one. |
| `PADDLE_API_KEY` | Server-side API key, **live** account. |
| `PADDLE_API_KEY_SANDBOX` | Server-side API key, **sandbox** account. |
| `PADDLE_CLIENT_TOKEN` | Client-side token for paddle-js, **live**. A different credential from the API key and safe to expose to the browser — it is served to the client by `GET /api/paddle/config`. |
| `PADDLE_CLIENT_TOKEN_TEST` | Client-side token, **sandbox**. |
| `PADDLE_WEBHOOK_SECRET` | Signing secret for the notification destination. Not derived from the API key — copy it from the Paddle dashboard when the destination is created, and note it is shown once. |

**Webhook URL** — register this as the notification destination in the Paddle
dashboard (Developer tools → Notifications):

```
https://<host>/api/paddle/webhook
```

Subscribe it to: `transaction.completed`, `subscription.activated`,
`subscription.updated`, `subscription.canceled`, `subscription.past_due`,
`subscription.paused`, `subscription.resumed`. Anything else is accepted,
recorded in `paddle_events` as `ignored`, and answered 200.

Three operational facts worth knowing before debugging one:

- The endpoint is **unauthenticated** — the HMAC signature over the raw body is
  the authentication, so it is exempt from CSRF and mounted with
  `express.raw` ahead of the global `express.json` (`server/middleware/paddle-webhook-raw.ts`).
  Paddle's validator also rejects a signature whose timestamp is **more than 5
  seconds old**, so a badly-skewed clock on the task presents as "every webhook
  is invalid".
- Every delivery lands in the **`paddle_events`** table keyed by Paddle's own
  `event_id`, with the raw payload and the outcome. That table, not a log file,
  is the record: a 200 with `status='ignored'` and a reason is the normal answer
  to an event we cannot act on, and is NOT a failure.
- A checkout must pass **`customData: { userId }`** (optionally `licenseId`).
  It is the only link between a Paddle transaction and our user; without it the
  payment succeeds and the event is ignored with a reason.

**Per-license (individually-quoted) billing.** Organisations are quoted one at a
time, so the price lives on the `licenses` row (`price_amount` in the currency's
MINOR unit, `price_currency`, interval from `subscription_type`) rather than in
a catalog tier. Catalog prices (`subscription_plans.paddle_price_id`) still work
and are the future self-serve path.

- `POST /api/licenses/:id/checkout` (auth: the license's user, an **admin** of
  its institute, or a system admin) creates a Paddle transaction with a
  **non-catalog price** supplied inline — no `priceId` — hanging off one shared
  product named **"Aivota License"** (`paddleService.ensureLicenseProduct`,
  looked up by name, created once, memoised per process, tax category `saas`).
  It answers `200 { transactionId }` for the browser to open with
  `Paddle.Checkout.open({ transactionId })`; `409 LICENSE_NOT_PURCHASABLE`
  (no price quoted, or the row is inactive), `409 LICENSE_ALREADY_PAID`,
  `503 PADDLE_NOT_CONFIGURED`.
- Fulfillment recognises these by `customData.licenseId`, **before** any catalog
  price lookup: `transaction.completed` clears the trial and sets
  `subscription_expires_at` from the transaction's billing period (falling back
  to +30/+365 days). Later `subscription.*` events find the row by
  `licenses.paddle_subscription_id`, since Paddle's own events carry no
  customData we did not attach at checkout. A price that does not match the
  quote is **logged, never rejected** — the money has already moved. No credits
  are granted: credits are a separate product.
- An invoice or bank-transfer customer is activated by an admin instead, with
  `PATCH /api/admin/licenses/:id` setting `isTrial: false` and a
  `subscriptionExpiresAt`.
- **Expiry is enforced in `licenseService`**, nowhere else
  (`shared/license-status.ts`): a NULL expiry is perpetual (every license
  granted before billing existed looks like that), a paid license gets
  `PAID_GRACE_DAYS = 3` past its date, a trial gets none, and `is_active = false`
  is `none` rather than `expired`. An expired license resolves to no permissions
  but still reports its id, status, dates and price so the client can render a
  paywall with a pay button.

**Runtime Injection:** Secrets are injected into containers at runtime by ECS/Lambda, never baked into images.

---

## Audit & Compliance

### CloudTrail
- Logs ALL AWS management-plane API calls
- Multi-region enabled
- Log file validation (tamper detection)
- **Object-level (data) events for two buckets only:** `uploads` (PHI) and
  `aac_updates` (the AAC release/manifest bucket, whose `latest-backend.json`
  re-points the whole installed fleet). The high-volume logs bucket is
  deliberately excluded — data events are billed per event.
- KMS encrypted; trail's CloudWatch group uses `audit_log_retention_days`

### VPC Flow Logs
- Captures ALL network traffic
- Stored in CloudWatch Logs at `audit_log_retention_days`
- Encrypted with KMS
- Required for HIPAA audit trails

### Log Retention

Two variables, deliberately split (`terraform/variables.tf`):

| Variable | Groups it governs | `ecs-lean` | `hipaa` |
|---|---|---|---|
| `app_log_retention_days` | app/ECS, ECS Exec, Redis slow/engine, CloudFront access logs | 14 | 90 |
| `audit_log_retention_days` | CloudTrail-CW, VPC flow logs, RDS `postgresql`/`upgrade`, WAF | 30 | **2192 (6 years)** |

| Log Type | Retention | Notes |
|----------|-----------|-------|
| CloudWatch — app/debug groups | `app_log_retention_days` | Hot tier; cost trade-off |
| CloudWatch — audit groups | `audit_log_retention_days` (6 years under `hipaa`) | §164.316(b)(2) |
| S3 logs bucket | 6 years (2190 days) | ALB access logs, S3 access logs, CloudTrail files |
| S3 logs bucket (cold) | STANDARD_IA at 30 days, Glacier at 90 | Cost optimization |

**There is no CloudWatch → S3 export path.** Nothing ships CloudWatch log events
to the 6-year S3 bucket — no subscription filter, no Firehose, no export task.
The `hipaa` profile therefore meets the 6-year requirement by *keeping the audit
groups in CloudWatch for 6 years*, which is the expensive way round; a Firehose
subscription into the logs bucket is a possible future optimization, not
something that exists today. The S3 logs bucket holds only ALB access logs, S3
access logs and CloudTrail files.

### Database Logging
- Logs connections and disconnections
- `log_statement = ddl` — DDL statements only, not data queries
- `log_min_error_statement = panic` — suppresses the default behaviour of writing
  every FAILED statement (literal values included) into the exported log; a
  failed INSERT into a student's notes would otherwise be PHI in CloudWatch
- `log_error_verbosity = terse` — drops the DETAIL/HINT lines that echo offending
  values on constraint violations
- The RDS-exported `postgresql` and `upgrade` log groups are **pre-created in
  Terraform** (`rds.tf`) so they carry the CMK and an explicit retention instead
  of being auto-created by RDS unencrypted and never expiring

---

## Web Application Firewall (WAF)

Attached to the ALB, gated on `enable_waf`. **Off in the current `ecs-lean`
default profile; on under `hipaa`.** The legacy Lambda mode relies on
CloudFront's built-in protections.

**Managed Rules:**
1. **CommonRuleSet** - OWASP Top 10 protections
2. **KnownBadInputsRuleSet** - Malformed request blocking
3. **SQLiRuleSet** - SQL injection prevention
4. **RateLimitRule** - 2000 requests per IP per 5 minutes

**Logging:** `aws_wafv2_web_acl_logging_configuration` (`terraform/alerting.tf`)
writes to the CMK-encrypted `aws-waf-logs-<prefix>` group at
`audit_log_retention_days`, with the `authorization` and `cookie` headers
redacted before write. A logging filter keeps only BLOCK and COUNT decisions —
allowed requests would duplicate the ALB access log at WAF prices.

---

## GitHub Actions Security

### OIDC Authentication
- No static AWS credentials stored in GitHub
- Uses Web Identity Federation
- Repository-scoped: `repo:IndigoFenix/aac:*` — i.e. **every branch and every
  pull request** of the repo can assume the role. Narrowing the `sub` claim to
  `ref:refs/heads/main` plus a GitHub environment claim is **not implemented —
  planned**.
- **Two roles are now declared in `terraform/iam.tf`** — a deploy role trusted
  only from `refs/heads/main` with a policy that can actually run the apply, and
  a read-only plan role trusted from `pull_request`. Until the `AWS_ROLE_ARN`
  repo secret is repointed at the deploy role's ARN, the workflow still
  authenticates as the out-of-band `cliniaccian-github-actions-bootstrap`
  (`AdministratorAccess`) role — so treat "limited scope" as declared-but-not-yet-
  in-force. See Access & hardening → CI roles for the rollout and the residual
  self-modification caveat.

### Workflow Jobs

**Both workflows share:**
1. **Security Scan** - npm audit + ESLint security plugin
2. **Build & Test** - Type checking, tests, build

**ECS-specific:**
3. **Infrastructure** - Terraform apply
4. **Deploy** - Docker build/push, ECS task update
5. **Health Check** - Verify deployment

**Lambda-specific:**
3. **Infrastructure** - Terraform with state migration
4. **Build Frontend** - Vite React build
5. **Build Lambda** - Docker image build
6. **Deploy Frontend** - S3 sync + CloudFront invalidation
7. **Deploy Lambda** - Update function code

---

## Environment Differences

**`staging` is not deployed to AWS.** It runs on Render and therefore sits
outside every control described in this document (VPC isolation, KMS, CloudTrail,
WAF, flow logs). The table below compares the two AWS *profiles*, not two AWS
environments.

| Setting | `hipaa` profile | `ecs-lean` profile (current default) |
|---------|------------|---------|
| ECS task count | 2 (minimum) | 1 |
| Auto-scaling range | 2–10 | 1–3 |
| Redis (ElastiCache) | On | Off |
| WAF / CloudTrail / flow logs / VPC endpoints | On | Off |
| App log retention | 90 days | 14 days |
| Audit log retention | 2192 days (6 years) | 30 days |
| `enable_ssm_session_logging` | On | On |
| `enable_ecs_exec` | Off | Off |
| `ecs_readonly_root_fs` | On | On |
| `ecr_image_exists` (digest-pinned task template) | On | On |
| `coturn_image_tag` | `4.17.2` | `4.17.2` |

The last five are deliberately the SAME in both profiles: they are hardening
with no recurring cost, so there is no lean-mode reason to run without them.
What actually differs is the *evidence* they produce — SSM shell transcripts
land in the logs bucket under either profile, but the CloudTrail
`StartSession` / `TerminateSession` records that cover the DB tunnel only exist
under `hipaa`.

A second axis is `var.environment`, which both ECS profiles set to `prod`. It —
not the profile — is what selects RDS Multi-AZ (on), 35-day RDS backup retention,
RDS deletion protection (on) and a 30-day Secrets Manager recovery window. A
`staging`/`dev` value would drop those to single-AZ, 7 days, off and 7 days
respectively, but no such AWS environment is currently deployed.

---

## Access & hardening

Who can reach a running system, as what, and what evidence that leaves.

### SSM Session Manager logging

`terraform/ssm.tf` creates `SSM-SessionManagerRunShell` — the account/region
DEFAULT session document, so a plain `aws ssm start-session` picks it up without
anyone naming it. Interactive shell sessions are transcribed to
`s3://aivota-prod-logs-<account>/ssm-sessions/`, inside the existing 6-year
lifecycle. **No CloudWatch log group**: ingestion is the expensive half of
session logging and adds nothing S3 does not already give us.

Be precise about coverage, because the difference matters for §5.7 evidence:

| Session type | How it is started | Transcript? | Evidence |
|---|---|---|---|
| Interactive shell | `aws ssm start-session --target <id>` | Yes — full stream to S3 | The transcript object |
| Port forwarding (the DB tunnel) | `npm run db-tunnel` → `AWS-StartPortForwardingSessionToRemoteHost` | **No** — there is no shell to record | CloudTrail `StartSession` / `TerminateSession` (who, when, target, document) — requires `enable_cloudtrail`, i.e. the `hipaa` profile |

`scripts/db-tunnel.sh` is unaffected by this change. It passes
`--document-name AWS-StartPortForwardingSessionToRemoteHost` explicitly, so it
never resolves `SSM-SessionManagerRunShell`, and the preferences document sets
only S3 fields. Session-level KMS encryption is deliberately **not** enabled: it
applies to every session type including port forwarding, and would break the
tunnel for any engineer whose IAM lacks `kms:GenerateDataKey`.

One non-obvious dependency: once a session document names an S3 destination, a
session whose **target instance** cannot write there refuses to start. Both
SSM-managed hosts (bastion, coturn) therefore carry an inline `s3:PutObject` +
`s3:GetEncryptionConfiguration` grant. The logs bucket is SSE-S3, not the CMK,
so no KMS grant is needed — if the bucket is ever moved to SSE-KMS, add
`kms:Decrypt` + `kms:GenerateDataKey` to both roles at the same time or every
session in the account stops starting.

### Per-engineer database authentication (IAM auth)

`iam_database_authentication_enabled = true` is set on the RDS instance. It is
purely additive: password auth keeps working for the application, migrations and
the tunnel, and with `apply_immediately = false` in prod the modify is applied
at the next maintenance window (Mon 04:00–05:00 UTC). No reboot is required.

Terraform also creates — but attaches to nobody — the managed policy
`aivota-prod-rds-iam-connect` (output `rds_iam_connect_policy_arn`), granting
`rds-db:connect` on `dbuser:<db resource id>/aivota_engineer`.

**One-time manual step — ✅ done 2026-08-31** (run over the tunnel as the
master user, at the operator's request; verified `member_of: {rds_iam}`).
Grants as applied: DML-only on `public` (tables + sequences, plus matching
default privileges for future migration-created tables), no DDL, no role
management. For reference, the minimal form:

```sql
CREATE USER aivota_engineer;
GRANT rds_iam TO aivota_engineer;
-- then grant it whatever the role should actually be able to read/write, e.g.
-- GRANT CONNECT ON DATABASE aivota TO aivota_engineer;
-- GRANT USAGE ON SCHEMA public TO aivota_engineer;
```

Afterwards, with the policy attached to their IAM identity, an engineer connects
without a shared password:

```bash
npm run db-tunnel          # in another terminal — the tunnel is unchanged

export PGPASSWORD="$(aws rds generate-db-auth-token \
  --region il-central-1 --profile aac \
  --hostname aivota-prod-postgres.<...>.il-central-1.rds.amazonaws.com \
  --port 5432 --username aivota_engineer)"

psql "host=localhost port=5432 dbname=aivota user=aivota_engineer sslmode=require"
```

The token is minted against the **RDS endpoint hostname**, not `localhost`, even
though the tunnel is local — it is signed for the real host. Tokens last 15
minutes. Attribution then comes from two places together: CloudTrail records the
IAM principal that generated the token, and the PostgreSQL connection log records
the DB user. Scripts and the app stay on the shared password until someone opts
in; the two paths coexist indefinitely.

### coturn: patching and a pinned image

The coturn relay is the only internet-facing EC2 host we run (public subnet,
EIP, 3478/5349 and the relay port range open to `0.0.0.0/0`). It now has:

- **A patch baseline** (`aws_ssm_patch_baseline.coturn`, AL2023, Security
  classification, Critical+Important severity, auto-approved 7 days after
  release) bound by the instance's `Patch Group` tag.
- **A weekly State Manager association** running `AWS-RunPatchBaseline` with
  `Operation=Install`, `RebootOption=RebootIfNeeded`, at
  `cron(0 0 ? * SAT *)` — **Saturday 00:00 UTC = 03:00 Israel summer time
  (IDT, UTC+3) / 02:00 Israel winter time (IST, UTC+2)**. SSM cron has no
  timezone field, so the wall-clock hour shifts by one across the DST boundary;
  both land in the quiet window. `apply_only_at_cron_interval = true` stops
  State Manager from running the association once immediately on creation, which
  would otherwise reboot the relay during the apply that creates it.
- **A pinned container image**: `coturn/coturn:${var.coturn_image_tag}`
  (currently `4.17.2`) instead of the untagged `coturn/coturn`, which resolved
  to `:latest` at boot — so the relay's version depended on the day the host was
  last replaced.

**The pin does not take effect until the host is replaced.** `user_data` is in
the instance's `ignore_changes`, because it is paired with
`user_data_replace_on_change = true` and editing the script would otherwise
destroy and recreate the relay on the very next apply, dropping every live call.
To adopt a new image tag deliberately: change `coturn_image_tag`, bump
`null_resource.coturn_version` in `terraform/coturn.tf`, and apply during a
quiet window. Both changes must be in the same apply — the bump alone re-runs
whatever `user_data` currently says.

Patch installs are free (Patch Manager and State Manager carry no charge for EC2
instances) and no S3/CloudWatch output location is configured for the
association.

### Container hardening (ECS)

- **ECS Exec is OFF** (`var.enable_ecs_exec`, false in both profiles). It was
  hardcoded `true` while the task role never carried `ssmmessages:*` — an
  advertised interactive path into a PHI container that could not actually be
  used. Turning it on requires adding those actions to
  `aws_iam_role.ecs_task` as well as flipping the variable; do that for a
  debugging window, not as a standing state.
- **The Terraform task-definition template is digest-pinned**
  (`var.ecr_image_exists` → `data.aws_ecr_image.app`). This does not change what
  is running: the deploy workflow registers its own revision with the sha-tagged
  image and `aws_ecs_service.main` ignores `task_definition` changes. It fixes
  what a *fresh apply* or a DR rebuild would create, which previously baked in
  the mutable `:latest` tag. `image_tag_mutability` stays `MUTABLE` because the
  workflow pushes `:latest` on every deploy.
- **`readonlyRootFilesystem` is ON** in both ECS profiles
  (`var.ecs_readonly_root_fs`), with a `tmp` volume mounted at `/tmp` — a
  Fargate bind mount onto the 20 GB ephemeral storage every task already has,
  at no extra charge. Nothing in the image is writable at runtime, so a
  compromised process cannot drop a payload beside the server bundle or
  rewrite `dist/`.

  `/tmp` is the only writable path the runtime needs:
  `server/services/chat/tools/video-frame-extractor.ts` calls
  `mkdtemp(path.join(tmpdir(), …))`. Node writes nothing under `HOME` and npm
  never runs at runtime (the entrypoint is `node dist/index.prod.js`).

  Every OTHER writer opens a file under the app directory, and each is a
  debug log gated on `server/services/file-debug-log.ts` —
  `fileDebugLogEnabled()` is `DEBUG_FILE_LOGS=true` OR (not Lambda and
  `NODE_ENV` is neither `production` nor `test`), so it is **false in
  production**. The writers are `caption-debug-log.ts`,
  `chat/memory-debug-log.ts`, `dual-agent/dual-agent-logger.ts` (which keeps
  its own `DEBUG_LIVE_SESSIONS` override on top of the shared predicate),
  `dual-agent/agent-flow-logger.ts`, `deepAnalysisService.ts`,
  `sessionSummary.ts`, `memory-schema/quest-game-log.ts`,
  `symbol/auto-symbol-service.ts` and `aac-sim/trace.ts`;
  `providers/claude-structured.ts` is gated on its own `CLAUDE_CACHE_DEBUG`.

  Belt as well as braces: all of them write through `safeAppend` /
  `safeTruncate`, which swallow `EROFS` (and memoise the dead path so a
  leaked gate costs one failed syscall, not one per log line) — a debug log
  must never be able to fail a request. `server/tests/readonly-root-fs.test.ts`
  pins all of it as a source check, so a new `fs.appendFileSync` added to one
  of these modules fails CI rather than production.

### Disclosed: the ALB → task hop is plaintext HTTP

TLS terminates at the ALB (TLS 1.2+, `ELBSecurityPolicy-TLS13-1-2-2021-06`) and
at CloudFront. From the load balancer to the Fargate task, and for the ALB
health check on `/health`, traffic is **plain HTTP on port 5000**. PHI in
request and response bodies therefore crosses that hop unencrypted.

This is disclosed rather than fixed. The compensating controls are: the tasks
sit in private subnets with no public IP; `aws_security_group.ecs` accepts
traffic on 5000 only from `aws_security_group.alb`; the VPC is single-tenant to
this account. Closing it properly means terminating TLS inside the container
(certificate provisioning, rotation and distribution into the task) — a real
project, not a Terraform flag, and out of scope here.

### CI roles: the deploy role, the plan role, and the admin role we are leaving

The situation the 2026-08-30 audit found: the role Terraform declared was **not**
the role the deploy used.

| Role | Trust | Permissions | Assumed? |
|---|---|---|---|
| `aivota-prod-github-actions-role` (Terraform, `iam.tf`) | `repo:IndigoFenix/aac:*` | scoped inline policy that could not run the apply | **never, since 2026-03** |
| `cliniaccian-github-actions-bootstrap` (created out of band) | `repo:IndigoFenix/aac:*` | **`AdministratorAccess`** | every deploy |

`secrets.AWS_ROLE_ARN` pointed at the bootstrap role, and had to — the declared
policy had no VPC, RDS, KMS or IAM permissions at all, so a `terraform apply`
under it would have failed on its first resource. The declared role was
decoration.

What is now in Terraform:

- **`aivota-prod-github-actions-role` is repurposed in place** as the real deploy
  role — the same resource, so the apply is an in-place update, not a
  destroy/create. Trust narrowed from `repo:IndigoFenix/aac:*` (every branch,
  every PR, every tag) to an exact `repo:IndigoFenix/aac:ref:refs/heads/main`. A
  `workflow_dispatch` run started against main mints the same `ref:` subject, so
  the manual "deploy with the hipaa profile" run is unaffected.
- **`aivota-prod-github-actions-plan`** is new: trust
  `repo:IndigoFenix/aac:pull_request`, policy `Describe*/Get*/List*` over the
  same service list, read-only on the state bucket, read-write on the lock table
  only (a plan takes the lock), with `s3:PutObject`/`DeleteObject` on the state
  explicitly denied. Fork PRs receive no secrets, so no fork can attempt the
  assume.

Both policies derive from **one** list of service namespaces
(`local.github_service_namespaces`) — the deploy role gets `<ns>:*`, the plan
role gets the three read verbs. That is deliberate: the old hand-written list
drifted out of usefulness and nobody noticed for five months, because a broader
role was quietly doing the work. Outside that list, three resource-scoped
statements (S3 on `aivota-*`, DynamoDB on the lock table, IAM on
`role|policy|instance-profile/aivota-*`) and an explicit **Deny** on
`organizations`, `account`, `aws-portal`, `billing`, `ce`, and every IAM action
matching `*User*`, `*AccessKey*`, `*LoginProfile*`, `*SAMLProvider*`,
`*MFADevice*`. So a compromised workflow cannot mint a user or an access key and
cannot reach the payer account.

Two things to be honest about:

- The deploy role can rewrite **its own** policy — it is an `aivota-*` role and
  Terraform has to be able to manage it. The control is that any such change has
  to land on `main` through a pull request. A permissions boundary would close it
  properly; that is the next step if this is audited harder.
- `apigateway` does not use `Describe/Get/List` — reading an HTTP API is
  `apigateway:GET`, granted explicitly in the plan policy. Without it a plan
  would fail on the legacy Lambda path's resources.

One correction to the original design note: the "redundant" unconditioned
`ecs:RegisterTaskDefinition` / `ecs:DescribeTaskDefinition` statement in the old
policy was **not** redundant. `ecs:DescribeTaskDefinition` supports neither
resource-level permissions nor the `aws:ResourceTag` condition key, so the
tag-scoped statement above it could never have authorized it — dropping it would
have broken the workflow's `Fetch current task definition` step. The new policy
grants `ecs:*` and the question disappears.

**Rollout order.** Nothing breaks at any step, because the repo secret is what
selects the role and it does not change on merge:

1. **Merge.** The apply still runs as `cliniaccian-github-actions-bootstrap`
   (the secret is unchanged), and it updates the deploy role's trust + policy and
   creates the plan role. Deploys keep working throughout.
2. **Set the secrets.** Point `AWS_ROLE_ARN` at the `github_actions_role_arn`
   output, and add `AWS_PLAN_ROLE_ARN` from `github_actions_plan_role_arn`. The
   next push to main is the first deploy that runs on the scoped role.
   Also add `AWS_PUBLISH_ROLE_ARN` from `github_actions_publish_role_arn` — see
   "Publishing artifacts off main" below.
3. **Keep the bootstrap role as break-glass.** Do not delete
   `cliniaccian-github-actions-bootstrap`. If a scoped apply ever fails with
   `AccessDenied`, repoint `AWS_ROLE_ARN` back to it, merge the permission fix
   (usually one more namespace in `local.github_service_namespaces`), then
   repoint forward again. Deleting it removes the only way back.

**The plan role has no consumer yet.** The `infrastructure` job is gated
`if: github.ref == 'refs/heads/main'`, and a `pull_request` event's ref is
`refs/pull/<n>/merge` — so no job runs on PRs today, and the PR branch of the
workflow's `role-to-assume` expression is unreachable. The role and the
expression are in place so that turning PR plans on is a one-line change to that
`if:`; enabling it was not done here because it adds a CI run that does not
exist today. Until then the plan role is inert, and the transition-safe
`|| secrets.AWS_ROLE_ARN` fallback means an unset `AWS_PLAN_ROLE_ARN` degrades to
the deploy role rather than to a broken job.

### Publishing artifacts off main

The deploy role's `main`-only trust is correct, and it has one consequence worth
naming: **the AAC release workflows cannot use it.** They run from feature
branches (`workflow_dispatch`) and from `v*` tags, whose OIDC subjects are
`…:ref:refs/heads/<branch>` and `…:ref:refs/tags/v…` — neither matches
`StringEquals … refs/heads/main`. The symptom is
`Not authorized to perform sts:AssumeRoleWithWebIdentity` at the "Configure AWS
credentials" step. This bit the iOS build first (2026-09-06), but it applies
equally to `release-aac.yml` on a tag push.

The fix is NOT to add those refs to the deploy role. That role carries `<ns>:*`
across most of the account, and widening its trust would hand it to anyone who
can push an unprotected branch — undoing the narrowing this section documents.

Instead: `aws_iam_role.github_actions_publish` (`terraform/iam.tf`, output
`github_actions_publish_role_arn`, repo secret `AWS_PUBLISH_ROLE_ARN`). Trust is
wider — `main`, `staging`, `refs/tags/v*` — because the permission behind it is
a single `s3:PutObject` on the AAC update bucket, whose `DataClass` is `public`.
No delete, no read, no bucket-level actions, no KMS (the bucket is SSE-S3). The
bucket is versioned, so a re-publish adds a version rather than destroying a
shipped artifact — which is what makes one write action safe to give a branch
build.

`pull_request` is deliberately **not** trusted. That subject is produced by PRs
including ones from forks, and this role writes the artifacts the desktop
auto-updater installs.

The four AAC publish workflows (`release-aac.yml`, `release-aac-staging.yml`,
`build-aac-ios-unsigned.yml`, `publish-aac-backend.yml`) use
`${{ secrets.AWS_PUBLISH_ROLE_ARN || secrets.AWS_ROLE_ARN }}`, so the apply and
the secret are independent steps. `deploy.yml` and `deploy-lambda.yml` are
untouched and stay on the deploy role.

### Before the next apply: one blocked resource

`terraform plan` shows `aws_cloudwatch_log_group.rds_postgresql` as a **create**,
but `/aws/rds/instance/aivota-prod-postgres/postgresql` already exists in the
account — RDS auto-created it (no CMK, no expiry) before Terraform declared it.
An apply would fail with `ResourceAlreadyExistsException` — the exact situation
the comment in `terraform/rds.tf` warns about. **No manual step is needed:** the
`Terraform Adopt Pre-existing Resources` step in `deploy.yml` imports it before
the plan, is idempotent (already-in-state and absent-in-AWS both fall through),
and is gated to non-PR runs so it always executes under the deploy role. Adopting
another such resource later means adding one `address=id` line to its list.

Only this one group is affected — `/aws/rds/instance/aivota-prod-postgres/upgrade`
does not exist and creates cleanly. After adoption the apply sets the CMK and the
retention on the group RDS had created bare.

If you ever need to do it by hand instead (from a workstation with admin
credentials):

```bash
cd terraform
AWS_PROFILE=aac terraform import aws_cloudwatch_log_group.rds_postgresql \
  /aws/rds/instance/aivota-prod-postgres/postgresql
```

---

## Regional Considerations

| Component | Region | Reason |
|-----------|--------|--------|
| Primary Infrastructure | `il-central-1` (Israel) | Data residency |
| Default (variables) | `eu-west-1` (Ireland) | GDPR compliance |
| CloudFront Certs | `us-east-1` | AWS requirement |

---

## Key Privacy Considerations

### What IS Logged
- API calls (CloudTrail)
- Network traffic metadata (VPC Flow Logs)
- Database connections/disconnections
- DDL statements (schema changes)
- ALB access logs
- Application logs (stdout/stderr)

### What is NOT Logged
- Database query contents (prevents PHI in logs)
- Request/response bodies
- User passwords (hashed in DB)
- Secrets values

### Data Flow Privacy
1. **User uploads** → S3 (KMS encrypted, versioned; bucket policy denies non-TLS
   and non-KMS PUTs)
2. **Database queries** → RDS (private subnet, SSL enforced; server cert not
   verified by the client — see the Encryption section)
3. **Secrets** → Fetched at runtime from Secrets Manager
4. **Logs** → CloudWatch (KMS-encrypted; audit groups retained for 6 years under
   the `hipaa` profile). CloudWatch content is **not** exported to S3; the S3
   logs bucket receives ALB, S3-access and CloudTrail files directly.

---

## Monitoring & Alerting

### CloudWatch Alarms
- High CPU (>80%) on ECS/RDS
- High memory (>80%) on ECS
- ALB 5XX errors (>10 in 5 min)
- Failed login attempts (>10 in 5 min) — the `AiVota/FailedLoginAttempts` metric
  is produced by a log metric filter on the app log group
  (`aws_cloudwatch_log_metric_filter.failed_logins`, `terraform/alerting.tf`)
  matching the `[auth] login_failed` stdout marker the app writes on every
  rejected password/MFA attempt (`server/controllers/authController.ts`). The
  marker carries no identifier — `activity_logs` holds the `auth_login_failure`
  row with IP and user-agent.
- Low RDS storage (<5GB)
- High RDS connections (>100)
- Lambda errors (>5) — legacy path only
- Lambda duration approaching timeout — legacy path only

### Alert delivery

Alarms publish to the KMS-encrypted `aws_sns_topic.alerts`. Two pieces are what
make that reach a human (`terraform/alerting.tf`, `terraform/secrets.tf`):

- an **email subscription** created from `var.alert_email` (both ECS profiles set
  `alerts@aivota.ai`; an empty value means deliberately unsubscribed). SNS
  sends a one-time confirmation mail after apply — until someone clicks it the
  stream is silent. Changing the address **replaces** the subscription, so a
  re-point starts unconfirmed and silent all over again.
- **CMK grants** for `cloudwatch.amazonaws.com` and `events.amazonaws.com`, plus
  an SNS topic policy granting both services `SNS:Publish`. Without them the
  encrypted topic rejects the publish and alarms fire into the void.

### GuardDuty
- AWS threat detection service, conditional enablement via `enable_guardduty`
- Findings of severity ≥ 4 are routed to the alerts topic by an EventBridge rule
  with an input transformer that renders a one-line summary
  (`aws_cloudwatch_event_rule.guardduty_findings`)

---

## Backups & disaster recovery

Full runbook: **[DISASTER_RECOVERY.md](DISASTER_RECOVERY.md)**. Summary:

- **RDS:** automated backups + PITR, **35 days** in prod (`terraform/rds.tf:109`),
  Multi-AZ (`:114`), CMK-encrypted, deletion protection on (`:127`).
- **S3 uploads:** versioning on, noncurrent versions expire after 30 days
  (`terraform/storage.tf:18-23`, `:111-139`) — that window is also the recovery
  window for an accidental overwrite or delete.
- **Secrets Manager:** 30-day soft-delete recovery in prod (`terraform/secrets.tf:133`, `:150`).
- **Redis:** daily snapshots, `redis_snapshot_retention_days` (default 7), only
  under the `hipaa` profile (`terraform/redis.tf:119`).
- **Not backed up:** on-device AAC session recordings, and staging (Render).

**DR is in-region only, deliberately.** `il-central-1` is the only AWS region in
Israel, so a cross-region snapshot copy or CRR would itself be a transfer of PHI
out of the country (AKIM §14). Region loss is an accepted, documented risk.

**Cutover after a restore** is a Secrets Manager edit plus a rolling deploy — no
`terraform apply`, no image rebuild: change `DATABASE_URL` in `aivota-prod/database`
(the ECS task reads it from there, `terraform/ecs.tf:215-216`) then
`aws ecs update-service --cluster aivota-prod-cluster --service aivota-prod-service --force-new-deployment`.

**Drill:** `npm run dr:drill` (plan) / `-- --execute` restores the latest snapshot
in-region to a throwaway `aivota-dr-drill-*` instance, smoke-checks it, tears it
down and writes dated evidence to `docs/dr/drills/`. Quarterly.

---

## Terraform State

- **Backend:** S3 with encryption (SSE-S3, not the CMK)
- **Locking:** DynamoDB table (`terraform-state-lock`)
- **State files:** Separate per environment
- **Access:** GitHub Actions role only

The state holds every Terraform-generated secret (RDS master password, Redis auth
token, TURN secret) in cleartext within the state JSON. The state bucket has
versioning and public-access block applied by the workflow but **no bucket
policy, no access logging and no Object Lock** — hardening it is not implemented.

---

## Known Security Considerations

1. **Terraform Auto-Approve** - No manual review gate on infrastructure changes. Consider adding manual approval for production.

2. **Health Checks** - Uses HTTP, not HTTPS verification. The health endpoint doesn't expose any data and is used only to check if the system is running.

3. **Lambda Function URL** - Set to `NONE` authorization. Application-level authentication is required. (Legacy rollback path only.)

4. **No CloudWatch → S3 archive** - The 6-year audit requirement is met under the
   `hipaa` profile by retaining the audit log groups in CloudWatch for 2192 days,
   which is the expensive option. A Firehose/subscription-filter export to the
   logs bucket is **not implemented**.

5. **Bastion Access** - No ingress rules at all; access is SSM Session Manager
   only. Interactive shell sessions are now transcribed to the logs bucket
   (`ssm-sessions/`); port-forwarding sessions produce no transcript by
   construction and are only evidenced by CloudTrail, which is off under
   `ecs-lean`. Human DB access still uses the shared `aivota_admin` role in
   practice: the `aivota_engineer` DB user exists (created 2026-08-31,
   DML-only) and the `rds-db:connect` policy exists, but IAM-token logins only
   work once the `iam_database_authentication_enabled` apply lands, and the
   policy still has to be attached to each engineer's IAM identity. See
   Access & hardening.

6. **RDS TLS certificate verified since 2026-08-30** - `server/db-ssl.ts`
   validates RDS hosts against the AWS global CA bundle
   (`rejectUnauthorized: true`); non-RDS hosts keep the relaxed config by
   design. See the Encryption section.

7. **Container hardening** - ECS Exec is off, the Terraform template is
   digest-pinned, and `readonlyRootFilesystem` is on in both ECS profiles with
   `/tmp` as the only writable path. See Access & hardening.

8. **Secrets rotation** - Not configured for the RDS master or the app secrets
   (see Secrets Management).

9. **coturn** - The TURN control channel is plaintext and its shared secret is
   passed through `user_data`. The host now has a weekly AL2023 security patch
   association and a pinned container image (Access & hardening), but still no
   log forwarding. Media is DTLS-SRTP end-to-end, so the relay never sees
   decrypted audio/video.

10. **Security scan job cannot fail the build** - the `security-scan` job in
    `deploy.yml` runs with `continue-on-error: true`.

---

## Switching Between Modes

### ECS lean → HIPAA
Dispatch `deploy.yml` with `deploy_profile = hipaa`, or change `DEFAULT_PROFILE`
in the workflow so every push uses it. Redis, WAF, CloudTrail, flow logs, VPC
endpoints and the second NAT come up; the RDS class change restarts the DB in
the maintenance window style. Nothing is destroyed.

### Rolling back to Lambda
Dispatch `deploy-lambda.yml` (profile `lean`). It applies the Lambda profile to
the same state: the ECS service scales to 0 (resources stay), Lambda + API
Gateway are recreated, CloudFront's origin swaps back. Because `use_lambda =
false` destroys the Lambda function and its ECR repo, a rollback rebuilds the
image (~15 min). Packaged AAC clients pointed at `api.<domain>` lose their
backend on rollback — that host only exists on the ECS path — so a rollback
also means re-pointing the client release.

### Re-pointing installed AAC clients (desktop + iPad)
Packaged builds bake `VITE_API_URL` (prod → `https://api.aivota.ai`) **and**
`VITE_BACKEND_MANIFEST_URL` → `https://updates.aivota.ai/aac/latest-backend.json`.
On every launch the app fetches that manifest and stores its `backendUrl` as the
last-known-good backend (applied next launch, or immediately if the current
backend is down; dropped again if it dies and the manifest can't correct it).
So a backend move is one upload, no forced update:
`npm run publish:aac:backend prod` or the **Publish AAC Backend Manifest**
workflow (`publish-aac-backend.yml`, which also accepts an explicit URL for
rollback drills). `npm run release:aac:<env>` publishes the same manifest
automatically. Builds made before this mechanism (≤ the Render era) only move
via auto-update / TestFlight.

### Moving back to ECS
Push to `main` (or dispatch `deploy.yml`). The first apply after a rollback
recreates the HTTPS listener/cert and destroys Lambda again.
