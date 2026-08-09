# =============================================================================
# Amazon SES — transactional email (see docs/EMAIL.md)
# =============================================================================
# The app sends invites / password resets / alerts through SES; Google
# Workspace keeps the humans' mailboxes (MX at the apex, dns.tf). No API key:
# the Lambda/ECS role gets ses:SendEmail, and the SDK signs with role creds.
# Everything lives in the default region alongside the rest of the stack
# (SES has been available in il-central-1 since Aug 2023).
#
# Verification is automatic: once the DKIM CNAMEs below resolve, SES flips the
# identity to verified on its own. The console's "set up SES" wizard is just
# what it shows while no identity exists yet — never click through it; this
# file is the setup.
#
# ONE manual step remains: a new SES account starts in SANDBOX mode (sends
# only to verified addresses; everything else is rejected with
# MessageRejected). Request production access once, in the AWS console →
# SES → Account dashboard → Request production access.

# Domain identity for the apex. SES verifies via DKIM alone — no MX needed on
# the domain — so the From address can be noreply@aivota.ai while Google keeps
# the apex MX. Bounces route through the MAIL FROM subdomain below.
resource "aws_sesv2_email_identity" "main" {
  count = var.domain_name != "" ? 1 : 0

  email_identity = var.domain_name
}

# Custom MAIL FROM (Return-Path) domain — send.<domain>. This is what SPF is
# actually checked against, and it keeps bounce traffic off the apex.
# USE_DEFAULT_VALUE: if the MX record ever breaks, fall back to amazonses.com
# rather than rejecting mail — DKIM still signs d=<domain>, so DMARC stays
# aligned and delivery continues.
resource "aws_sesv2_email_identity_mail_from_attributes" "main" {
  count = var.domain_name != "" ? 1 : 0

  email_identity         = aws_sesv2_email_identity.main[0].email_identity
  mail_from_domain       = "${var.mail_sending_subdomain}.${var.domain_name}"
  behavior_on_mx_failure = "USE_DEFAULT_VALUE"
}

# --- DNS ----------------------------------------------------------------------

# Easy DKIM: SES hands back exactly 3 tokens, each published as a CNAME.
# count is the static 3 (not length of the computed list) so the plan works
# before the identity exists.
resource "aws_route53_record" "ses_dkim" {
  count = var.domain_name != "" ? 3 : 0

  zone_id = data.aws_route53_zone.main[0].zone_id
  name    = "${aws_sesv2_email_identity.main[0].dkim_signing_attributes[0].tokens[count.index]}._domainkey.${var.domain_name}"
  type    = "CNAME"
  ttl     = 3600
  records = ["${aws_sesv2_email_identity.main[0].dkim_signing_attributes[0].tokens[count.index]}.dkim.amazonses.com"]
}

resource "aws_route53_record" "ses_mail_from_mx" {
  count = var.domain_name != "" ? 1 : 0

  zone_id = data.aws_route53_zone.main[0].zone_id
  name    = "${var.mail_sending_subdomain}.${var.domain_name}"
  type    = "MX"
  ttl     = 3600
  records = ["10 feedback-smtp.${var.aws_region}.amazonses.com"]
}

resource "aws_route53_record" "ses_mail_from_spf" {
  count = var.domain_name != "" ? 1 : 0

  zone_id = data.aws_route53_zone.main[0].zone_id
  name    = "${var.mail_sending_subdomain}.${var.domain_name}"
  type    = "TXT"
  ttl     = 3600
  records = ["v=spf1 include:amazonses.com ~all"]
}

# --- IAM: let the app send ----------------------------------------------------

resource "aws_iam_role_policy" "lambda_ses" {
  count = var.use_lambda && var.domain_name != "" ? 1 : 0

  name = "${local.name_prefix}-lambda-ses"
  role = aws_iam_role.lambda_execution[0].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["ses:SendEmail"]
        Resource = [aws_sesv2_email_identity.main[0].arn]
      }
    ]
  })
}

resource "aws_iam_role_policy" "ecs_task_ses" {
  count = var.domain_name != "" ? 1 : 0

  name = "${local.name_prefix}-ecs-task-ses"
  role = aws_iam_role.ecs_task.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["ses:SendEmail"]
        Resource = [aws_sesv2_email_identity.main[0].arn]
      }
    ]
  })
}
