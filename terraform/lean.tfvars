# =============================================================================
# AiVota - LEAN Mode Configuration (LEGACY — Lambda path, rollback only)
# =============================================================================
# Minimal-cost serverless deployment. Superseded by ecs-lean.tfvars (ECS) on
# 2026-08-20; kept so `deploy-lambda.yml` (workflow_dispatch) can roll
# production back to Lambda if the ECS cutover misbehaves. Applying this after
# an ECS apply scales the ECS service to 0 and re-points CloudFront at API
# Gateway — it does NOT destroy the ECS resources.
#
# Usage:
#   terraform plan  -var-file=lean.tfvars
#   terraform apply -var-file=lean.tfvars
#
# WARNING: This config is NOT HIPAA/FERPA compliant. Re-enable security
# features before handling real patient or student data.
# =============================================================================

environment = "prod"
aws_region  = "il-central-1"
domain_name = "aivota.ai"

# =============================================================================
# Architecture - Lambda serverless (same as production)
# =============================================================================
use_lambda          = true
lambda_image_exists = true
use_api_gateway     = true     # Function URLs not supported in il-central-1

# ECS disabled
ecs_task_cpu     = 256
ecs_task_memory  = 512
ecs_desired_count = 0
container_port   = 5000

# =============================================================================
# Security & Compliance - ALL DISABLED for cost savings
# =============================================================================
enable_waf       = false   # Saves ~$5/month
enable_guardduty = false   # Saves variable (usage-based)

# =============================================================================
# Audit & Logging - DISABLED for cost savings
# =============================================================================
enable_cloudtrail          = false   # Saves CloudWatch + S3 data event costs
enable_vpc_flow_logs       = false   # Saves CloudWatch Logs ingestion costs
enable_cloudfront_logging  = true    # Minimal cost, useful for debugging origin errors
app_log_retention_days = 14    # Shorter retention for remaining logs

# =============================================================================
# Network - REDUCED for cost savings
# =============================================================================
single_nat_gateway             = true    # Saves ~$32/month (1 NAT vs 2)
enable_vpc_interface_endpoints = false   # Saves ~$56/month (traffic uses NAT instead)

# =============================================================================
# Database - SMALLEST tier
# =============================================================================
db_instance_class        = "db.t3.micro"     # ~$12/month vs ~$52/month for t3.medium
db_allocated_storage     = 20                 # 20GB initial (gp3)
db_max_allocated_storage = 40                 # Cap autoscaling at 40GB
enable_rds_enhanced_monitoring = false        # Saves CloudWatch costs

# =============================================================================
# TURN relay (live video calls)
# =============================================================================
# Self-hosted coturn so calls behind symmetric NAT / strict firewalls still
# connect. ~t4g.micro + EIP. Media stays DTLS-SRTP encrypted through the relay.
enable_coturn        = true
coturn_instance_type = "t4g.micro"

# =============================================================================
# Other
# =============================================================================
existing_rds_endpoint          = ""
existing_rds_security_group_id = ""
session_timeout_minutes        = 60   # Longer timeout for dev convenience

# =============================================================================
# Email authentication (SPF / DKIM / DMARC) — see docs/EMAIL.md
# =============================================================================
# Keep these in sync across BOTH tfvars files: whichever path applies is the
# one that publishes the records, and a half-configured domain silently loses
# authentication on the other.

# Google Workspace DKIM public key (Admin > Apps > Google Workspace > Gmail >
# Authenticate email). Signs mail sent from real @aivota.ai mailboxes.
google_workspace_dkim_value = "v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAqdbq4tti3uOFkIWdsGaYM4ee7k6j4PUtoI4E8RefsYA3+yl0gGD8LN9y8/Dm38/CQzdRxaQ4vS8gwk9lmiZJlMzsJY+MYxc0uN0NxJBVs5U7OXua45tiPoCp/Tbn5N2pbS4+4VKN84Swmrjd8jLDbRpdoZkw9f8LVwafjacmnudnykWCzT5JHO54BVIsYeTNzYYa/TVeQTRf/1fM9lMfey1RvMB64mQWfADHND7CGgKyWstpHQx2w12JsFkm3+pzPWVR2zqwQpEkbRnWoCVs7MzuSKaerO/c0aRaGoPK0dXUSL2/tWav+BP8OIFCj8SY9tFAMcobAH3JsfxG0V2LMQIDAQAB"

# The app's transactional mail goes out via Amazon SES (terraform/ses.tf) —
# identity, DKIM and bounce-domain records are all created by apply; SES
# verifies automatically once the DKIM CNAMEs resolve. The ONE manual step is
# requesting production access (new SES accounts start in sandbox mode):
# AWS console > SES (il-central-1) > Account dashboard > Request production access.

# Start at p=none and read the reports; tighten to quarantine, then reject.
dmarc_policy = "none"
# Your own group first (raw XML archive), then optionally a digest service
# that mails a readable weekly summary, e.g. "...@dmarc.postmarkapp.com".
dmarc_rua    = ["dmarc@aivota.ai"]
