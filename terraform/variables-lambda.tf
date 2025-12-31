# =============================================================================
# Lambda Variables - Add to existing variables.tf
# =============================================================================

# Deployment process:
# 1. First deployment: use_lambda = true, lambda_image_exists = false
#    - Creates ECR repository, S3 bucket, CloudFront, IAM roles
#    - Does NOT create Lambda function (no image yet)
#
# 2. Push Lambda image (via GitHub Actions or manually)
#
# 3. Second deployment: use_lambda = true, lambda_image_exists = true
#    - Creates Lambda function using the pushed image
#
# When use_lambda = true:
# - Frontend is served from S3 + CloudFront
# - Backend runs on Lambda with Function URL
# - Route53 points to CloudFront
#
# When use_lambda = false (default):
# - Everything runs on ECS as before
# - ALB handles all traffic
