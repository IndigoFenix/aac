# =============================================================================
# Route 53 - DNS Configuration
# =============================================================================

# Look up existing hosted zone (created when domain was registered)
data "aws_route53_zone" "main" {
  count = var.domain_name != "" ? 1 : 0
  name  = var.domain_name
}

# Public hostnames → ALB directly. Only when the ECS path serves its own
# static files; with frontend_via_cloudfront these three point at CloudFront
# instead (frontend.tf) and CloudFront reaches the ALB through api.<domain>.
resource "aws_route53_record" "app" {
  count = var.domain_name != "" && !var.use_lambda && !local.ecs_cdn ? 1 : 0

  zone_id = data.aws_route53_zone.main[0].zone_id
  name    = var.domain_name
  type    = "A"
  allow_overwrite = true

  alias {
    name                   = aws_lb.main.dns_name
    zone_id                = aws_lb.main.zone_id
    evaluate_target_health = true
  }
}

# WWW subdomain pointing to ALB (ECS without CloudFront only)
resource "aws_route53_record" "www" {
  count = var.domain_name != "" && !var.use_lambda && !local.ecs_cdn ? 1 : 0

  zone_id = data.aws_route53_zone.main[0].zone_id
  name    = "www.${var.domain_name}"
  type    = "A"
  allow_overwrite = true

  alias {
    name                   = aws_lb.main.dns_name
    zone_id                = aws_lb.main.zone_id
    evaluate_target_health = true
  }
}

# App subdomain pointing to ALB (ECS without CloudFront only)
resource "aws_route53_record" "app_alb" {
  count = var.domain_name != "" && !var.use_lambda && !local.ecs_cdn ? 1 : 0

  zone_id = data.aws_route53_zone.main[0].zone_id
  name    = "app.${var.domain_name}"
  type    = "A"
  allow_overwrite = true

  alias {
    name                   = aws_lb.main.dns_name
    zone_id                = aws_lb.main.zone_id
    evaluate_target_health = true
  }
}

# api.<domain> → ALB. Always present on the ECS path: CloudFront's origin and
# the packaged AAC clients' direct API/WebSocket host.
resource "aws_route53_record" "api_alb" {
  count = local.api_host != "" && !var.use_lambda ? 1 : 0

  zone_id         = data.aws_route53_zone.main[0].zone_id
  name            = local.api_host
  type            = "A"
  allow_overwrite = true # survives a record left behind by an interrupted apply

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
# Email authentication (SPF / DKIM / DMARC) — see docs/EMAIL.md
# =============================================================================
# Two senders share this domain and each needs its own authentication:
#
#   • Google Workspace sends the humans' mail from the APEX (MX above). SPF at
#     the apex + DKIM at google._domainkey (below) cover it.
#   • Amazon SES sends the app's transactional mail — its identity, DKIM
#     CNAMEs and MAIL FROM subdomain records live in ses.tf.
#
# One DMARC record at the apex (below) governs both.

locals {
  # Route 53 caps one TXT character-string at 255 bytes, and a 2048-bit DKIM
  # key runs ~410. Embedding `""` splits the value into two character-strings,
  # which resolvers concatenate back into one on lookup.
  google_dkim_txt = length(var.google_workspace_dkim_value) > 255 ? join("\"\"", [
    substr(var.google_workspace_dkim_value, 0, 255),
    substr(var.google_workspace_dkim_value, 255, -1),
  ]) : var.google_workspace_dkim_value
}

# --- Apex: Google Workspace -------------------------------------------------

# NOTE: a Route 53 record set is per (name, type), so this resource owns EVERY
# apex TXT record. Domain-verification strings (Google site verification, etc.)
# must be added to this `records` list rather than as a second TXT resource —
# a second one would clobber this.
resource "aws_route53_record" "spf_apex" {
  count = var.domain_name != "" ? 1 : 0

  zone_id = data.aws_route53_zone.main[0].zone_id
  name    = var.domain_name
  type    = "TXT"
  ttl     = 3600

  # ~all (softfail) rather than -all: mail forwarded by a recipient's server
  # breaks SPF through no fault of ours, and DKIM still carries the signature.
  records = ["v=spf1 include:_spf.google.com ~all"]
}

resource "aws_route53_record" "google_dkim" {
  count = var.domain_name != "" && var.google_workspace_dkim_value != "" ? 1 : 0

  zone_id = data.aws_route53_zone.main[0].zone_id
  name    = "google._domainkey.${var.domain_name}"
  type    = "TXT"
  ttl     = 3600
  records = [local.google_dkim_txt]
}

# --- Apex: DMARC ------------------------------------------------------------
# Covers the apex and, through the org-level policy, subdomains without their
# own _dmarc record — so this one entry governs Workspace and Resend alike.
# Start at p=none (monitor only), read the aggregate reports, then tighten to
# quarantine and finally reject once both senders pass cleanly.
resource "aws_route53_record" "dmarc" {
  count = var.domain_name != "" ? 1 : 0

  zone_id = data.aws_route53_zone.main[0].zone_id
  name    = "_dmarc.${var.domain_name}"
  type    = "TXT"
  ttl     = 3600

  # Relaxed alignment (adkim/aspf=r) is what lets a subdomain sender pass DMARC
  # for the organizational domain — strict would fail send.<domain> mail.
  records = [join("; ", compact([
    "v=DMARC1",
    "p=${var.dmarc_policy}",
    length(var.dmarc_rua) > 0 ? "rua=${join(",", [for addr in var.dmarc_rua : "mailto:${addr}"])}" : "",
    "adkim=r",
    "aspf=r",
  ]))]
}

# =============================================================================
# ACM Certificate DNS Validation (for ALB - only when NOT using Lambda)
# =============================================================================
resource "aws_route53_record" "cert_validation" {
  for_each = var.domain_name != "" && !var.use_lambda ? merge(
    { main = var.domain_name },
    { for k, v in local.alb_cert_sans : k => v if v != "" }
  ) : {}

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
