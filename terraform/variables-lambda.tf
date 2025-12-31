# =============================================================================
# Lambda Variables - Add to existing variables.tf
# =============================================================================

variable "use_lambda" {
  description = "Use Lambda + S3 instead of ECS (for cost savings during low traffic)"
  type        = bool
  default     = false
}

# When use_lambda = true:
# - Frontend is served from S3 + CloudFront
# - Backend runs on Lambda with Function URL
# - ECS/ALB resources are not created
# - Route 53 points to CloudFront instead of ALB

# When use_lambda = false (default):
# - Everything runs on ECS as before
# - ALB handles all traffic
