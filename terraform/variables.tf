# =============================================================================
# Variables
# =============================================================================

variable "environment" {
  description = "Environment name (prod, staging, dev)"
  type        = string
  validation {
    condition     = contains(["prod", "staging", "dev"], var.environment)
    error_message = "Environment must be prod, staging, or dev."
  }
}

variable "aws_region" {
  description = "AWS region for resources"
  type        = string
  default     = "eu-west-1"
}

variable "domain_name" {
  description = "Domain name for the application"
  type        = string
  default     = ""
}

# =============================================================================
# ARCHITECTURE VARIABLES
# =============================================================================

variable "use_lambda" {
  description = "Use Lambda + S3 instead of ECS (for cost savings during low traffic)"
  type        = bool
  default     = false
}

variable "lambda_image_exists" {
  description = "Set to true after first deploying Lambda image to ECR. Required because Lambda can't be created without an image."
  type        = bool
  default     = false
}

variable "use_api_gateway" {
  description = "Use API Gateway HTTP API instead of Lambda Function URL. Enable if Function URLs don't work in your region (e.g., il-central-1)."
  type        = bool
  default     = false
}

# Frontend hosting is independent of the backend compute choice. With this on,
# the landing page, clinician SPA and AAC web build are served from S3 behind
# CloudFront, and CloudFront proxies /api/*, /auth/*, /ws/* and /health to the
# backend origin — API Gateway on the Lambda path, the ALB (via api.<domain>)
# on the ECS path. On the Lambda path it is effectively always on (Lambda has
# no other way to serve static files). On the ECS path, turning it off makes
# Express serve the bundled static files straight from the ALB instead.
variable "frontend_via_cloudfront" {
  description = "Serve the static frontends from S3 + CloudFront and proxy API/WS paths to the backend. Requires domain_name on the ECS path."
  type        = bool
  default     = true
}

# Hostname the backend is reachable on directly, bypassing CloudFront. The
# packaged AAC clients (Electron / iPad) bake this in as their API base so
# their WebSockets never traverse the CDN, and CloudFront uses it as its
# origin (the ALB cert must therefore cover it — see ecs.tf).
variable "api_subdomain" {
  description = "Subdomain under domain_name for direct ALB access (ECS path only). Empty disables the record."
  type        = string
  default     = "api"
}

# =============================================================================
# VPC Variables
# =============================================================================
variable "vpc_cidr" {
  description = "CIDR block for VPC"
  type        = string
  default     = "10.0.0.0/16"
}

# =============================================================================
# ECS Variables
# =============================================================================
variable "ecs_task_cpu" {
  description = "CPU units for ECS task"
  type        = number
  default     = 512
}

variable "ecs_task_memory" {
  description = "Memory (MB) for ECS task"
  type        = number
  default     = 1024
}

variable "ecs_desired_count" {
  description = "Desired number of ECS tasks"
  type        = number
  default     = 2
}

variable "container_port" {
  description = "Port the container listens on"
  type        = number
  default     = 5000
}

# The ALB drops a connection that carries no bytes for this long. The app
# holds idle WebSockets (/ws/live, /ws/call) and SSE streams open well past
# the 60s AWS default, so keep this comfortably above the client heartbeat.
variable "alb_idle_timeout_seconds" {
  description = "ALB connection idle timeout in seconds (WebSocket / SSE friendly)."
  type        = number
  default     = 300
}

variable "ecs_autoscaling_max" {
  description = "Upper bound for ECS service auto-scaling (ignored on the Lambda path)."
  type        = number
  default     = 10
}

variable "enable_ecs_exec" {
  description = "Allow `aws ecs execute-command` into a running task. Default OFF: it was hardcoded on for over a year while the task role never had ssmmessages:*, so it advertised an interactive path into a PHI container that could not actually be used. Turning it on means granting those actions to the task role AND accepting a shell into the container — do that deliberately, for a debugging window, not as a standing state."
  type        = bool
  default     = false
}

variable "ecs_readonly_root_fs" {
  description = "Mount the task's root filesystem read-only, with an ephemeral /tmp volume as the only writable path. Default false because it is a runtime break, not a config flip: every debug-log writer that opens a file under the app directory must be gated off first (see docs/INFRASTRUCTURE.md 'Access & hardening'). Both ECS profiles set it explicitly."
  type        = bool
  default     = false
}

variable "ecr_image_exists" {
  description = "Pin the Terraform task-definition template to the digest of the newest image in the ECR repo instead of the mutable `:latest` tag. Default false so the very first apply into an empty repository still works (same reason as lambda_image_exists); set true in the ECS profiles, where the repo has been populated since 2026-08. Does NOT change what is running — the deploy workflow renders its own sha-tagged image onto the revision it registers — it only fixes what a fresh apply or a rollback would create."
  type        = bool
  default     = false
}

# =============================================================================
# RDS Variables (for existing database connection)
# =============================================================================
variable "existing_rds_endpoint" {
  description = "Endpoint of existing RDS instance"
  type        = string
  default     = ""
}

variable "existing_rds_security_group_id" {
  description = "Security group ID of existing RDS"
  type        = string
  default     = ""
}

# =============================================================================
# Application Variables
# =============================================================================
variable "app_log_retention_days" {
  description = "CloudWatch retention for APPLICATION log groups (ECS app, Redis). Audit groups use audit_log_retention_days, which is where the 6-year requirement is met."
  type        = number
  default     = 90
}

variable "enable_waf" {
  description = "Enable WAF for ALB"
  type        = bool
  default     = true
}

variable "enable_guardduty" {
  description = "Enable GuardDuty"
  type        = bool
  default     = true
}

variable "session_timeout_minutes" {
  description = "Clinician/admin idle timeout in minutes — fed to the ECS task as SESSION_IDLE_TIMEOUT_MINUTES (server/session-lifetime.ts)"
  type        = number
  default     = 30
}

variable "alert_email" {
  description = "Email address subscribed to the alerts SNS topic (alarms, GuardDuty findings). Empty = no subscription, i.e. alarms fire into the void. The address must confirm the SNS subscription email once."
  type        = string
  default     = ""
}

variable "audit_log_retention_days" {
  description = "CloudWatch retention for AUDIT log groups (CloudTrail, VPC flow logs, RDS PostgreSQL, WAF). HIPAA §164.316(b)(2) wants 6 years = 2192; the hipaa profile sets that. App/debug logs use app_log_retention_days."
  type        = number
  default     = 90
}

# =============================================================================
# RDS Variables
# =============================================================================
variable "db_instance_class" {
  description = "RDS instance class"
  type        = string
  default     = "db.t3.medium"
}

variable "db_allocated_storage" {
  description = "Initial storage allocation in GB"
  type        = number
  default     = 20
}

variable "db_max_allocated_storage" {
  description = "Maximum storage for autoscaling in GB"
  type        = number
  default     = 100
}

# =============================================================================
# Lean Mode Variables (cost reduction toggles)
# =============================================================================

variable "enable_cloudtrail" {
  description = "Enable CloudTrail audit logging (disable for dev/lean to save costs)"
  type        = bool
  default     = true
}

variable "enable_vpc_flow_logs" {
  description = "Enable VPC flow logs (disable for dev/lean to save CloudWatch costs)"
  type        = bool
  default     = true
}

variable "enable_vpc_interface_endpoints" {
  description = "Enable VPC interface endpoints (ECR, Secrets Manager, CloudWatch Logs). S3 gateway endpoint is always enabled (free). When disabled, traffic routes through NAT gateway instead."
  type        = bool
  default     = true
}

variable "single_nat_gateway" {
  description = "Use a single NAT gateway instead of one per AZ (saves ~$32/month, reduces availability)"
  type        = bool
  default     = false
}

variable "enable_cloudfront_logging" {
  description = "Enable CloudFront access logging to S3 (useful for debugging origin errors)"
  type        = bool
  default     = true
}

variable "enable_rds_enhanced_monitoring" {
  description = "Enable RDS enhanced monitoring and Performance Insights (disable for dev/lean)"
  type        = bool
  default     = true
}

# =============================================================================
# Operational access (SSM)
# =============================================================================

variable "enable_ssm_session_logging" {
  description = "Record interactive SSM shell sessions to the existing logs bucket under ssm-sessions/ (terraform/ssm.tf). Default true — it costs nothing but the transcript bytes, and it is the only evidence that a human shell on the bastion ever happened. Port-forwarding sessions (npm run db-tunnel) have no shell and are NOT transcribed; they are evidenced by CloudTrail StartSession/TerminateSession, which needs enable_cloudtrail."
  type        = bool
  default     = true
}

# =============================================================================
# Redis / ElastiCache Variables
# =============================================================================
# Redis backs the cross-instance realtime fanout (server/services/realtime/
# bus.ts). Until we run more than one ECS task we don't need it — Postgres
# LISTEN/NOTIFY (REALTIME_BUS=postgres) is sufficient for the lean path.
# Enable this when moving to multi-instance ECS / HIPAA mode.

variable "enable_redis" {
  description = "Provision ElastiCache for Redis (used as the realtime fanout bus). Off in lean mode; on for full ECS / HIPAA."
  type        = bool
  default     = false
}

variable "redis_node_type" {
  description = "ElastiCache node type (e.g. cache.t4g.micro for low load, cache.m6g.large for production)"
  type        = string
  default     = "cache.t4g.micro"
}

variable "redis_num_cache_clusters" {
  description = "Number of cache nodes (1 = single node, 2+ = primary + replicas with automatic failover)"
  type        = number
  default     = 2
}

variable "redis_engine_version" {
  description = "Redis engine version"
  type        = string
  default     = "7.1"
}

variable "redis_snapshot_retention_days" {
  description = "Days to retain Redis snapshots (0 disables backups; HIPAA generally wants >0 even though we treat Redis as ID-only)"
  type        = number
  default     = 7
}

# =============================================================================
# AAC Auto-Update Channel
# =============================================================================
# Provisions the S3 bucket + CloudFront distribution + DNS record that the
# Aivota AAC desktop client (Electron + electron-updater) polls for new
# versions. See docs/AAC_AUTO_UPDATE.md for the runtime side.
#
# The published artifacts are NOT PHI — they're installer binaries and a
# manifest, intentionally world-readable so the desktop client can fetch
# them without auth. Lives outside the encrypted-PHI-bucket pattern used
# for the rest of the storage stack on purpose.

variable "enable_aac_auto_update" {
  description = "Provision the S3 + CloudFront + DNS stack the desktop AAC client polls for auto-update. Off by default so adding the resources doesn't churn existing deploys; flip to true and apply once before running `npm run release:aac` for the first time."
  type        = bool
  default     = false
}

variable "aac_update_subdomain" {
  description = "Base subdomain under domain_name for the AAC update channel. Prod serves from this verbatim (https://<subdomain>.<domain_name>/); non-prod environments are suffixed with the environment name (e.g. updates-staging) so they don't collide on the shared hosted zone's Route53 record + ACM cert. Ignored when domain_name is empty (the bucket still gets a CloudFront-only URL output)."
  type        = string
  default     = "updates"
}

variable "aac_update_installer_max_age_seconds" {
  description = "Cache-Control max-age (seconds) for installer + blockmap artifacts at the CloudFront edge. The artifacts are immutable per version, so a long TTL is safe. `latest.yml` is always served with no-cache regardless of this value."
  type        = number
  default     = 3600
}

# =============================================================================
# coturn TURN relay (live video calls)
# =============================================================================
# Self-hosted coturn EC2 instance providing a WebRTC TURN relay fallback for
# calls that can't establish a direct peer-to-peer path (symmetric NAT, strict
# corporate firewalls). The app mints time-limited HMAC credentials for it
# (see server/services/call/turnCredentials.ts). Media relayed through coturn
# stays DTLS-SRTP encrypted end-to-end — the relay never sees plaintext. See
# planning-docs/live-video-chat.md.

variable "enable_coturn" {
  description = "Provision the self-hosted coturn TURN relay (EC2 + EIP) and wire TURN_URLS/TURN_SECRET into the app. Off by default so adding the module doesn't churn existing deploys; on in lean.tfvars (the active path needs a relay fallback)."
  type        = bool
  default     = false
}

variable "coturn_instance_type" {
  description = "EC2 instance type for the coturn host. t4g.micro (ARM) is plenty for low call volume; size up for many concurrent relayed calls."
  type        = string
  default     = "t4g.micro"
}

variable "coturn_subdomain" {
  description = "Subdomain under domain_name for the TURN server (final host = <subdomain>.<domain_name>). Ignored when domain_name is empty (the raw EIP is used instead)."
  type        = string
  default     = "turn"
}

variable "coturn_relay_port_min" {
  description = "Low end of the UDP relay port range coturn allocates per call. Keep the range modest on small instances (each relayed call uses a couple of ports)."
  type        = number
  default     = 49160
}

variable "coturn_relay_port_max" {
  description = "High end of the UDP relay port range. coturn_relay_port_max - coturn_relay_port_min bounds concurrent relayed media streams."
  type        = number
  default     = 49260
}

variable "coturn_image_tag" {
  description = "Docker Hub tag for the coturn container. Was untagged (i.e. `:latest`), so what the relay ran depended on the day the host was last replaced. Pinned to a specific 4.x release instead — a TURN relay reachable from the whole internet should not silently change version. The pin only takes effect the next time the host is REPLACED (bump null_resource.coturn_version deliberately); user_data is in the instance's ignore_changes for exactly that reason."
  type        = string
  default     = "4.17.2"
}

variable "coturn_credential_ttl_seconds" {
  description = "Lifetime of a minted TURN credential. The app embeds the expiry in the username; coturn rejects it afterward. One hour comfortably outlasts any call."
  type        = number
  default     = 3600
}

# =============================================================================
# EMAIL (see docs/EMAIL.md)
# =============================================================================
# Google Workspace sends the humans' mail from the apex; Amazon SES (ses.tf)
# sends the app's transactional mail. Each needs SPF + DKIM, and one DMARC
# record at the apex governs both.

variable "google_workspace_dkim_value" {
  description = "TXT value for google._domainkey.<domain> — the DKIM public key generated in Google Admin (Apps > Google Workspace > Gmail > Authenticate email). Per-domain: regenerate if domain_name changes. Empty = no record (mail still authenticates via SPF, but DMARC alignment gets fragile)."
  type        = string
  default     = ""
}

variable "mail_sending_subdomain" {
  description = "Subdomain used as SES's custom MAIL FROM (Return-Path) domain — where SPF is checked and bounces land. Keeps bounce traffic off the apex; the visible From address stays on the apex (email_from)."
  type        = string
  default     = "send"
}

variable "email_from" {
  description = "From header for all transactional mail. Must be on domain_name (SES-verified) and must NOT be a human's mailbox or a Workspace alias of one — Gmail resolves known addresses against the directory and shows the owner's name instead of this display name."
  type        = string
  default     = "Aivota <noreply@aivota.ai>"
}

variable "email_reply_to" {
  description = "Reply-To for all transactional mail — the From address is unattended, so replies need a monitored mailbox."
  type        = string
  default     = "cs@aivota.ai"
}

variable "dmarc_policy" {
  description = "DMARC policy for unauthenticated mail: none (monitor only), quarantine, or reject. Start at none, read the rua reports, then tighten once Workspace and Resend both pass."
  type        = string
  default     = "none"
  validation {
    condition     = contains(["none", "quarantine", "reject"], var.dmarc_policy)
    error_message = "dmarc_policy must be none, quarantine, or reject."
  }
}

variable "dmarc_rua" {
  description = "Mailboxes receiving DMARC aggregate reports (bare addresses, no mailto:). Reports are gzipped XML, so the usual setup is your own address plus a digest service that mails a readable weekly summary. Empty list = no rua tag, i.e. no visibility into who is sending as this domain. NOTE: an address on a DIFFERENT domain only receives reports if that domain publishes an authorization record (<this domain>._report._dmarc.<their domain> TXT v=DMARC1) — digest services publish it for you, but it is why an off-domain rua can go silent."
  type        = list(string)
  default     = []
}
