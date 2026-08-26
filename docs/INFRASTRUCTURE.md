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

**Open gap — RDS server-certificate verification.** The connection is TLS but the
application does not verify the server certificate: `server/db.ts` (and
`server/services/realtime/postgres-bus.ts`) set `ssl: { rejectUnauthorized: false }`.
Bundling the RDS CA and flipping this to `true` is **not implemented — planned**
(§164.312(e)(2)(ii)).

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
- **The role's effective permissions are not in Terraform.** The policy declared
  in `terraform/iam.tf` cannot perform the `terraform apply` the workflow runs
  (it creates VPC/RDS/KMS/IAM/WAF resources), so a broader policy is attached out
  of band. Treat "limited scope" as aspirational until that policy is brought
  under Terraform and split into separate deploy / release / manifest roles.

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

A second axis is `var.environment`, which both ECS profiles set to `prod`. It —
not the profile — is what selects RDS Multi-AZ (on), 35-day RDS backup retention,
RDS deletion protection (on) and a 30-day Secrets Manager recovery window. A
`staging`/`dev` value would drop those to single-AZ, 7 days, off and 7 days
respectively, but no such AWS environment is currently deployed.

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
  `security@aivota.ai`; an empty value means deliberately unsubscribed). SNS
  sends a one-time confirmation mail after apply — until someone clicks it the
  stream is silent.
- **CMK grants** for `cloudwatch.amazonaws.com` and `events.amazonaws.com`, plus
  an SNS topic policy granting both services `SNS:Publish`. Without them the
  encrypted topic rejects the publish and alarms fire into the void.

### GuardDuty
- AWS threat detection service, conditional enablement via `enable_guardduty`
- Findings of severity ≥ 4 are routed to the alerts topic by an EventBridge rule
  with an input transformer that renders a one-line summary
  (`aws_cloudwatch_event_rule.guardduty_findings`)

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
   only. SSM session logging to CloudWatch/S3 is not configured, and human DB
   access still uses the shared `aivota_admin` role rather than per-engineer IAM
   database authentication.

6. **RDS TLS certificate not verified** - `server/db.ts` sets
   `rejectUnauthorized: false`. Encrypted, but not authenticated.

7. **Container hardening** - The task definition sets no
   `readonlyRootFilesystem`, so the container root FS is writable (ephemeral per
   task). `enable_execute_command = true` means a principal with
   `ecs:ExecuteCommand` can shell into a running task. The image is deployed by
   the mutable `:latest` tag.

8. **Secrets rotation** - Not configured for the RDS master or the app secrets
   (see Secrets Management).

9. **coturn** - The TURN control channel is plaintext, its shared secret is
   passed through `user_data`, and the host ships no log forwarding or patch
   automation. Media is DTLS-SRTP end-to-end, so the relay never sees decrypted
   audio/video.

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
