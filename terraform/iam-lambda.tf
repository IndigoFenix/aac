# =============================================================================
# IAM Policy for Lambda Deployment - Add to existing iam.tf
# =============================================================================

# Phase 1 permissions - ECR and S3 only (before Lambda exists)
resource "aws_iam_role_policy" "github_actions_lambda_phase1" {
  count = var.use_lambda ? 1 : 0
  name  = "${local.name_prefix}-github-actions-lambda-phase1"
  role  = aws_iam_role.github_actions.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      # S3 frontend deployment
      {
        Effect = "Allow"
        Action = [
          "s3:PutObject",
          "s3:GetObject",
          "s3:DeleteObject",
          "s3:ListBucket"
        ]
        Resource = [
          aws_s3_bucket.frontend[0].arn,
          "${aws_s3_bucket.frontend[0].arn}/*"
        ]
      },
      # ECR for Lambda images
      {
        Effect = "Allow"
        Action = [
          "ecr:GetDownloadUrlForLayer",
          "ecr:BatchGetImage",
          "ecr:BatchCheckLayerAvailability",
          "ecr:PutImage",
          "ecr:InitiateLayerUpload",
          "ecr:UploadLayerPart",
          "ecr:CompleteLayerUpload",
          "ecr:GetAuthorizationToken"
        ]
        Resource = [
          aws_ecr_repository.lambda[0].arn,
          "*"  # GetAuthorizationToken requires *
        ]
      }
    ]
  })
}

# Phase 2 permissions - Lambda and CloudFront (after Lambda exists)
resource "aws_iam_role_policy" "github_actions_lambda_phase2" {
  count = var.use_lambda && var.lambda_image_exists ? 1 : 0
  name  = "${local.name_prefix}-github-actions-lambda-phase2"
  role  = aws_iam_role.github_actions.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      # Lambda deployment
      {
        Effect = "Allow"
        Action = [
          "lambda:UpdateFunctionCode",
          "lambda:GetFunction",
          "lambda:GetFunctionConfiguration",
          "lambda:GetFunctionUrlConfig"
        ]
        Resource = aws_lambda_function.api[0].arn
      },
      # CloudFront cache invalidation
      {
        Effect = "Allow"
        Action = [
          "cloudfront:CreateInvalidation",
          "cloudfront:GetInvalidation"
        ]
        Resource = aws_cloudfront_distribution.frontend[0].arn
      }
    ]
  })
}
