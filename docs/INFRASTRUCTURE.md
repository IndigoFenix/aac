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
- Interval crons (session sweeper, activity-log retention, erasure) run natively —
  the EventBridge `/internal/run-crons` workaround is Lambda-only
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
| Logs | CloudWatch + S3 | KMS | Audit access |

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
- Bastion: No ingress by default (requires manual IP allowlisting)

### Encryption

| Layer | Method |
|-------|--------|
| Transit | TLS 1.2+ enforced everywhere |
| Database | RDS encryption + forced SSL |
| S3 Uploads | KMS customer-managed key |
| S3 Logs | S3 managed encryption (AES256) |
| Secrets | Secrets Manager with KMS |
| CloudWatch Logs | KMS encryption |

---

## Secrets Management

Secrets are stored in AWS Secrets Manager, not in environment variables or code.

### Database Secret (`/cliniaacian-{env}/database`)
- DATABASE_URL
- DB_HOST, DB_PORT, DB_NAME
- DB_USER, DB_PASSWORD (randomly generated, 32 chars)

### Application Secrets (`/cliniaacian-{env}/app-secrets`)
- SESSION_SECRET
- JWT_SECRET
- ENCRYPTION_KEY
- OPENAI_API_KEY
- STRIPE_SECRET_KEY
- Google OAuth credentials
- Dropbox credentials

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
- Logs ALL AWS API calls
- Multi-region enabled
- Log file validation (tamper detection)
- Tracks all S3 object-level operations
- KMS encrypted

### VPC Flow Logs
- Captures ALL network traffic
- Stored in CloudWatch Logs
- Encrypted with KMS
- Required for HIPAA audit trails

### Log Retention

| Log Type | Retention | Notes |
|----------|-----------|-------|
| CloudWatch Logs | 90 days | Cost vs. HIPAA trade-off |
| S3 Logs | 6 years (2190 days) | HIPAA requirement |
| S3 Logs (cold) | Glacier after 90 days | Cost optimization |

**Note:** HIPAA technically requires 6 years. CloudWatch is set to 90 days for cost reasons, but S3 logs are retained for the full 6 years.

### Database Logging
- Logs connections and disconnections
- DDL statements only (not data queries)
- Prevents accidental PHI exposure in logs

---

## Web Application Firewall (WAF)

Enabled for ECS mode (ALB). Lambda mode uses CloudFront's built-in protections.

**Managed Rules:**
1. **CommonRuleSet** - OWASP Top 10 protections
2. **KnownBadInputsRuleSet** - Malformed request blocking
3. **SQLiRuleSet** - SQL injection prevention
4. **RateLimitRule** - 2000 requests per IP per 5 minutes

---

## GitHub Actions Security

### OIDC Authentication
- No static AWS credentials stored in GitHub
- Uses Web Identity Federation
- Role assumption with limited scope
- Repository-scoped: `repo:IndigoFenix/aac:*`

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

| Setting | Production | Staging |
|---------|------------|---------|
| Branch | `main` | `staging` |
| ECS Task Count | 2 (minimum) | 1 |
| RDS Multi-AZ | Enabled | Disabled |
| RDS Backup Retention | 35 days | 7 days |
| Deletion Protection | Enabled | Disabled |
| Secret Recovery Window | 30 days | 7 days |
| Auto-scaling Range | 2-10 | 1-10 |

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
1. **User uploads** → S3 (KMS encrypted, versioned)
2. **Database queries** → RDS (private subnet, SSL enforced)
3. **Secrets** → Fetched at runtime from Secrets Manager
4. **Logs** → CloudWatch (encrypted) → S3 (6-year retention)

---

## Monitoring & Alerting

### CloudWatch Alarms
- High CPU (>80%) on ECS/RDS
- High memory (>80%) on ECS
- ALB 5XX errors (>10 in 5 min)
- Failed login attempts (>10 in 5 min)
- Low RDS storage (<5GB)
- High RDS connections (>100)
- Lambda errors (>5)
- Lambda duration approaching timeout

### GuardDuty
- AWS threat detection service
- Conditional enablement via variable

---

## Terraform State

- **Backend:** S3 with encryption
- **Locking:** DynamoDB table (`terraform-state-lock`)
- **State files:** Separate per environment
- **Access:** GitHub Actions role only

---

## Known Security Considerations

1. **Terraform Auto-Approve** - No manual review gate on infrastructure changes. Consider adding manual approval for production.

2. **Health Checks** - Uses HTTP, not HTTPS verification. The health endpoint doesn't expose any data and is used only to check if the system is running.

3. **Lambda Function URL** - Set to `NONE` authorization. Application-level authentication is required.

4. **Log Retention Trade-off** - CloudWatch set to 90 days vs HIPAA's 6-year requirement. S3 logs cover the full retention.

5. **Bastion Access** - No default ingress. Requires manual IP configuration for emergency database access.

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
