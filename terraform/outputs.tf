# =============================================================================
# Outputs - Fixed for Lambda conditional mode
# =============================================================================

# Application URL
output "app_url" {
  description = "URL to access the application"
  value       = var.domain_name != "" ? "https://app.${var.domain_name}" : (var.use_lambda && var.lambda_image_exists ? aws_cloudfront_distribution.frontend[0].domain_name : "http://${aws_lb.main.dns_name}")
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

# Frontend bucket (whenever the S3 + CloudFront stack is provisioned)
output "frontend_bucket_name" {
  description = "S3 bucket for frontend static files"
  value       = local.cdn_phase1 ? aws_s3_bucket.frontend[0].bucket : null
}

# CloudFront distribution (once the backend origin exists)
output "cloudfront_distribution_id" {
  description = "CloudFront distribution ID (for cache invalidation)"
  value       = local.cdn_phase2 ? aws_cloudfront_distribution.frontend[0].id : null
}

output "cloudfront_domain_name" {
  description = "CloudFront distribution domain name (landing page)"
  value       = local.cdn_phase2 ? aws_cloudfront_distribution.frontend[0].domain_name : null
}

# App subdomain CloudFront
output "app_cloudfront_distribution_id" {
  description = "CloudFront distribution ID for app subdomain"
  value       = local.cdn_phase2 && var.domain_name != "" ? aws_cloudfront_distribution.app[0].id : null
}

output "app_cloudfront_domain_name" {
  description = "CloudFront distribution domain name for app subdomain"
  value       = local.cdn_phase2 && var.domain_name != "" ? aws_cloudfront_distribution.app[0].domain_name : null
}

# =============================================================================
# ECS path — consumed by .github/workflows/deploy.yml
# =============================================================================
output "ecs_cluster_name" {
  description = "ECS cluster name"
  value       = aws_ecs_cluster.main.name
}

output "ecs_service_name" {
  description = "ECS service name"
  value       = aws_ecs_service.main.name
}

output "ecs_task_family" {
  description = "ECS task definition family (the deploy step renders the new image onto its latest revision)"
  value       = aws_ecs_task_definition.main.family
}

output "ecs_container_name" {
  description = "Container name inside the task definition"
  value       = "aivota-app"
}

output "ecs_active" {
  description = "true when the ECS service is the live backend (use_lambda = false)"
  value       = !var.use_lambda
}

# Direct backend URL (bypasses CloudFront). Bake into the packaged AAC clients.
output "api_url" {
  description = "Direct HTTPS URL of the backend: api.<domain> on the ECS path, the API Gateway endpoint on Lambda"
  value = var.use_lambda ? local.api_url_output : (
    local.api_host != "" ? "https://${local.api_host}" : "http://${aws_lb.main.dns_name}"
  )
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
      "Landing Page: https://${var.domain_name}",
      "App URL: https://app.${var.domain_name}",
      "API URL: ${local.api_url_output}",
      "API Type: ${var.use_api_gateway ? "API Gateway HTTP API" : "Lambda Function URL"}",
      "Landing CF: ${aws_cloudfront_distribution.frontend[0].domain_name}",
      "App CF: ${try(aws_cloudfront_distribution.app[0].domain_name, "N/A")}",
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
    "Deployment: ECS Fargate (${var.ecs_desired_count} task(s))",
    "========================================",
    "",
    "Landing Page: https://${var.domain_name}",
    "App URL: https://app.${var.domain_name}",
    "API URL: ${local.api_host != "" ? "https://${local.api_host}" : "http://${aws_lb.main.dns_name}"}",
    "Frontend: ${local.ecs_cdn ? "S3 + CloudFront" : "served by the ECS tasks"}",
    "Redis bus: ${var.enable_redis ? "on" : "off (Postgres LISTEN/NOTIFY)"}",
    "ALB: ${aws_lb.main.dns_name}",
    ""
  ])
}

# =============================================================================
# AAC Auto-Update Channel
# =============================================================================
# Surfaced for the publisher script and for editing electron-builder.yml's
# `publish.url`. Both are null when `enable_aac_auto_update` is false so
# downstream tooling can detect "stack not provisioned".

output "aac_update_bucket" {
  description = "S3 bucket name for AAC desktop client release artifacts. Pass to `npm run release:aac` as AAC_UPDATE_BUCKET."
  value       = var.enable_aac_auto_update ? aws_s3_bucket.aac_updates[0].bucket : null
}

output "aac_update_url" {
  description = "Public HTTPS URL the desktop client polls for `latest.yml`. Set as `publish.url` in electron-builder.yml. Falls back to the raw CloudFront domain when no custom domain is configured."
  value = var.enable_aac_auto_update ? (
    var.domain_name != ""
    ? "https://${local.aac_update_subdomain_effective}.${var.domain_name}/"
    : "https://${aws_cloudfront_distribution.aac_updates[0].domain_name}/"
  ) : null
}

output "aac_update_cloudfront_distribution_id" {
  description = "CloudFront distribution ID for the AAC update channel. Use with `aws cloudfront create-invalidation` if you ever need to force-purge `latest.yml` ahead of its no-cache TTL."
  value       = var.enable_aac_auto_update ? aws_cloudfront_distribution.aac_updates[0].id : null
}

# =============================================================================
# Access & hardening (Track G)
# =============================================================================

output "github_actions_role_arn" {
  description = "THE deploy role. Set the repo secret AWS_ROLE_ARN to this to move production off the out-of-band cliniaccian-github-actions-bootstrap (AdministratorAccess) role. Trusts repo:IndigoFenix/aac:ref:refs/heads/main only."
  value       = aws_iam_role.github_actions.arn
}

output "github_actions_plan_role_arn" {
  description = "Read-only role for pull-request `terraform plan`. Set the repo secret AWS_PLAN_ROLE_ARN to this. Trusts repo:IndigoFenix/aac:pull_request only. Has no live consumer until the infrastructure job's `if: github.ref == 'refs/heads/main'` gate is relaxed to allow PR events."
  value       = aws_iam_role.github_actions_plan.arn
}

output "ssm_session_log_location" {
  description = "S3 URI where interactive SSM shell transcripts land. Empty when session logging is off. Port-forwarding sessions (npm run db-tunnel) produce no transcript — see CloudTrail StartSession/TerminateSession for those."
  value       = var.enable_ssm_session_logging ? "s3://${aws_s3_bucket.logs.bucket}/${local.ssm_session_log_prefix}/" : ""
}

output "rds_iam_connect_policy_arn" {
  description = "Attach to an engineer (or an engineers group) to let them connect to Postgres as the aivota_engineer DB user with an IAM auth token. Inert until the one-time CREATE USER / GRANT rds_iam SQL in docs/INFRASTRUCTURE.md has been run."
  value       = aws_iam_policy.rds_iam_connect.arn
}

output "rds_resource_id" {
  description = "RDS resource id (db-XXXX). The stable half of the rds-db:connect ARN — survives a rename, does not survive a restore."
  value       = aws_db_instance.main.resource_id
}

output "coturn_patch_association_id" {
  description = "State Manager association that installs AL2023 security patches on the coturn relay every Saturday 00:00 UTC (03:00 Israel summer time). Null when coturn is disabled."
  value       = var.enable_coturn ? aws_ssm_association.coturn_patch[0].association_id : null
}
