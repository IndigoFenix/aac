# =============================================================================
# Scheduled maintenance crons (EventBridge Scheduler → HTTPS endpoint)
# =============================================================================
#
# The API runs on Lambda via the Web Adapter, where setInterval-based scheduling
# does NOT fire (containers freeze between invocations). So the daily right-to-
# erasure hard-delete sweep + activity-log retention prune are driven by an
# EventBridge schedule that POSTs to the app's `/internal/run-crons` endpoint
# with a shared-secret header (`X-Cron-Secret`). The endpoint constant-time
# compares the header against `CRON_TRIGGER_SECRET` (set in app_secrets).
#
# DISABLED BY DEFAULT (`enable_cron_scheduler = false`) so it doesn't disturb
# existing applies. To enable:
#   1. Add CRON_TRIGGER_SECRET to the app_secrets secret (a long random string).
#   2. Set, in your tfvars:
#        enable_cron_scheduler = true
#        cron_target_url       = "https://app.<your-domain>/internal/run-crons"
#        cron_trigger_secret   = "<same value as CRON_TRIGGER_SECRET>"
#   3. terraform apply.
#
# This is the Lambda-path remediation for the deferred item in
# docs/SECURITY_ARCHITECTURE.md §12.1. The ECS path does not need it: both
# server entrypoints (index.ts and app.prod.ts) call
# server/services/maintenanceCrons.ts at boot, which runs the sweeps on a
# setInterval under a Postgres advisory lock (cron-lock.ts) so several tasks
# never run the same sweep twice. `local.cron_enabled` below is deliberately
# `&&`-gated on use_lambda for that reason.

variable "enable_cron_scheduler" {
  description = "Enable the EventBridge schedule that drives /internal/run-crons (Lambda path only)."
  type        = bool
  default     = false
}

variable "cron_target_url" {
  description = "Full HTTPS URL of the /internal/run-crons endpoint."
  type        = string
  default     = ""
}

variable "cron_trigger_secret" {
  description = "Shared secret sent in the X-Cron-Secret header; must equal the app's CRON_TRIGGER_SECRET."
  type        = string
  default     = ""
  sensitive   = true
}

variable "cron_schedule_expression" {
  description = "EventBridge schedule expression for the daily maintenance run."
  type        = string
  default     = "rate(1 day)"
}

locals {
  cron_enabled = var.use_lambda && var.enable_cron_scheduler
}

# Connection holding the shared-secret header injected into each invocation.
resource "aws_cloudwatch_event_connection" "cron" {
  count              = local.cron_enabled ? 1 : 0
  name               = "${local.name_prefix}-cron"
  authorization_type = "API_KEY"

  auth_parameters {
    api_key {
      key   = "X-Cron-Secret"
      value = var.cron_trigger_secret
    }
  }
}

# API destination = the app's cron endpoint.
resource "aws_cloudwatch_event_api_destination" "cron" {
  count                            = local.cron_enabled ? 1 : 0
  name                             = "${local.name_prefix}-cron"
  invocation_endpoint              = var.cron_target_url
  http_method                      = "POST"
  invocation_rate_limit_per_second = 1
  connection_arn                   = aws_cloudwatch_event_connection.cron[0].arn
}

# IAM role allowing EventBridge Scheduler to invoke the API destination.
resource "aws_iam_role" "cron_scheduler" {
  count = local.cron_enabled ? 1 : 0
  name  = "${local.name_prefix}-cron-scheduler"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "scheduler.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "cron_scheduler" {
  count = local.cron_enabled ? 1 : 0
  name  = "${local.name_prefix}-cron-scheduler"
  role  = aws_iam_role.cron_scheduler[0].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["events:InvokeApiDestination"]
      Resource = [aws_cloudwatch_event_api_destination.cron[0].arn]
    }]
  })
}

# Daily schedule.
resource "aws_scheduler_schedule" "cron" {
  count = local.cron_enabled ? 1 : 0
  name  = "${local.name_prefix}-maintenance-cron"

  flexible_time_window {
    mode = "OFF"
  }

  schedule_expression = var.cron_schedule_expression

  target {
    arn      = aws_cloudwatch_event_api_destination.cron[0].arn
    role_arn = aws_iam_role.cron_scheduler[0].arn

    retry_policy {
      maximum_retry_attempts = 2
    }
  }
}
