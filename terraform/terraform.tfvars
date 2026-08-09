# =============================================================================
# AiVota Terraform Variables
# =============================================================================
# Copy this file to terraform.tfvars and update the values
# DO NOT commit terraform.tfvars to version control

# Environment (prod, staging, dev)
environment = "prod"

# AWS Region - Choose an EU region for GDPR/data residency compliance
# eu-west-1 (Ireland) or eu-central-1 (Frankfurt) are good choices
aws_region = "il-central-1"

# Your domain name (leave empty to use ALB DNS with HTTP only)
# When you get a domain, add it here and Terraform will set up HTTPS
domain_name = "aivota.ai"

# Provision the S3 + CloudFront + DNS stack the desktop AAC client polls
# for auto-update. Served from https://updates.aivota.ai/ once applied.
enable_aac_auto_update = true

# =============================================================================
# Architecture Variables (Use lambda mode for cost saving)
# =============================================================================

use_lambda = true
lambda_image_exists = true   # ← Change this from false to true for phase 2
use_api_gateway = true   # Might be needed for newer regions

# =============================================================================
# ECS Configuration
# =============================================================================

# CPU units (256, 512, 1024, 2048, 4096)
# 512 is good for most Node.js applications
ecs_task_cpu = 512

# Memory in MB (512, 1024, 2048, etc.)
# Must be compatible with CPU: https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task_definition_parameters.html
ecs_task_memory = 1024

# Number of containers to run
# Production should have at least 2 for high availability
ecs_desired_count = 0  # Deactivate ECS for current phase

# Port your application listens on
container_port = 5000

# =============================================================================
# Existing Resources (if migrating)
# =============================================================================

# If you have an existing RDS database, provide these values
# Leave empty to let Terraform create new resources
existing_rds_endpoint         = ""
existing_rds_security_group_id = ""

# =============================================================================
# Logging and Monitoring
# =============================================================================

# CloudWatch log retention in days
# HIPAA recommends 6 years (2190 days), but this can be expensive
# Consider archiving to S3/Glacier for long-term retention
app_log_retention_days = 90

# Enable WAF (Web Application Firewall)
# Recommended for production
enable_waf = true

# Enable GuardDuty (Threat Detection)
# Recommended for all environments
enable_guardduty = true

# Session timeout in minutes
# 30 minutes is HIPAA recommended for healthcare applications
session_timeout_minutes = 30

# =============================================================================
# RDS Database Configuration
# =============================================================================

# Instance class - db.t3.medium is good for starting out
# For production with more load, consider db.r6g.large or larger
db_instance_class = "db.t3.medium"

# Initial storage in GB
db_allocated_storage = 20

# Maximum storage for autoscaling in GB
# RDS will automatically scale up to this limit
db_max_allocated_storage = 100

# =============================================================================
# Email authentication (SPF / DKIM / DMARC) — see docs/EMAIL.md
# =============================================================================
# Keep these in sync across BOTH tfvars files: whichever path applies is the
# one that publishes the records, and a half-configured domain silently loses
# authentication on the other.

# Google Workspace DKIM public key (Admin > Apps > Google Workspace > Gmail >
# Authenticate email). Signs mail sent from real @aivota.ai mailboxes.
google_workspace_dkim_value = "v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAqdbq4tti3uOFkIWdsGaYM4ee7k6j4PUtoI4E8RefsYA3+yl0gGD8LN9y8/Dm38/CQzdRxaQ4vS8gwk9lmiZJlMzsJY+MYxc0uN0NxJBVs5U7OXua45tiPoCp/Tbn5N2pbS4+4VKN84Swmrjd8jLDbRpdoZkw9f8LVwafjacmnudnykWCzT5JHO54BVIsYeTNzYYa/TVeQTRf/1fM9lMfey1RvMB64mQWfADHND7CGgKyWstpHQx2w12JsFkm3+pzPWVR2zqwQpEkbRnWoCVs7MzuSKaerO/c0aRaGoPK0dXUSL2/tWav+BP8OIFCj8SY9tFAMcobAH3JsfxG0V2LMQIDAQAB"

# Resend sends the app's transactional mail from send.aivota.ai. Fill these two
# in from the Resend dashboard after adding that domain (Domains > Add Domain);
# while they are empty the subdomain records are skipped and Resend cannot
# verify the domain, so every transactional send fails with validation_error.
mail_sending_subdomain = "send"
resend_bounce_mx_host  = ""   # e.g. feedback-smtp.eu-west-1.amazonses.com
resend_dkim_value      = ""   # p=MIIBIjANBgkq... from the same page

# Start at p=none and read the reports; tighten to quarantine, then reject.
dmarc_policy = "none"
dmarc_rua    = "dmarc@aivota.ai"
