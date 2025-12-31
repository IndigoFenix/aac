# Migrating from ECS to Lambda + S3

This guide explains how to switch CliniAACian from ECS (container-based) to Lambda + S3 (serverless).

## Architecture Comparison

| Component | ECS (current) | Lambda + S3 |
|-----------|---------------|-------------|
| Frontend | Served by Express | S3 + CloudFront (CDN) |
| Backend | Express on Fargate | Express on Lambda |
| Entry point | ALB | CloudFront + Lambda URL |
| Cost (low traffic) | ~$55-85/month | ~$15-35/month |
| Cold starts | None | 500ms-2s first request |
| Scaling | Manual/Auto (min 1) | Automatic (0 to 1000s) |

## Migration Steps

### Step 1: Update package.json

Add these scripts:

```json
{
  "scripts": {
    "dev": "cross-env NODE_ENV=development tsx server/index.ts",
    "build": "npm run build:client && npm run build:server",
    "build:client": "vite build",
    "build:server": "esbuild server/index.prod.ts --platform=node --packages=external --bundle --format=esm --outdir=dist",
    "build:lambda": "esbuild server/index.lambda.ts --platform=node --packages=external --bundle --format=esm --outdir=dist",
    "start": "NODE_ENV=production node dist/index.prod.js"
  }
}
```

### Step 2: Add index.lambda.ts

Copy `server/index.lambda.ts` from this package to your `server/` folder.

This file:
- Loads secrets from AWS Secrets Manager at runtime
- Runs migrations on cold start
- Only handles API routes (no static file serving)

### Step 3: Add AWS SDK for Secrets Manager

```bash
npm install @aws-sdk/client-secrets-manager
```

### Step 4: Add Dockerfile.lambda

Copy `Dockerfile.lambda` to your project root.

Key differences from ECS Dockerfile:
- Uses AWS Lambda Web Adapter
- Smaller image (no static files)
- Runs on port 8080

### Step 5: Update Terraform

Add to `terraform/variables.tf`:
```hcl
variable "use_lambda" {
  description = "Use Lambda instead of ECS"
  type        = bool
  default     = false
}
```

Copy these files to `terraform/`:
- `lambda.tf` - Lambda function and IAM
- `frontend.tf` - S3 bucket and CloudFront

Update `terraform/terraform.tfvars`:
```hcl
use_lambda = true
```

### Step 6: Update DNS

When `use_lambda = true`, the Route 53 records will point to CloudFront instead of ALB.

### Step 7: Deploy

```bash
# First, apply Terraform to create Lambda resources
cd terraform
terraform apply

# Get the CloudFront distribution ID
terraform output cloudfront_distribution_id

# Add to GitHub Secrets:
# CLOUDFRONT_DISTRIBUTION_ID = <the ID>

# Push code to trigger deployment
git add .
git commit -m "Switch to Lambda"
git push
```

## Switching Back to ECS

To switch back:

```hcl
# terraform.tfvars
use_lambda = false
```

```bash
terraform apply
```

The ECS infrastructure remains in place, just not actively used.

## Cost Breakdown

### Lambda + S3 (low traffic, ~1000 requests/day)

| Service | Monthly Cost |
|---------|--------------|
| Lambda | ~$0-2 (1M free requests/month) |
| S3 | ~$0.50 |
| CloudFront | ~$1-2 |
| RDS | ~$15-30 |
| Secrets Manager | ~$1 |
| **Total** | **~$18-35** |

### ECS (always on)

| Service | Monthly Cost |
|---------|--------------|
| Fargate (1 task) | ~$25-40 |
| ALB | ~$16 |
| RDS | ~$15-30 |
| Secrets Manager | ~$1 |
| **Total** | **~$57-87** |

## Important Notes

### Cold Starts
Lambda has cold starts (500ms-2s) when no recent invocations. For better UX:
- Keep Lambda warm with CloudWatch scheduled events
- Or accept the occasional slow first request

### Database Connections
Lambda creates new DB connections per invocation. Consider:
- Connection pooling with RDS Proxy (adds ~$15/month)
- Or accept higher connection churn for low traffic

### VITE_ Environment Variables
Frontend env vars with `VITE_` prefix must be available at **build time**, not runtime.
Pass them as build args in the GitHub Actions workflow.

### Secrets
Lambda loads secrets from Secrets Manager at runtime (on cold start).
This is different from ECS which injects them as environment variables.

## Files Changed

| File | Change |
|------|--------|
| `package.json` | Add build:client, build:lambda scripts |
| `server/index.lambda.ts` | New - Lambda entry point |
| `Dockerfile.lambda` | New - Lambda container image |
| `terraform/lambda.tf` | New - Lambda infrastructure |
| `terraform/frontend.tf` | New - S3 + CloudFront |
| `terraform/variables.tf` | Add use_lambda variable |
| `.github/workflows/deploy-lambda.yml` | New - Lambda deployment workflow |
