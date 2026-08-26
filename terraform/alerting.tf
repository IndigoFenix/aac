# =============================================================================
# Alert delivery, WAF logging, GuardDuty routing, failed-login metric
# =============================================================================
# monitoring.tf declares the alarms and the SNS topic; this file is what makes
# them reach a human. Until 2026-08-26 the topic had no subscriber and the CMK
# policy (secrets.tf) did not let CloudWatch publish to it, so every alarm
# fired into the void. Everything here is gated on the SAME flags the rest of
# the stack uses (enable_waf / enable_guardduty / use_lambda) so it works under
# ecs-lean, hipaa and the legacy lambda profile alike.

# -----------------------------------------------------------------------------
# SNS topic policy — alarms publish under the account's default grant; the
# EventBridge rule below needs an explicit service grant.
# -----------------------------------------------------------------------------
resource "aws_sns_topic_policy" "alerts" {
  arn = aws_sns_topic.alerts.arn

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "AccountOwnerFullAccess"
        Effect = "Allow"
        Principal = {
          AWS = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:root"
        }
        Action = [
          "SNS:Publish",
          "SNS:Subscribe",
          "SNS:GetTopicAttributes",
          "SNS:SetTopicAttributes",
          "SNS:ListSubscriptionsByTopic",
          "SNS:DeleteTopic",
          "SNS:RemovePermission",
          "SNS:AddPermission",
          "SNS:Receive"
        ]
        Resource = aws_sns_topic.alerts.arn
      },
      {
        Sid    = "AllowCloudWatchAlarms"
        Effect = "Allow"
        Principal = {
          Service = "cloudwatch.amazonaws.com"
        }
        Action   = "SNS:Publish"
        Resource = aws_sns_topic.alerts.arn
        Condition = {
          StringEquals = {
            "aws:SourceAccount" = data.aws_caller_identity.current.account_id
          }
        }
      },
      {
        Sid    = "AllowEventBridge"
        Effect = "Allow"
        Principal = {
          Service = "events.amazonaws.com"
        }
        Action   = "SNS:Publish"
        Resource = aws_sns_topic.alerts.arn
        Condition = {
          StringEquals = {
            "aws:SourceAccount" = data.aws_caller_identity.current.account_id
          }
        }
      }
    ]
  })
}

# Email subscriber. SNS sends a confirmation email; the alert stream is silent
# until someone clicks it. `alert_email` empty = deliberately unsubscribed.
resource "aws_sns_topic_subscription" "alerts_email" {
  count = var.alert_email != "" ? 1 : 0

  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = var.alert_email
}

# -----------------------------------------------------------------------------
# GuardDuty findings → alerts topic (§164.308(a)(6) security-incident procedures)
# -----------------------------------------------------------------------------
# GuardDuty is an account-level detector (data source in monitoring.tf); this
# routes its findings of severity ≥ 4 (Medium and up) to the same topic as
# the alarms so there is one place an incident shows up.
resource "aws_cloudwatch_event_rule" "guardduty_findings" {
  count = var.enable_guardduty ? 1 : 0

  name        = "${local.name_prefix}-guardduty-findings"
  description = "GuardDuty findings (severity >= 4) to the alerts topic"

  event_pattern = jsonencode({
    source        = ["aws.guardduty"]
    "detail-type" = ["GuardDuty Finding"]
    detail = {
      severity = [{ numeric = [">=", 4] }]
    }
  })

  tags = { Name = "${local.name_prefix}-guardduty-findings" }
}

resource "aws_cloudwatch_event_target" "guardduty_findings_sns" {
  count = var.enable_guardduty ? 1 : 0

  rule      = aws_cloudwatch_event_rule.guardduty_findings[0].name
  target_id = "alerts-sns"
  arn       = aws_sns_topic.alerts.arn

  input_transformer {
    input_paths = {
      severity    = "$.detail.severity"
      type        = "$.detail.type"
      title       = "$.detail.title"
      region      = "$.region"
      accountId   = "$.detail.accountId"
      findingId   = "$.detail.id"
    }
    input_template = "\"GuardDuty <type> (severity <severity>) in <region>/<accountId>: <title> — finding <findingId>\""
  }
}

# -----------------------------------------------------------------------------
# WAF logging (§164.312(b)) — blocked/allowed requests with the credential
# headers redacted before they are written.
# -----------------------------------------------------------------------------
# WAF requires the destination log group name to start with `aws-waf-logs-`.
resource "aws_cloudwatch_log_group" "waf" {
  count = var.enable_waf && !var.use_lambda ? 1 : 0

  name              = "aws-waf-logs-${local.name_prefix}"
  retention_in_days = var.audit_log_retention_days
  kms_key_id        = aws_kms_key.main.arn

  tags = { Name = "${local.name_prefix}-waf-logs" }
}

resource "aws_wafv2_web_acl_logging_configuration" "main" {
  count = var.enable_waf && !var.use_lambda ? 1 : 0

  resource_arn            = aws_wafv2_web_acl.main[0].arn
  log_destination_configs = [aws_cloudwatch_log_group.waf[0].arn]

  redacted_fields {
    single_header {
      name = "authorization"
    }
  }

  redacted_fields {
    single_header {
      name = "cookie"
    }
  }

  # Log only what the rules acted on: blocks and counts. Every allowed request
  # would be an ALB-access-log duplicate at WAF prices.
  logging_filter {
    default_behavior = "DROP"

    filter {
      behavior    = "KEEP"
      requirement = "MEETS_ANY"

      condition {
        action_condition {
          action = "BLOCK"
        }
      }

      condition {
        action_condition {
          action = "COUNT"
        }
      }
    }
  }
}

# -----------------------------------------------------------------------------
# Failed-login metric — the emitter behind monitoring.tf's `failed_logins` alarm
# -----------------------------------------------------------------------------
# The alarm watched `AiVota/FailedLoginAttempts`, a metric nothing produced.
# The app now writes one stdout line per rejected password/MFA attempt
# (`[auth] login_failed` — no identifier, the activity log has those) and this
# filter turns each line into a data point. The app log group exists in every
# profile; under the legacy Lambda path the function's own group is separate,
# so this stays ECS-only like the alarm's neighbours.
resource "aws_cloudwatch_log_metric_filter" "failed_logins" {
  count = !var.use_lambda ? 1 : 0

  name           = "${local.name_prefix}-failed-logins"
  log_group_name = aws_cloudwatch_log_group.app.name
  pattern        = "\"[auth] login_failed\""

  metric_transformation {
    name          = "FailedLoginAttempts"
    namespace     = "AiVota"
    value         = "1"
    default_value = "0"
    unit          = "Count"
  }
}
