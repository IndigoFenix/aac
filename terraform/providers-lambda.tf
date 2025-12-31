# =============================================================================
# Provider Configuration for Lambda Support
# Add this to your existing terraform configuration
# =============================================================================

terraform {
  required_providers {
    time = {
      source  = "hashicorp/time"
      version = "~> 0.9"
    }
  }
}

# =============================================================================
# Additional Variables for Lambda
# =============================================================================

variable "use_api_gateway" {
  description = "Use API Gateway HTTP API instead of Lambda Function URL. Enable if Function URLs don't work in your region."
  type        = bool
  default     = false
}

# Note: Your main.tf should already have the AWS provider configured.
# This file just adds the time provider needed for Lambda deployment delays.
