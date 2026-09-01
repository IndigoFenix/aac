# =============================================================================
# AiVota - HIPAA / FERPA profile (ECS, full security)
# =============================================================================
# Same topology as ecs-lean.tfvars with every compliance control switched on:
# WAF on the ALB, CloudTrail + VPC flow logs, private VPC endpoints (task
# traffic to ECR/Secrets/Logs never leaves AWS), NAT per AZ, multi-task ECS
# with Redis fanout, larger multi-AZ RDS with enhanced monitoring, 90-day hot
# log retention (S3 keeps the 6-year archive).
#
# To switch: change the deploy workflow's `deploy_profile` input to `hipaa`
# (or set it as the default in .github/workflows/deploy.yml). No resource is
# recreated — flags flip and sizes grow in place. Expect the RDS class change
# to take a maintenance-window style restart.
#
# Usage:
#   terraform plan  -var-file=hipaa.tfvars
#   terraform apply -var-file=hipaa.tfvars
# =============================================================================

environment = "prod"
aws_region  = "il-central-1"
domain_name = "aivota.ai"

# =============================================================================
# Architecture - ECS Fargate, multi-task
# =============================================================================
use_lambda              = false
lambda_image_exists     = false
frontend_via_cloudfront = true
api_subdomain           = "api"

ecs_task_cpu        = 1024
ecs_task_memory     = 2048
ecs_desired_count   = 2      # ≥2 for HA across both AZs
ecs_autoscaling_max = 10
container_port      = 5000

alb_idle_timeout_seconds = 300

# Required once ecs_desired_count > 1: realtime fanout (person chat, calls,
# board sync) crosses tasks over Redis. REALTIME_BUS flips to "redis" and the
# generated auth token is injected from Secrets Manager automatically.
enable_redis                  = true
redis_node_type               = "cache.t4g.micro"
redis_num_cache_clusters      = 2      # primary + replica, automatic failover
redis_snapshot_retention_days = 7

# Task-definition template pinned by digest rather than mutable `:latest`.
ecr_image_exists = true

# No standing interactive shell into a PHI container. Enabling this also
# requires ssmmessages:* on the task role, which it does not have.
enable_ecs_exec = false

# Read-only container root; /tmp (ephemeral volume) is the only writable path.
# See ecs-lean.tfvars for why this is safe to have on.
ecs_readonly_root_fs = true

# =============================================================================
# Security & Compliance - ALL ENABLED
# =============================================================================
enable_waf       = true
enable_guardduty = true   # expects the account-level detector to exist (data source)

# =============================================================================
# Audit & Logging
# =============================================================================
enable_cloudtrail         = true
enable_vpc_flow_logs      = true
enable_cloudfront_logging = true
app_log_retention_days    = 90    # application / debug logs (hot tier)
audit_log_retention_days  = 2192  # 6 years: CloudTrail, VPC flow, RDS, WAF log groups stay in CloudWatch
                                  # (there is no CloudWatch→S3 export path; the S3 logs bucket only
                                  # holds ALB / S3-access / CloudTrail files)

# Where alarms and GuardDuty findings go. REQUIRED for the alerting pipeline
# to reach a human — an empty value leaves the SNS topic with no subscriber,
# which is the state the 2026-08 audit found. Use a mailbox that EXISTS and
# is read (a shared security alias is ideal); SNS sends a one-time
# confirmation email after apply and delivers nothing until it is clicked.
# Own variable so security alerts can be re-pointed independently of customer
# replies; same mailbox for now (one person). See ecs-lean.tfvars.
alert_email = "alerts@aivota.ai"

# =============================================================================
# Operational access (SSM)
# =============================================================================
# Interactive SSM shell transcripts → the logs bucket under ssm-sessions/.
# Together with CloudTrail above this is the complete remote-access record:
# transcripts for shell sessions, StartSession/TerminateSession events for the
# port-forwarding (DB tunnel) sessions, which have no shell to transcribe.
enable_ssm_session_logging = true

# =============================================================================
# Network - full isolation
# =============================================================================
single_nat_gateway             = false   # one NAT per AZ
enable_vpc_interface_endpoints = true    # ECR / Secrets Manager / CloudWatch Logs stay in-VPC

# =============================================================================
# Database - production tier (multi-AZ is forced for environment = prod)
# =============================================================================
db_instance_class              = "db.t3.medium"
db_allocated_storage           = 20
db_max_allocated_storage       = 100
enable_rds_enhanced_monitoring = true

# =============================================================================
# TURN relay (live video calls)
# =============================================================================
enable_coturn        = true
coturn_instance_type = "t4g.micro"
# Pinned container image; the host also joins the AL2023 weekly security patch
# baseline (terraform/ssm.tf) — it is the only internet-facing EC2 host we run.
coturn_image_tag = "4.17.2"

# =============================================================================
# Other
# =============================================================================
enable_aac_auto_update         = true
existing_rds_endpoint          = ""
existing_rds_security_group_id = ""
session_timeout_minutes        = 30   # HIPAA-recommended idle timeout

# =============================================================================
# Email authentication (SPF / DKIM / DMARC) — see docs/EMAIL.md
# =============================================================================
# Keep in sync across ALL tfvars files.
google_workspace_dkim_value = "v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAqdbq4tti3uOFkIWdsGaYM4ee7k6j4PUtoI4E8RefsYA3+yl0gGD8LN9y8/Dm38/CQzdRxaQ4vS8gwk9lmiZJlMzsJY+MYxc0uN0NxJBVs5U7OXua45tiPoCp/Tbn5N2pbS4+4VKN84Swmrjd8jLDbRpdoZkw9f8LVwafjacmnudnykWCzT5JHO54BVIsYeTNzYYa/TVeQTRf/1fM9lMfey1RvMB64mQWfADHND7CGgKyWstpHQx2w12JsFkm3+pzPWVR2zqwQpEkbRnWoCVs7MzuSKaerO/c0aRaGoPK0dXUSL2/tWav+BP8OIFCj8SY9tFAMcobAH3JsfxG0V2LMQIDAQAB"
dmarc_policy = "none"
dmarc_rua    = ["dmarc@aivota.ai"]
