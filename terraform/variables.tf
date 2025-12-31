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
