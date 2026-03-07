# =============================================================================
# KMS Key for encryption (HIPAA requirement)
# =============================================================================
resource "aws_kms_key" "main" {
  description             = "KMS key for AiVota ${var.environment} environment"
  deletion_window_in_days = 30
  enable_key_rotation     = true

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "Enable IAM User Permissions"
        Effect = "Allow"
        Principal = {
          AWS = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:root"
        }
        Action   = "kms:*"
        Resource = "*"
      },
      {
        Sid    = "Allow CloudWatch Logs"
        Effect = "Allow"
        Principal = {
          Service = "logs.${var.aws_region}.amazonaws.com"
        }
        Action = [
          "kms:Encrypt*",
          "kms:Decrypt*",
          "kms:ReEncrypt*",
          "kms:GenerateDataKey*",
          "kms:Describe*"
        ]
        Resource = "*"
        Condition = {
          ArnLike = {
            "kms:EncryptionContext:aws:logs:arn" = "arn:aws:logs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:*"
          }
        }
      },
      {
        Sid    = "Allow ECS Tasks"
        Effect = "Allow"
        Principal = {
          Service = "ecs-tasks.amazonaws.com"
        }
        Action = [
          "kms:Decrypt",
          "kms:GenerateDataKey"
        ]
        Resource = "*"
      },
      {
        Sid    = "Allow CloudTrail"
        Effect = "Allow"
        Principal = {
          Service = "cloudtrail.amazonaws.com"
        }
        Action = [
          "kms:Encrypt*",
          "kms:Decrypt*",
          "kms:ReEncrypt*",
          "kms:GenerateDataKey*",
          "kms:Describe*"
        ]
        Resource = "*"
        Condition = {
          StringLike = {
            "kms:EncryptionContext:aws:cloudtrail:arn" = "arn:aws:cloudtrail:*:${data.aws_caller_identity.current.account_id}:trail/*"
          }
        }
      }
    ]
  })

  tags = {
    Name = "${local.name_prefix}-kms"
  }
}

resource "aws_kms_alias" "main" {
  name          = "alias/${local.name_prefix}"
  target_key_id = aws_kms_key.main.key_id
}

# =============================================================================
# Secrets Manager - Database Credentials
# =============================================================================
resource "aws_secretsmanager_secret" "database" {
  name        = "${local.name_prefix}/database"
  description = "Database credentials for AiVota"
  kms_key_id  = aws_kms_key.main.arn

  recovery_window_in_days = var.environment == "prod" ? 30 : 7

  tags = {
    Name = "${local.name_prefix}-database-secret"
  }
}

# Note: The actual database credentials are set in rds.tf after the database is created

# =============================================================================
# Secrets Manager - Application Secrets
# =============================================================================
resource "aws_secretsmanager_secret" "app_secrets" {
  name        = "${local.name_prefix}/app-secrets"
  description = "Application secrets for AiVota"
  kms_key_id  = aws_kms_key.main.arn

  recovery_window_in_days = var.environment == "prod" ? 30 : 7

  tags = {
    Name = "${local.name_prefix}-app-secrets"
  }
}

# =============================================================================
# Secrets rotation (optional - for database passwords)
# =============================================================================
# Uncomment if you want automatic password rotation
# resource "aws_secretsmanager_secret_rotation" "database" {
#   secret_id           = aws_secretsmanager_secret.database.id
#   rotation_lambda_arn = aws_lambda_function.secret_rotation.arn

#   rotation_rules {
#     automatically_after_days = 30
#   }
# }
