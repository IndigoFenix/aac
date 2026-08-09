# CliniAACian Infrastructure Documentation

## Overview

CliniAACian uses GitHub Actions workflows for CI/CD and Terraform for AWS infrastructure management. The system supports **two deployment modes**:

1. **ECS Mode** - Container-based deployment using AWS ECS Fargate
2. **Lambda Mode** - Serverless deployment using AWS Lambda + S3/CloudFront

Currently we are using Lambda Mode. We will move to ECS Mode once we have a consistent user base.

---

## Two Build Architectures

### 1. ECS Deployment (`deploy-ecs.yml`)

**Architecture:**
```
Internet → ALB (Load Balancer) → ECS Fargate Tasks → RDS PostgreSQL
                                        ↓
                                   ElastiCache (Redis)
```

**Components:**
- Docker containers running on ECS Fargate
- Application Load Balancer (public-facing)
- Auto-scaling (2-10 tasks based on CPU/memory)
- VPC with private subnets for data tier

**Best for:** Production workloads requiring consistent performance and long-running processes.

### 2. Lambda Deployment (`deploy-lambda.yml`)

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

To switch from ECS to Lambda mode:
1. Set `use_lambda = true` in `terraform.tfvars`
2. Run Phase 1 (builds Lambda image)
3. Set `lambda_image_exists = true`
4. Run Phase 2 (deploys Lambda + frontend)

The workflows handle the two-phase deployment automatically.
