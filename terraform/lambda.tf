# =============================================================================
# Lambda Function for Backend API
# Uses AWS Lambda Web Adapter to run Express
# =============================================================================

# =============================================================================
# ECR Repository for Lambda
# =============================================================================
resource "aws_ecr_repository" "lambda" {
  count = var.use_lambda ? 1 : 0

  name                 = "${local.name_prefix}-lambda"
  image_tag_mutability = "MUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "KMS"
    kms_key         = aws_kms_key.main.arn
  }

  tags = {
    Name = "${local.name_prefix}-lambda-ecr"
  }
}

resource "aws_ecr_lifecycle_policy" "lambda" {
  count = var.use_lambda ? 1 : 0

  repository = aws_ecr_repository.lambda[0].name

  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Keep last 5 images"
        selection = {
          tagStatus   = "any"
          countType   = "imageCountMoreThan"
          countNumber = 5
        }
        action = {
          type = "expire"
        }
      }
    ]
  })
}

# =============================================================================
# Lambda Execution Role
# =============================================================================
resource "aws_iam_role" "lambda_execution" {
  count = var.use_lambda ? 1 : 0

  name = "${local.name_prefix}-lambda-execution"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "lambda.amazonaws.com"
        }
      }
    ]
  })

  tags = {
    Name = "${local.name_prefix}-lambda-execution"
  }
}

# Basic Lambda execution policy (CloudWatch Logs)
resource "aws_iam_role_policy_attachment" "lambda_basic" {
  count = var.use_lambda ? 1 : 0

  role       = aws_iam_role.lambda_execution[0].name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

# VPC access for Lambda (to reach RDS)
resource "aws_iam_role_policy_attachment" "lambda_vpc" {
  count = var.use_lambda ? 1 : 0

  role       = aws_iam_role.lambda_execution[0].name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

# Secrets Manager access
resource "aws_iam_role_policy" "lambda_secrets" {
  count = var.use_lambda ? 1 : 0

  name = "${local.name_prefix}-lambda-secrets"
  role = aws_iam_role.lambda_execution[0].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "secretsmanager:GetSecretValue"
        ]
        Resource = [
          aws_secretsmanager_secret.database.arn,
          aws_secretsmanager_secret.app_secrets.arn
        ]
      },
      {
        Effect = "Allow"
        Action = [
          "kms:Decrypt"
        ]
        Resource = [
          aws_kms_key.main.arn
        ]
      }
    ]
  })
}

# S3 access for uploads bucket
resource "aws_iam_role_policy" "lambda_s3" {
  count = var.use_lambda ? 1 : 0

  name = "${local.name_prefix}-lambda-s3"
  role = aws_iam_role.lambda_execution[0].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "s3:GetObject",
          "s3:PutObject",
          "s3:DeleteObject",
          "s3:ListBucket"
        ]
        Resource = [
          aws_s3_bucket.uploads.arn,
          "${aws_s3_bucket.uploads.arn}/*"
        ]
      }
    ]
  })
}

# =============================================================================
# Lambda Function
# NOTE: Requires an image to exist in ECR before creation.
# First run: Set use_lambda = true, lambda_image_exists = false
#            This creates ECR but not Lambda
# After pushing image: Set lambda_image_exists = true
#            This creates the Lambda function
# =============================================================================
resource "aws_lambda_function" "api" {
  count = var.use_lambda && var.lambda_image_exists ? 1 : 0

  function_name = "${local.name_prefix}-api"
  role          = aws_iam_role.lambda_execution[0].arn
  package_type  = "Image"
  image_uri     = "${aws_ecr_repository.lambda[0].repository_url}:latest"
  
  timeout     = 30
  memory_size = 1024

  # VPC configuration to access RDS
  vpc_config {
    subnet_ids         = aws_subnet.private[*].id
    security_group_ids = [aws_security_group.lambda[0].id]
  }

  environment {
    variables = {
      NODE_ENV    = var.environment == "prod" ? "production" : var.environment
      PORT        = "8080"  # Lambda Web Adapter default
      ENVIRONMENT = var.environment  # For loading correct secrets
    }
  }

  tags = {
    Name = "${local.name_prefix}-api"
  }

  depends_on = [
    aws_iam_role_policy_attachment.lambda_basic,
    aws_iam_role_policy_attachment.lambda_vpc,
    aws_cloudwatch_log_group.lambda
  ]
}

# =============================================================================
# Lambda Function URL (simpler than API Gateway, no extra cost)
# =============================================================================
resource "aws_lambda_function_url" "api" {
  count = var.use_lambda && var.lambda_image_exists ? 1 : 0

  function_name      = aws_lambda_function.api[0].function_name
  authorization_type = "NONE"  # Public API

  cors {
    allow_credentials = true
    allow_headers     = ["*"]
    allow_methods     = ["*"]
    allow_origins     = var.domain_name != "" ? ["https://${var.domain_name}"] : ["*"]
    expose_headers    = ["*"]
    max_age           = 86400
  }
}

# =============================================================================
# Lambda Security Group
# =============================================================================
resource "aws_security_group" "lambda" {
  count = var.use_lambda ? 1 : 0

  name        = "${local.name_prefix}-lambda-sg"
  description = "Security group for Lambda function"
  vpc_id      = aws_vpc.main.id

  # Outbound to RDS
  egress {
    description     = "PostgreSQL to RDS"
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.rds.id]
  }

  # Outbound HTTPS (for Secrets Manager, external APIs)
  egress {
    description = "HTTPS outbound"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "${local.name_prefix}-lambda-sg"
  }
}

# Allow Lambda to connect to RDS
resource "aws_security_group_rule" "rds_from_lambda" {
  count = var.use_lambda ? 1 : 0

  type                     = "ingress"
  from_port                = 5432
  to_port                  = 5432
  protocol                 = "tcp"
  source_security_group_id = aws_security_group.lambda[0].id
  security_group_id        = aws_security_group.rds.id
  description              = "PostgreSQL from Lambda"
}

# =============================================================================
# CloudWatch Log Group for Lambda
# =============================================================================
resource "aws_cloudwatch_log_group" "lambda" {
  count = var.use_lambda ? 1 : 0

  name              = "/aws/lambda/${local.name_prefix}-api"
  retention_in_days = var.app_log_retention_days
  kms_key_id        = aws_kms_key.main.arn

  tags = {
    Name = "${local.name_prefix}-lambda-logs"
  }
}
