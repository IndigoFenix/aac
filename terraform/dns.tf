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
# ACM Certificate DNS Validation (for ALB - only when NOT using Lambda)
# =============================================================================
resource "aws_route53_record" "cert_validation" {
  for_each = var.domain_name != "" && !var.use_lambda ? {
    for dvo in aws_acm_certificate.main[0].domain_validation_options : dvo.domain_name => {
      name   = dvo.resource_record_name
      record = dvo.resource_record_value
      type   = dvo.resource_record_type
    }
  } : {}

  allow_overwrite = true
  name            = each.value.name
  records         = [each.value.record]
  ttl             = 60
  type            = each.value.type
  zone_id         = data.aws_route53_zone.main[0].zone_id
}

# Wait for certificate validation (for ALB - only when NOT using Lambda)
resource "aws_acm_certificate_validation" "main" {
  count = var.domain_name != "" && !var.use_lambda ? 1 : 0

  certificate_arn         = aws_acm_certificate.main[0].arn
  validation_record_fqdns = [for record in aws_route53_record.cert_validation : record.fqdn]
}
