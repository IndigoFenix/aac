# =============================================================================
# AiVota - ECS LEAN profile (the active production profile)
# =============================================================================
# ECS Fargate behind the ALB, static frontends on S3 + CloudFront, with the
# security/compliance add-ons still switched off to keep the bill small.
# `terraform.tfvars` is auto-loaded as the base; this file overrides it.
#
# Usage (the deploy workflow does this):
#   terraform plan  -var-file=ecs-lean.tfvars
#   terraform apply -var-file=ecs-lean.tfvars
#
# WARNING: NOT HIPAA/FERPA compliant. Switch the workflow's deploy_profile to
# `hipaa` (terraform/hipaa.tfvars) before handling real patient or student
# data — same resources, compliance flags flipped on.
# =============================================================================

environment = "prod"
aws_region  = "il-central-1"
domain_name = "aivota.ai"

# =============================================================================
# Architecture - ECS Fargate
# =============================================================================
use_lambda              = false
lambda_image_exists     = false
frontend_via_cloudfront = true   # landing/app/aac from S3; API + WS proxied to the ALB
api_subdomain           = "api"  # https://api.aivota.ai → ALB (AAC clients bake this in)

# One task is enough at current load. Sized up from the 512/1024 default
# because uploads are buffered in memory (multer.memoryStorage) and a live
# session holds several WebSockets + model clients per student.
ecs_task_cpu        = 1024
ecs_task_memory     = 2048
ecs_desired_count   = 1
ecs_autoscaling_max = 3
container_port      = 5000

alb_idle_timeout_seconds = 300

# Single task → Postgres LISTEN/NOTIFY is enough for realtime fanout.
enable_redis = false

# =============================================================================
# Security & Compliance - DISABLED for cost savings
# =============================================================================
enable_waf       = false   # ~$5/month + per-request
enable_guardduty = false

# =============================================================================
# Audit & Logging - DISABLED for cost savings
# =============================================================================
enable_cloudtrail          = false
enable_vpc_flow_logs       = false
enable_cloudfront_logging  = true
app_log_retention_days     = 14
# 180 days = the 6-month floor the AKIM information-security appendix asks for
# (§5.8 "הרישום יישמר למשך 6 חודשים"). Applies to the RDS PostgreSQL log group;
# the other audit groups (CloudTrail, VPC flow, WAF) are off in this profile, so
# a customer who needs the full audit trail still needs the `hipaa` profile.
# Cost of the bump is negligible — one low-volume log group.
audit_log_retention_days   = 180

# Alarm / GuardDuty delivery. Empty = alarms fire with nobody subscribed.
# Use a mailbox that exists and is read; SNS sends a one-time confirmation.
# Deliberately its OWN variable rather than reusing email_reply_to: security
# alerts and customer replies should be re-pointable independently. For now both
# land in the same mailbox because there is one person reading mail.
# Re-point this (not email_reply_to) the moment there is a security rota.
alert_email = "cs@aivota.ai"

# =============================================================================
# Network - REDUCED for cost savings
# =============================================================================
single_nat_gateway             = true    # one NAT instead of one per AZ
enable_vpc_interface_endpoints = false   # ECR/Secrets/Logs traffic via NAT

# =============================================================================
# Database - SMALLEST tier
# =============================================================================
db_instance_class              = "db.t3.micro"
db_allocated_storage           = 20
db_max_allocated_storage       = 40
enable_rds_enhanced_monitoring = false

# =============================================================================
# TURN relay (live video calls)
# =============================================================================
enable_coturn        = true
coturn_instance_type = "t4g.micro"

# =============================================================================
# Other
# =============================================================================
enable_aac_auto_update         = true
existing_rds_endpoint          = ""
existing_rds_security_group_id = ""
session_timeout_minutes        = 60

# =============================================================================
# Email authentication (SPF / DKIM / DMARC) — see docs/EMAIL.md
# =============================================================================
# Keep in sync across ALL tfvars files: whichever profile applies publishes
# the records, and a half-configured domain silently loses authentication.
google_workspace_dkim_value = "v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAqdbq4tti3uOFkIWdsGaYM4ee7k6j4PUtoI4E8RefsYA3+yl0gGD8LN9y8/Dm38/CQzdRxaQ4vS8gwk9lmiZJlMzsJY+MYxc0uN0NxJBVs5U7OXua45tiPoCp/Tbn5N2pbS4+4VKN84Swmrjd8jLDbRpdoZkw9f8LVwafjacmnudnykWCzT5JHO54BVIsYeTNzYYa/TVeQTRf/1fM9lMfey1RvMB64mQWfADHND7CGgKyWstpHQx2w12JsFkm3+pzPWVR2zqwQpEkbRnWoCVs7MzuSKaerO/c0aRaGoPK0dXUSL2/tWav+BP8OIFCj8SY9tFAMcobAH3JsfxG0V2LMQIDAQAB"
dmarc_policy = "none"
dmarc_rua    = ["dmarc@aivota.ai"]
