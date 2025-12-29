# =============================================================================
# Outputs
# =============================================================================

output "vpc_id" {
  description = "ID of the VPC"
  value       = aws_vpc.main.id
}

output "private_subnet_ids" {
  description = "IDs of private subnets"
  value       = aws_subnet.private[*].id
}

output "public_subnet_ids" {
  description = "IDs of public subnets"
  value       = aws_subnet.public[*].id
}

output "ecr_repository_url" {
  description = "URL of the ECR repository"
  value       = aws_ecr_repository.main.repository_url
}

output "ecs_cluster_name" {
  description = "Name of the ECS cluster"
  value       = aws_ecs_cluster.main.name
}

output "ecs_service_name" {
  description = "Name of the ECS service"
  value       = aws_ecs_service.main.name
}

output "alb_dns_name" {
  description = "DNS name of the Application Load Balancer"
  value       = aws_lb.main.dns_name
}

output "alb_zone_id" {
  description = "Zone ID of the Application Load Balancer"
  value       = aws_lb.main.zone_id
}

output "database_secret_arn" {
  description = "ARN of the database secrets in Secrets Manager"
  value       = aws_secretsmanager_secret.database.arn
}

output "app_secrets_arn" {
  description = "ARN of the application secrets in Secrets Manager"
  value       = aws_secretsmanager_secret.app_secrets.arn
}

output "uploads_bucket_name" {
  description = "Name of the S3 bucket for uploads"
  value       = aws_s3_bucket.uploads.bucket
}

output "logs_bucket_name" {
  description = "Name of the S3 bucket for logs"
  value       = aws_s3_bucket.logs.bucket
}

output "kms_key_arn" {
  description = "ARN of the KMS key"
  value       = aws_kms_key.main.arn
}

output "github_actions_role_arn" {
  description = "ARN of the GitHub Actions IAM role"
  value       = aws_iam_role.github_actions.arn
}

output "cloudwatch_log_group" {
  description = "Name of the CloudWatch log group for the application"
  value       = aws_cloudwatch_log_group.app.name
}

output "waf_web_acl_arn" {
  description = "ARN of the WAF Web ACL"
  value       = var.enable_waf ? aws_wafv2_web_acl.main[0].arn : null
}

output "acm_certificate_arn" {
  description = "ARN of the ACM certificate"
  value       = var.domain_name != "" ? aws_acm_certificate.main[0].arn : null
}

output "sns_alerts_topic_arn" {
  description = "ARN of the SNS topic for alerts"
  value       = aws_sns_topic.alerts.arn
}

# =============================================================================
# RDS Outputs
# =============================================================================
output "rds_endpoint" {
  description = "RDS instance endpoint"
  value       = aws_db_instance.main.endpoint
}

output "rds_address" {
  description = "RDS instance address (hostname only)"
  value       = aws_db_instance.main.address
}

output "rds_port" {
  description = "RDS instance port"
  value       = aws_db_instance.main.port
}

output "rds_database_name" {
  description = "Name of the database"
  value       = aws_db_instance.main.db_name
}

# =============================================================================
# Values needed for GitHub Actions secrets
# =============================================================================
output "github_secrets_summary" {
  description = "Summary of values needed for GitHub Actions secrets"
  value = <<-EOT
    
    ========================================
    GitHub Actions Secrets to Configure:
    ========================================
    
    AWS_ROLE_ARN: ${aws_iam_role.github_actions.arn}
    TF_STATE_BUCKET: ${aws_s3_bucket.terraform_state.bucket}
    
    ========================================
    Application URL:
    ========================================
    
    ${var.domain_name != "" ? "HTTPS: https://${var.domain_name}" : "HTTP: http://${aws_lb.main.dns_name}"}
    ALB DNS: ${aws_lb.main.dns_name}
    
    ========================================
    Database:
    ========================================
    
    Endpoint: ${aws_db_instance.main.endpoint}
    Database: ${aws_db_instance.main.db_name}
    Credentials: Stored in Secrets Manager (${aws_secretsmanager_secret.database.name})
    
    ${var.domain_name != "" ? "========================================\nACM Certificate Validation:\n========================================\n\nCertificate ARN: ${aws_acm_certificate.main[0].arn}\n(Validate via DNS in AWS Console)\n" : "========================================\nNote: Running in HTTP-only mode.\nAdd a domain_name variable to enable HTTPS.\n========================================"}
    
  EOT
}
