# =============================================================================
# AAC Desktop Client — Auto-Update Channel
# =============================================================================
# Hosts the electron-updater feed (installer .exe + .blockmap + latest.yml)
# behind CloudFront, served from a private S3 bucket via Origin Access
# Control. The desktop client polls `https://<aac_update_subdomain>.
# <domain_name>/latest.yml` and downloads new versions from there.
#
# Gated behind `enable_aac_auto_update` so the resources don't appear in
# existing deploys until you opt in. Set the flag → apply → run
# `npm run release:aac` with AAC_UPDATE_BUCKET = the output bucket name.
#
# Notes:
# - The bucket is PUBLIC-READ via the CloudFront OAC ONLY. No PHI lives
#   here — only signed installer artifacts and the manifest.
# - The CloudFront cert is a SEPARATE ACM certificate from the main
#   app's cert. Bundling `updates.<domain>` into the existing cert would
#   force a CloudFront update on the main app every time we touched the
#   update channel; separate certs keep the two distributions
#   independent.
# - Two cache behaviors: long TTL for installer + blockmap (immutable
#   per version), zero TTL for latest.yml (polled by every client; must
#   not lag a publish).

# =============================================================================
# S3 bucket — the actual artifact storage
# =============================================================================
resource "aws_s3_bucket" "aac_updates" {
  count = var.enable_aac_auto_update ? 1 : 0

  bucket = "${local.name_prefix}-aac-updates-${data.aws_caller_identity.current.account_id}"

  tags = {
    Name      = "${local.name_prefix}-aac-updates"
    Purpose   = "AAC desktop client auto-update feed"
    DataClass = "public"
  }
}

# Versioning ON so an accidental re-publish of an existing version
# doesn't silently rewrite the artifact — we can restore the prior
# object if needed. Lifecycle rule below prunes old versions to keep
# storage cost bounded.
resource "aws_s3_bucket_versioning" "aac_updates" {
  count  = var.enable_aac_auto_update ? 1 : 0
  bucket = aws_s3_bucket.aac_updates[0].id

  versioning_configuration {
    status = "Enabled"
  }
}

# SSE with S3-managed keys (AES-256). Installer artifacts aren't PHI;
# the KMS key for the rest of the stack would just add cost + log noise.
resource "aws_s3_bucket_server_side_encryption_configuration" "aac_updates" {
  count  = var.enable_aac_auto_update ? 1 : 0
  bucket = aws_s3_bucket.aac_updates[0].id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# Block ALL direct public access. Reads happen via CloudFront's OAC
# (sigv4-signed S3 GET) — never directly from clients. This keeps the
# bucket from being indexed / scanned and gives CloudFront full control
# over caching headers.
resource "aws_s3_bucket_public_access_block" "aac_updates" {
  count                   = var.enable_aac_auto_update ? 1 : 0
  bucket                  = aws_s3_bucket.aac_updates[0].id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# Prune old versions. Active version is whatever the publisher script
# uploaded last; older versions become "noncurrent" the moment a new
# upload happens. 30 days is plenty of rollback window if a broken
# release ships and we need to revert latest.yml to the prior build.
resource "aws_s3_bucket_lifecycle_configuration" "aac_updates" {
  count  = var.enable_aac_auto_update ? 1 : 0
  bucket = aws_s3_bucket.aac_updates[0].id

  rule {
    id     = "prune-noncurrent-versions"
    status = "Enabled"
    filter {}

    noncurrent_version_expiration {
      noncurrent_days = 30
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }
}

# Bucket policy: ONLY this CloudFront distribution may read. Without
# this scoping, any CloudFront distribution in the account could front
# the bucket.
resource "aws_s3_bucket_policy" "aac_updates" {
  count = var.enable_aac_auto_update ? 1 : 0

  bucket = aws_s3_bucket.aac_updates[0].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "AllowCloudFrontOACRead"
        Effect    = "Allow"
        Principal = { Service = "cloudfront.amazonaws.com" }
        Action    = "s3:GetObject"
        Resource  = "${aws_s3_bucket.aac_updates[0].arn}/*"
        Condition = {
          StringEquals = {
            "AWS:SourceArn" = aws_cloudfront_distribution.aac_updates[0].arn
          }
        }
      }
    ]
  })

  # The policy references the distribution which references the bucket;
  # Terraform handles the create order but we make the dependency
  # explicit so policy attaches AFTER the distribution exists.
  depends_on = [aws_cloudfront_distribution.aac_updates]
}

# =============================================================================
# ACM certificate (us-east-1, separate from main app cert)
# =============================================================================
# Only created when a domain is configured. Without a domain the
# CloudFront distribution still works — clients hit the default
# CloudFront URL (output below), and you point electron-builder.yml's
# publish.url at that URL.

resource "aws_acm_certificate" "aac_updates" {
  count    = var.enable_aac_auto_update && var.domain_name != "" ? 1 : 0
  provider = aws.us_east_1

  domain_name       = "${local.aac_update_subdomain_effective}.${var.domain_name}"
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }

  tags = {
    Name = "${local.name_prefix}-aac-updates-cert"
  }
}

resource "aws_route53_record" "aac_updates_cert_validation" {
  for_each = var.enable_aac_auto_update && var.domain_name != "" ? {
    for dvo in aws_acm_certificate.aac_updates[0].domain_validation_options : dvo.domain_name => dvo
  } : {}

  allow_overwrite = true
  zone_id         = data.aws_route53_zone.main[0].zone_id
  name            = each.value.resource_record_name
  type            = each.value.resource_record_type
  records         = [each.value.resource_record_value]
  ttl             = 60
}

resource "aws_acm_certificate_validation" "aac_updates" {
  count    = var.enable_aac_auto_update && var.domain_name != "" ? 1 : 0
  provider = aws.us_east_1

  certificate_arn         = aws_acm_certificate.aac_updates[0].arn
  validation_record_fqdns = [for record in aws_route53_record.aac_updates_cert_validation : record.fqdn]
}

# =============================================================================
# CloudFront — the public face of the update channel
# =============================================================================

resource "aws_cloudfront_origin_access_control" "aac_updates" {
  count = var.enable_aac_auto_update ? 1 : 0

  name                              = "${local.name_prefix}-aac-updates-oac"
  description                       = "OAC for AAC auto-update bucket"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# CORS for the JSON manifests. `latest-backend.json` is fetched by the packaged
# apps from their app://aac and capacitor://localhost origins, which browsers
# treat as cross-origin — without Access-Control-Allow-Origin the fetch is
# blocked and the fleet can never be re-pointed. Read-only public data, so a
# wildcard origin with no credentials is the correct policy.
resource "aws_cloudfront_response_headers_policy" "aac_updates_cors" {
  count = var.enable_aac_auto_update ? 1 : 0

  name    = "${local.name_prefix}-aac-updates-cors"
  comment = "Allow any origin to read the AAC update/backend manifests"

  cors_config {
    access_control_allow_credentials = false
    origin_override                  = true
    access_control_max_age_sec       = 600

    access_control_allow_origins {
      items = ["*"]
    }
    access_control_allow_methods {
      items = ["GET", "HEAD"]
    }
    access_control_allow_headers {
      items = ["*"]
    }
  }
}

resource "aws_cloudfront_distribution" "aac_updates" {
  count = var.enable_aac_auto_update ? 1 : 0

  enabled         = true
  is_ipv6_enabled = true
  comment         = "Aivota AAC desktop auto-update channel"
  # PriceClass_100 = US/Canada/Europe edges only. The desktop client
  # population is small + tolerates extra latency; full PriceClass_All
  # is wasteful here. Override later if you ship to regions outside
  # the default edge set.
  price_class = "PriceClass_100"
  http_version = "http2and3"

  # SAN limited to the configured subdomain. Empty domain → no alias,
  # clients reach the distribution via its default *.cloudfront.net URL.
  aliases = var.domain_name != "" ? ["${local.aac_update_subdomain_effective}.${var.domain_name}"] : []

  origin {
    domain_name              = aws_s3_bucket.aac_updates[0].bucket_regional_domain_name
    origin_id                = "aac-updates-s3"
    origin_access_control_id = aws_cloudfront_origin_access_control.aac_updates[0].id
  }

  # Default behavior — installer + blockmap. Long cache TTL; these
  # files are immutable per version (each version has a unique
  # `Setup X.Y.Z.exe` filename), so a 1-hour edge cache is safe and
  # cheap. The publisher script also sets explicit Cache-Control
  # headers on upload (var.aac_update_installer_max_age_seconds).
  default_cache_behavior {
    target_origin_id       = "aac-updates-s3"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true
    # AWS-managed "CachingOptimized" policy: respects origin
    # Cache-Control / Last-Modified, default TTL 24h, max 365d.
    cache_policy_id = "658327ea-f89d-4fab-a63d-7e88639e58f6"
  }

  # `latest.yml` MUST bypass the edge cache — every installed client
  # polls it to check for new versions. A cached manifest delays
  # rollout by the cache TTL on every edge node. Separate behavior
  # using AWS-managed "CachingDisabled" policy.
  ordered_cache_behavior {
    path_pattern           = "*latest*.yml"
    target_origin_id       = "aac-updates-s3"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true
    # AWS-managed "CachingDisabled" policy.
    cache_policy_id = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad"
  }

  # Same rule for the JSON manifests: the iPad feed's `latest.json` (aac/ios/),
  # read server-side by the clinician Downloads panel, and `latest-backend.json`
  # (aac/, aac-staging/) — the RUNTIME BACKEND MANIFEST every packaged app
  # fetches on launch from its app:// / capacitor:// origin (so it needs CORS;
  # see the response headers policy below). A cached copy of either would keep
  # handing out the previous build / backend.
  ordered_cache_behavior {
    path_pattern               = "*latest*.json"
    target_origin_id           = "aac-updates-s3"
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["GET", "HEAD"]
    cached_methods             = ["GET", "HEAD"]
    compress                   = true
    # AWS-managed "CachingDisabled" policy.
    cache_policy_id            = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad"
    response_headers_policy_id = aws_cloudfront_response_headers_policy.aac_updates_cors[0].id
  }

  # On-device voice models (`models/**`) — the Kokoro neural TTS weights the
  # AAC downloads per DEVICE when a student has the local voice enabled.
  #
  # Two reasons this needs its own behavior rather than riding the default:
  #
  #  1. CORS. Weights are fetched by the packaged apps from their app://aac and
  #     capacitor://localhost origins, which browsers treat as cross-origin —
  #     without Access-Control-Allow-Origin the fetch is blocked and no device
  #     can ever get a voice. Same reasoning (and same policy) as the JSON
  #     manifests above.
  #  2. Immutability. Model paths carry the version (`models/kokoro/v1.0/...`),
  #     so a published file NEVER changes — a new model version is a new path.
  #     That makes these the most cacheable objects in the bucket, which matters
  #     when the payload is ~94 MB per device.
  #
  # Public, non-PHI, read-only — exactly the data class this bucket already
  # holds. No new toggle: gated by `enable_aac_auto_update` like everything else
  # here, so it works identically under the ecs-lean, hipaa and legacy profiles.
  ordered_cache_behavior {
    path_pattern               = "models/*"
    target_origin_id           = "aac-updates-s3"
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["GET", "HEAD"]
    cached_methods             = ["GET", "HEAD"]
    # Weights are already compressed; re-compressing at the edge burns CPU for
    # nothing and can defeat range requests on a resumed download.
    compress                   = false
    # AWS-managed "CachingOptimized" — respects the immutable Cache-Control the
    # publisher sets, up to a 365-day edge TTL.
    cache_policy_id            = "658327ea-f89d-4fab-a63d-7e88639e58f6"
    response_headers_policy_id = aws_cloudfront_response_headers_policy.aac_updates_cors[0].id
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  # When a domain + cert exist, use them. Otherwise serve via the
  # default *.cloudfront.net hostname with CloudFront's own cert.
  viewer_certificate {
    cloudfront_default_certificate = var.domain_name == ""
    acm_certificate_arn            = var.domain_name != "" ? aws_acm_certificate_validation.aac_updates[0].certificate_arn : null
    ssl_support_method             = var.domain_name != "" ? "sni-only" : null
    minimum_protocol_version       = var.domain_name != "" ? "TLSv1.2_2021" : null
  }

  tags = {
    Name = "${local.name_prefix}-aac-updates"
  }
}

# =============================================================================
# Route 53 record
# =============================================================================
# Only created when the domain is configured. The CloudFront default
# URL is always usable; the friendly URL is just sugar.

resource "aws_route53_record" "aac_updates" {
  count = var.enable_aac_auto_update && var.domain_name != "" ? 1 : 0

  zone_id = data.aws_route53_zone.main[0].zone_id
  name    = "${local.aac_update_subdomain_effective}.${var.domain_name}"
  type    = "A"

  alias {
    name                   = aws_cloudfront_distribution.aac_updates[0].domain_name
    zone_id                = aws_cloudfront_distribution.aac_updates[0].hosted_zone_id
    evaluate_target_health = false
  }
}
