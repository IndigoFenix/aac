# =============================================================================
# Route 53 - DNS Configuration
# =============================================================================

# Look up existing hosted zone (created when domain was registered)
data "aws_route53_zone" "main" {
  count = var.domain_name != "" ? 1 : 0
  name  = var.domain_name
}

# A record pointing to ALB (only when NOT using Lambda)
# When using Lambda, CloudFront records are created in frontend.tf
resource "aws_route53_record" "app" {
  count = var.domain_name != "" && !var.use_lambda ? 1 : 0

  zone_id = data.aws_route53_zone.main[0].zone_id
  name    = var.domain_name
  type    = "A"

  alias {
    name                   = aws_lb.main.dns_name
    zone_id                = aws_lb.main.zone_id
    evaluate_target_health = true
  }
}

# WWW subdomain pointing to ALB (only when NOT using Lambda)
resource "aws_route53_record" "www" {
  count = var.domain_name != "" && !var.use_lambda ? 1 : 0

  zone_id = data.aws_route53_zone.main[0].zone_id
  name    = "www.${var.domain_name}"
  type    = "A"

  alias {
    name                   = aws_lb.main.dns_name
    zone_id                = aws_lb.main.zone_id
    evaluate_target_health = true
  }
}

# =============================================================================
# MX Record for Google email
# =============================================================================
resource "aws_route53_record" "mx" {
  count = var.domain_name != "" ? 1 : 0

  zone_id = data.aws_route53_zone.main[0].zone_id
  name    = var.domain_name
  type    = "MX"
  ttl     = 3600
  records = ["1 SMTP.GOOGLE.COM"]
}

# =============================================================================
# ACM Certificate DNS Validation (for ALB - only when NOT using Lambda)
# =============================================================================
resource "aws_route53_record" "cert_validation" {
  for_each = var.domain_name != "" && !var.use_lambda ? {
    main = var.domain_name
    www  = "www.${var.domain_name}"
  } : {}

  allow_overwrite = true
  name            = one([for dvo in aws_acm_certificate.main[0].domain_validation_options : dvo.resource_record_name if dvo.domain_name == each.value])
  records         = [one([for dvo in aws_acm_certificate.main[0].domain_validation_options : dvo.resource_record_value if dvo.domain_name == each.value])]
  ttl             = 60
  type            = one([for dvo in aws_acm_certificate.main[0].domain_validation_options : dvo.resource_record_type if dvo.domain_name == each.value])
  zone_id         = data.aws_route53_zone.main[0].zone_id
}

# Wait for certificate validation (for ALB - only when NOT using Lambda)
resource "aws_acm_certificate_validation" "main" {
  count = var.domain_name != "" && !var.use_lambda ? 1 : 0

  certificate_arn         = aws_acm_certificate.main[0].arn
  validation_record_fqdns = [for record in aws_route53_record.cert_validation : record.fqdn]
}
