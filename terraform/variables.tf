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
  description = "CloudWatch log retention in days"
  type        = number
  default     = 90  # HIPAA requires minimum 6 years, but CloudWatch can be expensive
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
  description = "Session timeout in minutes"
  type        = number
  default     = 30
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
  description = "Subdomain under domain_name to serve the AAC update channel from. Final URL = https://<subdomain>.<domain_name>/. Ignored when domain_name is empty (the bucket still gets a CloudFront-only URL output)."
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

variable "coturn_credential_ttl_seconds" {
  description = "Lifetime of a minted TURN credential. The app embeds the expiry in the username; coturn rejects it afterward. One hour comfortably outlasts any call."
  type        = number
  default     = 3600
}
