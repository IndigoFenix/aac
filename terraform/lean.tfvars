# =============================================================================
# AiVota - LEAN Mode Configuration
# =============================================================================
# Minimal-cost deployment for early-stage development.
# Disables security/compliance features and downsizes infrastructure.
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
# Other
# =============================================================================
existing_rds_endpoint          = ""
existing_rds_security_group_id = ""
session_timeout_minutes        = 60   # Longer timeout for dev convenience
