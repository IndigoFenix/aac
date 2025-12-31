# =============================================================================
# Outputs - Fixed for Lambda conditional mode
# =============================================================================

# Application URL
output "app_url" {
  description = "URL to access the application"
  value       = var.domain_name != "" ? "https://${var.domain_name}" : (var.use_lambda && var.lambda_image_exists ? aws_cloudfront_distribution.frontend[0].domain_name : "http://${aws_lb.main.dns_name}")
}

# ALB DNS (only when not using Lambda)
output "alb_dns_name" {
  description = "DNS name of the Application Load Balancer"
  value       = aws_lb.main.dns_name
}

# RDS
output "rds_endpoint" {
  description = "RDS endpoint"
  value       = aws_db_instance.main.endpoint
  sensitive   = true
}

output "rds_identifier" {
  description = "RDS instance identifier"
  value       = aws_db_instance.main.identifier
}

# ECR
output "ecr_repository_url" {
  description = "ECR repository URL for ECS"
  value       = aws_ecr_repository.main.repository_url
}

# Lambda ECR (only when using Lambda)
output "lambda_ecr_repository_url" {
  description = "ECR repository URL for Lambda images"
  value       = var.use_lambda ? aws_ecr_repository.lambda[0].repository_url : null
}

# Lambda function name (only when Lambda exists)
output "lambda_function_name" {
  description = "Lambda function name"
  value       = var.use_lambda && var.lambda_image_exists ? aws_lambda_function.api[0].function_name : null
}

# Lambda/API Gateway URL (only when Lambda exists)
output "lambda_function_url" {
  description = "Lambda API endpoint URL (Function URL or API Gateway)"
  value = var.use_lambda && var.lambda_image_exists ? (
    var.use_api_gateway ? aws_apigatewayv2_api.lambda[0].api_endpoint : aws_lambda_function_url.api[0].function_url
  ) : null
}

# Frontend bucket (only when using Lambda)
output "frontend_bucket_name" {
  description = "S3 bucket for frontend static files"
  value       = var.use_lambda ? aws_s3_bucket.frontend[0].bucket : null
}

# CloudFront distribution (only when Lambda exists)
output "cloudfront_distribution_id" {
  description = "CloudFront distribution ID (for cache invalidation)"
  value       = var.use_lambda && var.lambda_image_exists ? aws_cloudfront_distribution.frontend[0].id : null
}

output "cloudfront_domain_name" {
  description = "CloudFront distribution domain name"
  value       = var.use_lambda && var.lambda_image_exists ? aws_cloudfront_distribution.frontend[0].domain_name : null
}

# S3 Buckets
output "uploads_bucket" {
  description = "S3 bucket for user uploads"
  value       = aws_s3_bucket.uploads.bucket
}

output "logs_bucket" {
  description = "S3 bucket for logs"
  value       = aws_s3_bucket.logs.bucket
}

# Secrets
output "database_secret_arn" {
  description = "ARN of the database credentials secret"
  value       = aws_secretsmanager_secret.database.arn
}

output "app_secrets_arn" {
  description = "ARN of the application secrets"
  value       = aws_secretsmanager_secret.app_secrets.arn
}

# WAF (only when WAF enabled AND not using Lambda)
output "waf_web_acl_arn" {
  description = "WAF Web ACL ARN"
  value       = var.enable_waf && !var.use_lambda ? aws_wafv2_web_acl.main[0].arn : null
}

# KMS
output "kms_key_arn" {
  description = "KMS key ARN for encryption"
  value       = aws_kms_key.main.arn
}

# VPC
output "vpc_id" {
  description = "VPC ID"
  value       = aws_vpc.main.id
}

output "private_subnet_ids" {
  description = "Private subnet IDs"
  value       = aws_subnet.private[*].id
}

output "public_subnet_ids" {
  description = "Public subnet IDs"
  value       = aws_subnet.public[*].id
}

# Local to get the API URL - uses one() to safely get from either resource
locals {
  # one() returns null if the list is empty, the element if it has one item
  function_url_endpoint = one(aws_lambda_function_url.api[*].function_url)
  api_gateway_endpoint  = one(aws_apigatewayv2_api.lambda[*].api_endpoint)
  
  # coalesce() returns the first non-null value
  api_url_output = var.use_lambda && var.lambda_image_exists ? coalesce(
    local.api_gateway_endpoint,
    local.function_url_endpoint,
    "No API endpoint"
  ) : "N/A"
}

# Deployment summary
output "deployment_summary" {
  description = "Current deployment configuration"
  value = var.use_lambda ? (
    var.lambda_image_exists ? join("\n", [
      "",
      "========================================",
      "Deployment: Lambda + S3 (Serverless)",
      "========================================",
      "",
      "Frontend URL: https://${var.domain_name}",
      "API URL: ${local.api_url_output}",
      "API Type: ${var.use_api_gateway ? "API Gateway HTTP API" : "Lambda Function URL"}",
      "CloudFront: ${aws_cloudfront_distribution.frontend[0].domain_name}",
      "S3 Bucket: ${aws_s3_bucket.frontend[0].bucket}",
      ""
    ]) : join("\n", [
      "",
      "========================================",
      "Deployment: Lambda Setup Phase 1",
      "========================================",
      "",
      "ECR Repository: ${aws_ecr_repository.lambda[0].repository_url}",
      "S3 Bucket: ${aws_s3_bucket.frontend[0].bucket}",
      "",
      "NEXT STEPS:",
      "1. Push Lambda image to ECR (GitHub Actions will do this)",
      "2. Set lambda_image_exists = true in terraform.tfvars",
      "3. Run terraform apply again",
      ""
    ])
  ) : join("\n", [
    "",
    "========================================",
    "Deployment: ECS (Containers)",
    "========================================",
    "",
    "URL: https://${var.domain_name}",
    "ALB: ${aws_lb.main.dns_name}",
    ""
  ])
}
