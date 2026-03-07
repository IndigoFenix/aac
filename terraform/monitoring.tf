# =============================================================================
# CloudTrail (Audit Logging - HIPAA requirement)
# Disabled in lean mode to save costs. Re-enable before handling real PHI data.
# =============================================================================
resource "aws_cloudtrail" "main" {
  count = var.enable_cloudtrail ? 1 : 0

  name                          = "${local.name_prefix}-trail"
  s3_bucket_name                = aws_s3_bucket.logs.id
  s3_key_prefix                 = "cloudtrail"
  include_global_service_events = true
  is_multi_region_trail         = true
  enable_log_file_validation    = true
  kms_key_id                    = aws_kms_key.main.arn

  cloud_watch_logs_group_arn = "${aws_cloudwatch_log_group.cloudtrail[0].arn}:*"
  cloud_watch_logs_role_arn  = aws_iam_role.cloudtrail[0].arn

  event_selector {
    read_write_type           = "All"
    include_management_events = true

    data_resource {
      type   = "AWS::S3::Object"
      values = ["${aws_s3_bucket.uploads.arn}/"]
    }
  }

  depends_on = [
    aws_s3_bucket_policy.logs
  ]

  tags = {
    Name = "${local.name_prefix}-cloudtrail"
  }
}

resource "aws_cloudwatch_log_group" "cloudtrail" {
  count = var.enable_cloudtrail ? 1 : 0

  name              = "/aws/cloudtrail/${local.name_prefix}"
  retention_in_days = var.app_log_retention_days
  kms_key_id        = aws_kms_key.main.arn

  tags = {
    Name = "${local.name_prefix}-cloudtrail-logs"
  }
}

resource "aws_iam_role" "cloudtrail" {
  count = var.enable_cloudtrail ? 1 : 0

  name = "${local.name_prefix}-cloudtrail-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "cloudtrail.amazonaws.com"
        }
      }
    ]
  })
}

resource "aws_iam_role_policy" "cloudtrail" {
  count = var.enable_cloudtrail ? 1 : 0

  name = "${local.name_prefix}-cloudtrail-policy"
  role = aws_iam_role.cloudtrail[0].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "logs:CreateLogStream",
          "logs:PutLogEvents"
        ]
        Resource = "${aws_cloudwatch_log_group.cloudtrail[0].arn}:*"
      }
    ]
  })
}

# =============================================================================
# GuardDuty (Threat Detection) - Use data source for existing detector
# =============================================================================
data "aws_guardduty_detector" "existing" {
  count = var.enable_guardduty ? 1 : 0
}

# =============================================================================
# WAF (Web Application Firewall) - Only for ECS/ALB mode
# =============================================================================
resource "aws_wafv2_web_acl" "main" {
  count = var.enable_waf && !var.use_lambda ? 1 : 0

  name        = "${local.name_prefix}-waf"
  description = "WAF for AiVota ALB"
  scope       = "REGIONAL"

  default_action {
    allow {}
  }

  rule {
    name     = "AWSManagedRulesCommonRuleSet"
    priority = 1

    override_action {
      none {}
    }

    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesCommonRuleSet"
        vendor_name = "AWS"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "AWSManagedRulesCommonRuleSet"
      sampled_requests_enabled   = true
    }
  }

  rule {
    name     = "AWSManagedRulesKnownBadInputsRuleSet"
    priority = 2

    override_action {
      none {}
    }

    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesKnownBadInputsRuleSet"
        vendor_name = "AWS"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "AWSManagedRulesKnownBadInputsRuleSet"
      sampled_requests_enabled   = true
    }
  }

  rule {
    name     = "AWSManagedRulesSQLiRuleSet"
    priority = 3

    override_action {
      none {}
    }

    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesSQLiRuleSet"
        vendor_name = "AWS"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "AWSManagedRulesSQLiRuleSet"
      sampled_requests_enabled   = true
    }
  }

  rule {
    name     = "RateLimitRule"
    priority = 4

    action {
      block {}
    }

    statement {
      rate_based_statement {
        limit              = 2000
        aggregate_key_type = "IP"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "RateLimitRule"
      sampled_requests_enabled   = true
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "${local.name_prefix}-waf"
    sampled_requests_enabled   = true
  }

  tags = {
    Name = "${local.name_prefix}-waf"
  }
}

resource "aws_wafv2_web_acl_association" "main" {
  count = var.enable_waf && !var.use_lambda ? 1 : 0

  resource_arn = aws_lb.main.arn
  web_acl_arn  = aws_wafv2_web_acl.main[0].arn
}

# =============================================================================
# CloudWatch Alarms (ECS-specific)
# =============================================================================
resource "aws_cloudwatch_metric_alarm" "high_cpu" {
  count = !var.use_lambda ? 1 : 0

  alarm_name          = "${local.name_prefix}-high-cpu"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "CPUUtilization"
  namespace           = "AWS/ECS"
  period              = 300
  statistic           = "Average"
  threshold           = 80
  alarm_description   = "High CPU utilization"

  dimensions = {
    ClusterName = aws_ecs_cluster.main.name
    ServiceName = aws_ecs_service.main.name
  }

  alarm_actions = [aws_sns_topic.alerts.arn]
  ok_actions    = [aws_sns_topic.alerts.arn]

  tags = { Name = "${local.name_prefix}-high-cpu-alarm" }
}

resource "aws_cloudwatch_metric_alarm" "high_memory" {
  count = !var.use_lambda ? 1 : 0

  alarm_name          = "${local.name_prefix}-high-memory"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "MemoryUtilization"
  namespace           = "AWS/ECS"
  period              = 300
  statistic           = "Average"
  threshold           = 80
  alarm_description   = "High memory utilization"

  dimensions = {
    ClusterName = aws_ecs_cluster.main.name
    ServiceName = aws_ecs_service.main.name
  }

  alarm_actions = [aws_sns_topic.alerts.arn]
  ok_actions    = [aws_sns_topic.alerts.arn]

  tags = { Name = "${local.name_prefix}-high-memory-alarm" }
}

resource "aws_cloudwatch_metric_alarm" "alb_5xx" {
  count = !var.use_lambda ? 1 : 0

  alarm_name          = "${local.name_prefix}-alb-5xx"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "HTTPCode_Target_5XX_Count"
  namespace           = "AWS/ApplicationELB"
  period              = 300
  statistic           = "Sum"
  threshold           = 10
  alarm_description   = "High 5XX error rate"

  dimensions = {
    LoadBalancer = aws_lb.main.arn_suffix
    TargetGroup  = aws_lb_target_group.main.arn_suffix
  }

  alarm_actions = [aws_sns_topic.alerts.arn]
  ok_actions    = [aws_sns_topic.alerts.arn]

  tags = { Name = "${local.name_prefix}-5xx-alarm" }
}

# Failed login attempts alarm (works for both modes)
resource "aws_cloudwatch_metric_alarm" "failed_logins" {
  alarm_name          = "${local.name_prefix}-failed-logins"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "FailedLoginAttempts"
  namespace           = "AiVota"
  period              = 300
  statistic           = "Sum"
  threshold           = 10
  alarm_description   = "High number of failed login attempts"
  treat_missing_data  = "notBreaching"

  alarm_actions = [aws_sns_topic.alerts.arn]

  tags = { Name = "${local.name_prefix}-failed-logins-alarm" }
}

# =============================================================================
# Lambda-specific Alarms (only when Lambda function exists)
# =============================================================================
resource "aws_cloudwatch_metric_alarm" "lambda_errors" {
  count = var.use_lambda && var.lambda_image_exists ? 1 : 0

  alarm_name          = "${local.name_prefix}-lambda-errors"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "Errors"
  namespace           = "AWS/Lambda"
  period              = 300
  statistic           = "Sum"
  threshold           = 5
  alarm_description   = "Lambda function errors"

  dimensions = {
    FunctionName = aws_lambda_function.api[0].function_name
  }

  alarm_actions = [aws_sns_topic.alerts.arn]
  ok_actions    = [aws_sns_topic.alerts.arn]

  tags = { Name = "${local.name_prefix}-lambda-errors-alarm" }
}

resource "aws_cloudwatch_metric_alarm" "lambda_duration" {
  count = var.use_lambda && var.lambda_image_exists ? 1 : 0

  alarm_name          = "${local.name_prefix}-lambda-duration"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "Duration"
  namespace           = "AWS/Lambda"
  period              = 300
  statistic           = "Average"
  threshold           = 25000
  alarm_description   = "Lambda function approaching timeout"

  dimensions = {
    FunctionName = aws_lambda_function.api[0].function_name
  }

  alarm_actions = [aws_sns_topic.alerts.arn]

  tags = { Name = "${local.name_prefix}-lambda-duration-alarm" }
}

# =============================================================================
# SNS Topic for Alerts
# =============================================================================
resource "aws_sns_topic" "alerts" {
  name              = "${local.name_prefix}-alerts"
  kms_master_key_id = aws_kms_key.main.id

  tags = { Name = "${local.name_prefix}-alerts" }
}

# =============================================================================
# CloudWatch Dashboard (ECS mode)
# =============================================================================
resource "aws_cloudwatch_dashboard" "main" {
  count = !var.use_lambda ? 1 : 0

  dashboard_name = "${local.name_prefix}-dashboard"

  dashboard_body = jsonencode({
    widgets = [
      {
        type = "metric", x = 0, y = 0, width = 12, height = 6
        properties = {
          title = "ECS CPU Utilization", region = var.aws_region, period = 300, stat = "Average"
          metrics = [["AWS/ECS", "CPUUtilization", "ClusterName", aws_ecs_cluster.main.name, "ServiceName", aws_ecs_service.main.name]]
        }
      },
      {
        type = "metric", x = 12, y = 0, width = 12, height = 6
        properties = {
          title = "ECS Memory Utilization", region = var.aws_region, period = 300, stat = "Average"
          metrics = [["AWS/ECS", "MemoryUtilization", "ClusterName", aws_ecs_cluster.main.name, "ServiceName", aws_ecs_service.main.name]]
        }
      },
      {
        type = "metric", x = 0, y = 6, width = 12, height = 6
        properties = {
          title = "ALB Request Count", region = var.aws_region, period = 60, stat = "Sum"
          metrics = [["AWS/ApplicationELB", "RequestCount", "LoadBalancer", aws_lb.main.arn_suffix]]
        }
      },
      {
        type = "metric", x = 12, y = 6, width = 12, height = 6
        properties = {
          title = "ALB Response Time", region = var.aws_region, period = 60, stat = "Average"
          metrics = [["AWS/ApplicationELB", "TargetResponseTime", "LoadBalancer", aws_lb.main.arn_suffix]]
        }
      }
    ]
  })
}

# Lambda dashboard (only when Lambda function exists)
resource "aws_cloudwatch_dashboard" "lambda" {
  count = var.use_lambda && var.lambda_image_exists ? 1 : 0

  dashboard_name = "${local.name_prefix}-lambda-dashboard"

  dashboard_body = jsonencode({
    widgets = [
      {
        type = "metric", x = 0, y = 0, width = 12, height = 6
        properties = {
          title = "Lambda Invocations", region = var.aws_region, period = 300, stat = "Sum"
          metrics = [["AWS/Lambda", "Invocations", "FunctionName", aws_lambda_function.api[0].function_name]]
        }
      },
      {
        type = "metric", x = 12, y = 0, width = 12, height = 6
        properties = {
          title = "Lambda Duration", region = var.aws_region, period = 300, stat = "Average"
          metrics = [["AWS/Lambda", "Duration", "FunctionName", aws_lambda_function.api[0].function_name]]
        }
      },
      {
        type = "metric", x = 0, y = 6, width = 12, height = 6
        properties = {
          title = "Lambda Errors", region = var.aws_region, period = 300, stat = "Sum"
          metrics = [["AWS/Lambda", "Errors", "FunctionName", aws_lambda_function.api[0].function_name]]
        }
      },
      {
        type = "metric", x = 12, y = 6, width = 12, height = 6
        properties = {
          title = "Lambda Concurrent Executions", region = var.aws_region, period = 60, stat = "Maximum"
          metrics = [["AWS/Lambda", "ConcurrentExecutions", "FunctionName", aws_lambda_function.api[0].function_name]]
        }
      }
    ]
  })
}
