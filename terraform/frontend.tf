# =============================================================================
# S3 Bucket for Static Frontend (created in Phase 1)
# =============================================================================
resource "aws_s3_bucket" "frontend" {
  count  = var.use_lambda ? 1 : 0
  bucket = "${local.name_prefix}-frontend"

  tags = {
    Name = "${local.name_prefix}-frontend"
  }
}

resource "aws_s3_bucket_public_access_block" "frontend" {
  count  = var.use_lambda ? 1 : 0
  bucket = aws_s3_bucket.frontend[0].id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "frontend" {
  count  = var.use_lambda ? 1 : 0
  bucket = aws_s3_bucket.frontend[0].id

  versioning_configuration {
    status = "Enabled"
  }
}

# =============================================================================
# CloudFront Origin Access Control (created in Phase 1)
# =============================================================================
resource "aws_cloudfront_origin_access_control" "frontend" {
  count = var.use_lambda ? 1 : 0

  name                              = "${local.name_prefix}-frontend-oac"
  description                       = "OAC for frontend S3 bucket"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# =============================================================================
# ACM Certificate for CloudFront (must be in us-east-1) - created in Phase 1
# =============================================================================
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"
}

resource "aws_acm_certificate" "cloudfront" {
  count    = var.use_lambda && var.domain_name != "" ? 1 : 0
  provider = aws.us_east_1

  domain_name               = var.domain_name
  subject_alternative_names = ["www.${var.domain_name}"]
  validation_method         = "DNS"

  lifecycle {
    create_before_destroy = true
  }

  tags = {
    Name = "${local.name_prefix}-cloudfront-cert"
  }
}

resource "aws_route53_record" "cloudfront_cert_validation" {
  for_each = var.use_lambda && var.domain_name != "" ? {
    main = var.domain_name
    www  = "www.${var.domain_name}"
  } : {}

  allow_overwrite = true
  name            = one([for dvo in aws_acm_certificate.cloudfront[0].domain_validation_options : dvo.resource_record_name if dvo.domain_name == each.value])
  records         = [one([for dvo in aws_acm_certificate.cloudfront[0].domain_validation_options : dvo.resource_record_value if dvo.domain_name == each.value])]
  ttl             = 60
  type            = one([for dvo in aws_acm_certificate.cloudfront[0].domain_validation_options : dvo.resource_record_type if dvo.domain_name == each.value])
  zone_id         = data.aws_route53_zone.main[0].zone_id
}

resource "aws_acm_certificate_validation" "cloudfront" {
  count    = var.use_lambda && var.domain_name != "" ? 1 : 0
  provider = aws.us_east_1

  certificate_arn         = aws_acm_certificate.cloudfront[0].arn
  validation_record_fqdns = [for record in aws_route53_record.cloudfront_cert_validation : record.fqdn]
}

# =============================================================================
# CloudFront Distribution (created in Phase 2 - needs Lambda URL)
# =============================================================================

# Local to determine the API endpoint URL - uses one() to safely handle either resource
locals {
  # Get endpoints from whichever resource exists (one will be null)
  function_url_raw = one(aws_lambda_function_url.api[*].function_url)
  api_gateway_raw  = one(aws_apigatewayv2_api.lambda[*].api_endpoint)
  
  # Clean the URL to just the domain (remove https:// and trailing /)
  api_endpoint = var.use_lambda && var.lambda_image_exists ? replace(
    replace(
      coalesce(local.api_gateway_raw, local.function_url_raw, ""),
      "https://", ""
    ),
    "/", ""
  ) : ""
}

  # CloudFront Function for AAC SPA fallback
# Rewrites /aac/... requests (without file extensions) to /aac/index.html
resource "aws_cloudfront_function" "aac_spa_rewrite" {
  count   = var.use_lambda && var.lambda_image_exists ? 1 : 0
  name    = "${local.name_prefix}-aac-spa-rewrite"
  runtime = "cloudfront-js-2.0"
  comment = "Rewrite AAC SPA routes to /aac/index.html"

  code = <<-EOF
    function handler(event) {
      var request = event.request;
      var uri = request.uri;
      // If the URI has a file extension (e.g. .js, .css, .png), pass through to S3
      if (uri.match(/\.\w+$/)) {
        return request;
      }
      // Otherwise rewrite to /aac/index.html for SPA routing
      request.uri = '/aac/index.html';
      return request;
    }
  EOF
}

resource "aws_cloudfront_distribution" "frontend" {
  count = var.use_lambda && var.lambda_image_exists ? 1 : 0

  enabled             = true
  is_ipv6_enabled     = true
  default_root_object = "index.html"
  price_class         = "PriceClass_100"

  aliases = var.domain_name != "" ? [var.domain_name, "www.${var.domain_name}"] : []

  # S3 Origin for static files
  origin {
    domain_name              = aws_s3_bucket.frontend[0].bucket_regional_domain_name
    origin_id                = "S3-frontend"
    origin_access_control_id = aws_cloudfront_origin_access_control.frontend[0].id
  }

  # Lambda/API Gateway Origin for API
  origin {
    domain_name = local.api_endpoint
    origin_id   = "Lambda-api"

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  # Default behavior - serve static files from S3
  default_cache_behavior {
    allowed_methods  = ["GET", "HEAD", "OPTIONS"]
    cached_methods   = ["GET", "HEAD"]
    target_origin_id = "S3-frontend"

    forwarded_values {
      query_string = false
      cookies {
        forward = "none"
      }
    }

    viewer_protocol_policy = "redirect-to-https"
    min_ttl                = 0
    default_ttl            = 3600
    max_ttl                = 86400
    compress               = true
  }

  # AAC client - serve from S3 with SPA rewrite function
  ordered_cache_behavior {
    path_pattern     = "/aac/*"
    allowed_methods  = ["GET", "HEAD", "OPTIONS"]
    cached_methods   = ["GET", "HEAD"]
    target_origin_id = "S3-frontend"

    forwarded_values {
      query_string = false
      cookies {
        forward = "none"
      }
    }

    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.aac_spa_rewrite[0].arn
    }

    viewer_protocol_policy = "redirect-to-https"
    min_ttl                = 0
    default_ttl            = 3600
    max_ttl                = 86400
    compress               = true
  }

  # AAC client root path (without trailing slash)
  ordered_cache_behavior {
    path_pattern     = "/aac"
    allowed_methods  = ["GET", "HEAD", "OPTIONS"]
    cached_methods   = ["GET", "HEAD"]
    target_origin_id = "S3-frontend"

    forwarded_values {
      query_string = false
      cookies {
        forward = "none"
      }
    }

    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.aac_spa_rewrite[0].arn
    }

    viewer_protocol_policy = "redirect-to-https"
    min_ttl                = 0
    default_ttl            = 3600
    max_ttl                = 86400
    compress               = true
  }

  # Auth routes - forward to Lambda (no caching)
  ordered_cache_behavior {
    path_pattern     = "/auth/*"
    allowed_methods  = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]
    cached_methods   = ["GET", "HEAD"]
    target_origin_id = "Lambda-api"

    forwarded_values {
      query_string = true
      headers      = ["Authorization", "Origin", "Accept", "Content-Type"]
      cookies {
        forward = "all"
      }
    }

    viewer_protocol_policy = "redirect-to-https"
    min_ttl                = 0
    default_ttl            = 0
    max_ttl                = 0
  }

  # API behavior - forward to Lambda
  ordered_cache_behavior {
    path_pattern     = "/api/*"
    allowed_methods  = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]
    cached_methods   = ["GET", "HEAD"]
    target_origin_id = "Lambda-api"

    forwarded_values {
      query_string = true
      headers      = ["Authorization", "Origin", "Accept", "Content-Type"]
      cookies {
        forward = "all"
      }
    }

    viewer_protocol_policy = "redirect-to-https"
    min_ttl                = 0
    default_ttl            = 0
    max_ttl                = 0
  }

  # Health check endpoint
  ordered_cache_behavior {
    path_pattern     = "/health"
    allowed_methods  = ["GET", "HEAD", "OPTIONS"]
    cached_methods   = ["GET", "HEAD"]
    target_origin_id = "Lambda-api"

    forwarded_values {
      query_string = false
      cookies {
        forward = "none"
      }
    }

    viewer_protocol_policy = "redirect-to-https"
    min_ttl                = 0
    default_ttl            = 0
    max_ttl                = 0
  }

  # SPA fallback
  custom_error_response {
    error_code         = 404
    response_code      = 200
    response_page_path = "/index.html"
  }

  custom_error_response {
    error_code         = 403
    response_code      = 200
    response_page_path = "/index.html"
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    acm_certificate_arn            = var.domain_name != "" ? aws_acm_certificate_validation.cloudfront[0].certificate_arn : null
    cloudfront_default_certificate = var.domain_name == ""
    ssl_support_method             = var.domain_name != "" ? "sni-only" : null
    minimum_protocol_version       = "TLSv1.2_2021"
  }

  tags = {
    Name = "${local.name_prefix}-cdn"
  }
}

# =============================================================================
# S3 Bucket Policy for CloudFront (created in Phase 2)
# =============================================================================
resource "aws_s3_bucket_policy" "frontend" {
  count  = var.use_lambda && var.lambda_image_exists ? 1 : 0
  bucket = aws_s3_bucket.frontend[0].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "AllowCloudFrontServicePrincipal"
        Effect = "Allow"
        Principal = {
          Service = "cloudfront.amazonaws.com"
        }
        Action   = "s3:GetObject"
        Resource = "${aws_s3_bucket.frontend[0].arn}/*"
        Condition = {
          StringEquals = {
            "AWS:SourceArn" = aws_cloudfront_distribution.frontend[0].arn
          }
        }
      }
    ]
  })
}

# =============================================================================
# Route 53 Records for CloudFront (created in Phase 2)
# =============================================================================
resource "aws_route53_record" "cloudfront_app" {
  count = var.use_lambda && var.lambda_image_exists && var.domain_name != "" ? 1 : 0

  zone_id         = data.aws_route53_zone.main[0].zone_id
  name            = var.domain_name
  type            = "A"
  allow_overwrite = true  # Allows overwriting existing ALB record

  alias {
    name                   = aws_cloudfront_distribution.frontend[0].domain_name
    zone_id                = aws_cloudfront_distribution.frontend[0].hosted_zone_id
    evaluate_target_health = false
  }
}

resource "aws_route53_record" "cloudfront_www" {
  count = var.use_lambda && var.lambda_image_exists && var.domain_name != "" ? 1 : 0

  zone_id         = data.aws_route53_zone.main[0].zone_id
  name            = "www.${var.domain_name}"
  type            = "A"
  allow_overwrite = true  # Allows overwriting existing ALB record

  alias {
    name                   = aws_cloudfront_distribution.frontend[0].domain_name
    zone_id                = aws_cloudfront_distribution.frontend[0].hosted_zone_id
    evaluate_target_health = false
  }
}
