# =============================================================================
# Lambda Outputs - Add to existing outputs.tf
# =============================================================================

output "lambda_function_url" {
  description = "Lambda function URL for API"
  value       = var.use_lambda ? aws_lambda_function_url.api[0].function_url : null
}

output "lambda_function_name" {
  description = "Lambda function name"
  value       = var.use_lambda ? aws_lambda_function.api[0].function_name : null
}

output "frontend_bucket_name" {
  description = "S3 bucket for frontend static files"
  value       = var.use_lambda ? aws_s3_bucket.frontend[0].bucket : null
}

output "cloudfront_distribution_id" {
  description = "CloudFront distribution ID (for cache invalidation)"
  value       = var.use_lambda ? aws_cloudfront_distribution.frontend[0].id : null
}

output "cloudfront_domain_name" {
  description = "CloudFront distribution domain name"
  value       = var.use_lambda ? aws_cloudfront_distribution.frontend[0].domain_name : null
}

output "lambda_ecr_repository_url" {
  description = "ECR repository URL for Lambda images"
  value       = aws_ecr_repository.lambda.repository_url
}

output "deployment_summary" {
  description = "Current deployment configuration"
  value = var.use_lambda ? <<-EOT
    
    ========================================
    Deployment: Lambda + S3 (Serverless)
    ========================================
    
    Frontend URL: https://${var.domain_name}
    API URL: ${aws_lambda_function_url.api[0].function_url}
    CloudFront: ${aws_cloudfront_distribution.frontend[0].domain_name}
    S3 Bucket: ${aws_s3_bucket.frontend[0].bucket}
    
    To deploy:
    1. Push to main branch
    2. GitHub Actions will:
       - Build frontend → S3
       - Build Lambda image → ECR → Lambda
       - Invalidate CloudFront cache
    
    EOT
  : <<-EOT
    
    ========================================
    Deployment: ECS (Containers)
    ========================================
    
    URL: https://${var.domain_name}
    ALB: ${aws_lb.main.dns_name}
    
    To switch to Lambda (cost savings):
    1. Set use_lambda = true in terraform.tfvars
    2. Run terraform apply
    3. Update GitHub workflow
    
    EOT
}
