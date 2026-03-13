# =============================================================================
# Lambda Function for Backend API
# Uses AWS Lambda Web Adapter to run Express
# =============================================================================

# =============================================================================
# ECR Repository for Lambda
# =============================================================================
resource "aws_ecr_repository" "lambda" {
  count = var.use_lambda ? 1 : 0

  name                 = "aivota-lambda"
  image_tag_mutability = "MUTABLE"
  force_delete         = true  # Allow deletion even with images

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
# Lambda Execution Role (created in Phase 1)
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

resource "aws_iam_role_policy_attachment" "lambda_basic" {
  count = var.use_lambda ? 1 : 0

  role       = aws_iam_role.lambda_execution[0].name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy_attachment" "lambda_vpc" {
  count = var.use_lambda ? 1 : 0

  role       = aws_iam_role.lambda_execution[0].name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

resource "aws_iam_role_policy" "lambda_secrets" {
  count = var.use_lambda ? 1 : 0

  name = "${local.name_prefix}-lambda-secrets"
  role = aws_iam_role.lambda_execution[0].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = ["secretsmanager:GetSecretValue"]
        Resource = [
          aws_secretsmanager_secret.database.arn,
          aws_secretsmanager_secret.app_secrets.arn
        ]
      },
      {
        Effect   = "Allow"
        Action   = ["kms:Decrypt"]
        Resource = [aws_kms_key.main.arn]
      }
    ]
  })
}

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
# Lambda Security Group (created in Phase 1)
# =============================================================================
resource "aws_security_group" "lambda" {
  count = var.use_lambda ? 1 : 0

  name        = "${local.name_prefix}-lambda-sg"
  description = "Security group for Lambda function"
  vpc_id      = aws_vpc.main.id

  # Allow all outbound (simpler, no cycle)
  egress {
    description = "All outbound"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "${local.name_prefix}-lambda-sg"
  }
}

# =============================================================================
# CloudWatch Log Group for Lambda (created in Phase 1)
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

# =============================================================================
# Lambda Function (created in Phase 2 - after image exists)
# =============================================================================
resource "aws_lambda_function" "api" {
  count = var.use_lambda && var.lambda_image_exists ? 1 : 0

  function_name = "${local.name_prefix}-api"
  role          = aws_iam_role.lambda_execution[0].arn
  package_type  = "Image"
  image_uri     = "${aws_ecr_repository.lambda[0].repository_url}:latest"
  
  timeout     = 30
  memory_size = 1024

  vpc_config {
    subnet_ids         = aws_subnet.private[*].id
    security_group_ids = [aws_security_group.lambda[0].id]
  }

  environment {
    variables = {
      NODE_ENV                = var.environment == "prod" ? "production" : var.environment
      PORT                    = "8080"
      ENVIRONMENT             = var.environment
      # Secret ARNs - the app fetches these at runtime
      DATABASE_SECRET_ARN     = aws_secretsmanager_secret.database.arn
      APP_SECRETS_ARN         = aws_secretsmanager_secret.app_secrets.arn
      # AWS region for SDK
      AWS_SECRETS_REGION      = var.aws_region
      # S3 bucket for uploads
      S3_UPLOADS_BUCKET       = aws_s3_bucket.uploads.bucket
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
# Lambda Function URL (created in Phase 2)
# Note: If Function URL doesn't work in your region, set use_api_gateway = true
# =============================================================================

# Wait for Lambda to be fully ready
resource "time_sleep" "wait_for_lambda" {
  count = var.use_lambda && var.lambda_image_exists ? 1 : 0

  depends_on      = [aws_lambda_function.api[0]]
  create_duration = "30s"
}

# Option 1: Lambda Function URL (simpler, no extra cost)
# Note: Not available in all regions (e.g. il-central-1). Use API Gateway instead.
resource "aws_lambda_function_url" "api" {
  count = var.use_lambda && var.lambda_image_exists && !var.use_api_gateway ? 1 : 0

  function_name      = aws_lambda_function.api[0].function_name
  authorization_type = "NONE"

  cors {
    allow_credentials = true
    allow_headers     = ["*"]
    allow_methods     = ["*"]
    allow_origins     = var.domain_name != "" ? ["https://${var.domain_name}"] : ["*"]
    expose_headers    = ["*"]
    max_age           = 86400
  }

  depends_on = [time_sleep.wait_for_lambda[0]]
}

# Option 2: API Gateway HTTP API (more reliable across regions)
resource "aws_apigatewayv2_api" "lambda" {
  count = var.use_lambda && var.lambda_image_exists && var.use_api_gateway ? 1 : 0

  name          = "${local.name_prefix}-api"
  protocol_type = "HTTP"

  cors_configuration {
    allow_credentials = true
    allow_headers     = ["*"]
    allow_methods     = ["*"]
    allow_origins     = var.domain_name != "" ? ["https://${var.domain_name}"] : ["*"]
    expose_headers    = ["*"]
    max_age           = 86400
  }

  tags = {
    Name = "${local.name_prefix}-api-gateway"
  }
}

resource "aws_apigatewayv2_stage" "lambda" {
  count = var.use_lambda && var.lambda_image_exists && var.use_api_gateway ? 1 : 0

  api_id      = aws_apigatewayv2_api.lambda[0].id
  name        = "$default"
  auto_deploy = true

  access_log_settings {
    destination_arn = aws_cloudwatch_log_group.lambda[0].arn
    format = jsonencode({
      requestId      = "$context.requestId"
      ip             = "$context.identity.sourceIp"
      requestTime    = "$context.requestTime"
      httpMethod     = "$context.httpMethod"
      routeKey       = "$context.routeKey"
      status         = "$context.status"
      responseLength = "$context.responseLength"
    })
  }
}

resource "aws_apigatewayv2_integration" "lambda" {
  count = var.use_lambda && var.lambda_image_exists && var.use_api_gateway ? 1 : 0

  api_id                 = aws_apigatewayv2_api.lambda[0].id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.api[0].invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "lambda" {
  count = var.use_lambda && var.lambda_image_exists && var.use_api_gateway ? 1 : 0

  api_id    = aws_apigatewayv2_api.lambda[0].id
  route_key = "$default"
  target    = "integrations/${aws_apigatewayv2_integration.lambda[0].id}"
}

resource "aws_lambda_permission" "api_gateway" {
  count = var.use_lambda && var.lambda_image_exists && var.use_api_gateway ? 1 : 0

  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.api[0].function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.lambda[0].execution_arn}/*/*"
}
