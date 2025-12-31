# CliniAACian AWS Infrastructure Setup Guide

This guide walks you through setting up the HIPAA/FERPA-compliant AWS infrastructure for CliniAACian.

## Table of Contents
1. [Prerequisites](#prerequisites)
2. [Manual AWS Setup Steps](#manual-aws-setup-steps)
3. [GitHub Configuration](#github-configuration)
4. [First Deployment](#first-deployment)
5. [Post-Deployment Configuration](#post-deployment-configuration)
6. [Ongoing Operations](#ongoing-operations)

---

## Prerequisites

Before starting, ensure you have:
- AWS account with administrative access
- GitHub repository for your code
- AWS CLI installed and configured locally
- Terraform installed (v1.5+)
- A domain name (optional but recommended)

---

## Manual AWS Setup Steps

### Step 1: Initial AWS Account Configuration

#### 1.1 Enable MFA on Root Account
```
1. Sign in to AWS Console as root
2. Go to IAM → Security credentials
3. Enable MFA
4. Use a hardware key or authenticator app
```

#### 1.2 Create an Admin IAM User (for initial setup only)
```bash
# Using AWS CLI (after configuring with root credentials temporarily)
aws iam create-user --user-name admin-setup

aws iam attach-user-policy \
    --user-name admin-setup \
    --policy-arn arn:aws:iam::aws:policy/AdministratorAccess

aws iam create-access-key --user-name admin-setup
# Save these credentials securely - you'll use them for initial Terraform setup
```

### Step 2: Bootstrap Terraform State Storage

Before Terraform can manage infrastructure, we need a place to store its state. This is a chicken-and-egg problem, so we do this manually first.

```bash
# Set your AWS region
export AWS_REGION=il-central-1
export ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)

# Create S3 bucket for Terraform state
aws s3api create-bucket \
    --bucket cliniaacian-prod-terraform-state \
    --region $AWS_REGION \
    --create-bucket-configuration LocationConstraint=$AWS_REGION

# Enable versioning
aws s3api put-bucket-versioning \
    --bucket cliniaacian-prod-terraform-state \
    --versioning-configuration Status=Enabled

# Enable encryption
aws s3api put-bucket-encryption \
    --bucket cliniaacian-prod-terraform-state \
    --server-side-encryption-configuration '{
        "Rules": [{
            "ApplyServerSideEncryptionByDefault": {
                "SSEAlgorithm": "AES256"
            }
        }]
    }'

# Block public access
aws s3api put-public-access-block \
    --bucket cliniaacian-prod-terraform-state \
    --public-access-block-configuration '{
        "BlockPublicAcls": true,
        "IgnorePublicAcls": true,
        "BlockPublicPolicy": true,
        "RestrictPublicBuckets": true
    }'

# Create DynamoDB table for state locking
aws dynamodb create-table \
    --table-name terraform-state-lock \
    --attribute-definitions AttributeName=LockID,AttributeType=S \
    --key-schema AttributeName=LockID,KeyType=HASH \
    --billing-mode PAY_PER_REQUEST \
    --region $AWS_REGION
```

### Step 3: Create GitHub OIDC Provider

This allows GitHub Actions to authenticate with AWS without storing long-lived credentials.

```bash
# Create the OIDC provider
aws iam create-open-id-connect-provider \
    --url https://token.actions.githubusercontent.com \
    --client-id-list sts.amazonaws.com \
    --thumbprint-list 6938fd4d98bab03faadb97b34396831e3780aea1 1c58a3a8518e8759bf075b76b750d4f2df264fcd
```

### Step 4: Create GitHub Actions IAM Role

Create a file `github-actions-trust-policy.json`:
```json
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Effect": "Allow",
            "Principal": {
                "Federated": "arn:aws:iam::YOUR_ACCOUNT_ID:oidc-provider/token.actions.githubusercontent.com"
            },
            "Action": "sts:AssumeRoleWithWebIdentity",
            "Condition": {
                "StringEquals": {
                    "token.actions.githubusercontent.com:aud": "sts.amazonaws.com"
                },
                "StringLike": {
                    "token.actions.githubusercontent.com:sub": "repo:IndigoFenix/aac:*"
                }
            }
        }
    ]
}
```

**IMPORTANT:** Replace:
- `YOUR_ACCOUNT_ID` with your AWS account ID
- The GitHub repo is already set to `IndigoFenix/aac`

```bash
# Create the role
aws iam create-role \
    --role-name cliniaacian-github-actions-bootstrap \
    --assume-role-policy-document file://github-actions-trust-policy.json

# Attach AdministratorAccess temporarily (Terraform will create more restricted roles)
aws iam attach-role-policy \
    --role-name cliniaacian-github-actions-bootstrap \
    --policy-arn arn:aws:iam::aws:policy/AdministratorAccess
```

### Step 5: Initial Terraform Deployment (Local)

Run Terraform locally first to create the infrastructure:

```bash
cd terraform

# Initialize Terraform
terraform init \
    -backend-config="bucket=cliniaacian-prod-terraform-state" \
    -backend-config="key=cliniaacian/prod/terraform.tfstate" \
    -backend-config="region=il-central-1"

# Plan the deployment (no domain initially - HTTP only)
terraform plan \
    -var="environment=prod" \
    -var="aws_region=il-central-1" \
    -var="domain_name=" \
    -out=tfplan

# Review the plan carefully, then apply
terraform apply tfplan
```

Note: This will create the RDS database with auto-generated credentials stored in Secrets Manager.

### Step 6: Configure Secrets in AWS Secrets Manager

After Terraform creates the resources, the database credentials are automatically generated and stored.
You only need to update the application secrets:

```bash
# Update application secrets (database credentials are auto-generated)
aws secretsmanager put-secret-value \
    --secret-id cliniaacian-prod/app-secrets \
    --secret-string '{
        "SESSION_SECRET": "'$(openssl rand -base64 32)'",
        "OPENAI_API_KEY": "sk-your-api-key",
        "JWT_SECRET": "'$(openssl rand -base64 32)'",
        "ENCRYPTION_KEY": "'$(openssl rand -base64 32)'"
    }'

# View the auto-generated database credentials (if needed)
aws secretsmanager get-secret-value \
    --secret-id cliniaacian-prod/database \
    --query SecretString --output text | jq .
```

### Step 7: (Optional) Set Up Domain and HTTPS

Once you have a domain name, update Terraform:

```bash
terraform plan \
    -var="environment=prod" \
    -var="aws_region=il-central-1" \
    -var="domain_name=app.yourdomain.com" \
    -out=tfplan

terraform apply tfplan
```

Then validate the ACM certificate:
1. Go to AWS Console → Certificate Manager
2. Find the certificate created by Terraform
3. Click "Create records in Route 53" (if using Route 53) or add the CNAME record to your DNS provider
4. Wait for validation (can take up to 30 minutes)

---

## GitHub Configuration

### Step 1: Add Repository Secrets

Go to your GitHub repository → Settings → Secrets and variables → Actions → New repository secret

Add these secrets:

| Secret Name | Value |
|-------------|-------|
| `AWS_ROLE_ARN` | `arn:aws:iam::YOUR_ACCOUNT_ID:role/cliniaacian-prod-github-actions-role` |
| `TF_STATE_BUCKET` | `cliniaacian-prod-terraform-state` |

### Step 2: Create Environments

1. Go to Settings → Environments
2. Create `production` environment
3. Add required reviewers (for manual approval before prod deploy)
4. Create `staging` environment (no reviewers needed)

### Step 3: Add Workflow File

Copy the `.github/workflows/deploy.yml` file to your repository.

Update line 8-11 with your settings:
```yaml
env:
  AWS_REGION: il-central-1  # Your region
  ECR_REPOSITORY: cliniaacian
  ECS_SERVICE: cliniaacian-service
  ECS_CLUSTER: cliniaacian-cluster
```

---

## First Deployment

### Step 1: Push Initial Docker Image

Before the first ECS deployment can work, you need an image in ECR:

```bash
# Login to ECR
aws ecr get-login-password --region il-central-1 | docker login --username AWS --password-stdin YOUR_ACCOUNT_ID.dkr.ecr.il-central-1.amazonaws.com

# Build and push
docker build -t cliniaacian .
docker tag cliniaacian:latest YOUR_ACCOUNT_ID.dkr.ecr.il-central-1.amazonaws.com/cliniaacian:latest
docker push YOUR_ACCOUNT_ID.dkr.ecr.il-central-1.amazonaws.com/cliniaacian:latest
```

### Step 2: Trigger Deployment

```bash
git add .
git commit -m "Add AWS infrastructure"
git push origin main
```

Watch the GitHub Actions workflow run.

---

## Post-Deployment Configuration

### Step 1: Access Your Application

Without a domain, access your application via the ALB DNS:
```bash
# Get the ALB DNS name
aws elbv2 describe-load-balancers \
    --names cliniaacian-prod-alb \
    --query 'LoadBalancers[0].DNSName' \
    --output text

# Test the health endpoint
curl http://<ALB_DNS>/health
```

### Step 2: (Later) Set Up DNS

When you have a domain, add a CNAME record:
```
app.yourdomain.com → cliniaacian-prod-alb-XXXXX.il-central-1.elb.amazonaws.com
```

Then update Terraform with the domain_name variable to enable HTTPS.

### Step 3: Configure Alerts

Update the SNS subscription to receive alerts:
```bash
aws sns subscribe \
    --topic-arn arn:aws:sns:il-central-1:YOUR_ACCOUNT_ID:cliniaacian-prod-alerts \
    --protocol email \
    --notification-endpoint your-email@example.com
```

### Step 3: Verify Security Configuration

Run these checks:
```bash
# Check GuardDuty is enabled
aws guardduty list-detectors

# Check CloudTrail is logging
aws cloudtrail describe-trails

# Check WAF rules
aws wafv2 list-web-acls --scope REGIONAL --region il-central-1

# Check S3 buckets are private
aws s3api get-public-access-block --bucket cliniaacian-prod-uploads-YOUR_ACCOUNT_ID
```

---

## Ongoing Operations

### Viewing Logs

```bash
# Application logs
aws logs tail /ecs/cliniaacian-prod --follow

# View specific time range
aws logs filter-log-events \
    --log-group-name /ecs/cliniaacian-prod \
    --start-time $(date -d "1 hour ago" +%s000) \
    --filter-pattern "ERROR"
```

### Connecting to Container (for debugging)

```bash
# Enable ECS Exec (already configured in Terraform)
aws ecs execute-command \
    --cluster cliniaacian-prod-cluster \
    --task TASK_ID \
    --container cliniaacian-app \
    --command "/bin/sh" \
    --interactive
```

### Rotating Secrets

```bash
# Generate new secret
NEW_SECRET=$(openssl rand -base64 32)

# Update in Secrets Manager
aws secretsmanager put-secret-value \
    --secret-id cliniaacian-prod/app-secrets \
    --secret-string "{\"SESSION_SECRET\": \"$NEW_SECRET\", ...}"

# Force ECS to pick up new secrets
aws ecs update-service \
    --cluster cliniaacian-prod-cluster \
    --service cliniaacian-prod-service \
    --force-new-deployment
```

### Cost Monitoring

Set up a budget alert:
```bash
aws budgets create-budget \
    --account-id YOUR_ACCOUNT_ID \
    --budget '{
        "BudgetName": "CliniAACian-Monthly",
        "BudgetLimit": {"Amount": "500", "Unit": "USD"},
        "BudgetType": "COST",
        "TimeUnit": "MONTHLY"
    }' \
    --notifications-with-subscribers '[{
        "Notification": {
            "NotificationType": "ACTUAL",
            "ComparisonOperator": "GREATER_THAN",
            "Threshold": 80
        },
        "Subscribers": [{
            "SubscriptionType": "EMAIL",
            "Address": "your-email@example.com"
        }]
    }]'
```

---

## Architecture Summary

| Component | Purpose | HIPAA/FERPA Compliance |
|-----------|---------|----------------------|
| VPC | Network isolation | Private subnets for data |
| ECS Fargate | Serverless containers | No server management |
| ALB + WAF | Load balancing + protection | TLS 1.2+, rate limiting |
| RDS PostgreSQL | Database | Encrypted at rest, SSL required, automated backups |
| S3 | File storage | Encrypted, versioned |
| Secrets Manager | Credentials | Encrypted, audit logged |
| CloudTrail | Audit logging | All API calls logged |
| GuardDuty | Threat detection | Automated scanning |
| KMS | Encryption keys | Customer-managed keys |

### Initial Setup (HTTP Only)
When you first deploy without a domain, the application runs over HTTP.
This is suitable for initial testing but **not for production with real data**.

### Adding HTTPS (Required for Production)
Once you have a domain:
1. Update `domain_name` variable in Terraform
2. Apply changes
3. Validate ACM certificate via DNS
4. Route 53 or your DNS provider points to ALB

---

## Troubleshooting

### Deployment Fails with "No images found"
- Push an initial image to ECR manually (see First Deployment section)

### Certificate Validation Pending
- Check DNS records are correctly configured
- Wait up to 30 minutes for propagation

### ECS Tasks Keep Failing
- Check CloudWatch logs: `/ecs/cliniaacian-prod`
- Verify secrets are correctly configured
- Check security groups allow necessary traffic

### GitHub Actions Can't Assume Role
- Verify the trust policy has correct GitHub org/repo
- Check OIDC provider thumbprints
- Ensure environment names match

---

## Security Checklist

- [ ] MFA enabled on root account
- [ ] No long-lived access keys in use
- [ ] All S3 buckets have public access blocked
- [ ] All data encrypted at rest
- [ ] TLS 1.2+ enforced on all endpoints
- [ ] WAF enabled on ALB
- [ ] GuardDuty enabled
- [ ] CloudTrail enabled
- [ ] VPC flow logs enabled
- [ ] Secrets stored in Secrets Manager (not environment variables)
- [ ] Regular access reviews scheduled
