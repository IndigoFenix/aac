# =============================================================================
# ECR Repository
# =============================================================================
resource "aws_ecr_repository" "main" {
  name                 = "aivota"
  image_tag_mutability = "MUTABLE"

  image_scanning_configuration {
    scan_on_push = true  # Security scanning
  }

  encryption_configuration {
    encryption_type = "KMS"
    kms_key         = aws_kms_key.main.arn
  }

  tags = {
    Name = "${local.name_prefix}-ecr"
  }
}

# Lifecycle policy to clean up old images
resource "aws_ecr_lifecycle_policy" "main" {
  repository = aws_ecr_repository.main.name

  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Keep last 10 images"
        selection = {
          tagStatus   = "any"
          countType   = "imageCountMoreThan"
          countNumber = 10
        }
        action = {
          type = "expire"
        }
      }
    ]
  })
}

# =============================================================================
# ECS Cluster
# =============================================================================
resource "aws_ecs_cluster" "main" {
  name = "${local.name_prefix}-cluster"

  setting {
    name  = "containerInsights"
    value = "enabled"  # Enhanced monitoring
  }

  configuration {
    execute_command_configuration {
      kms_key_id = aws_kms_key.main.arn
      logging    = "OVERRIDE"

      log_configuration {
        cloud_watch_encryption_enabled = true
        cloud_watch_log_group_name     = aws_cloudwatch_log_group.ecs_exec.name
      }
    }
  }

  tags = {
    Name = "${local.name_prefix}-cluster"
  }
}

resource "aws_cloudwatch_log_group" "ecs_exec" {
  name              = "/aws/ecs/${local.name_prefix}/exec"
  retention_in_days = var.app_log_retention_days
  kms_key_id        = aws_kms_key.main.arn

  tags = {
    Name = "${local.name_prefix}-ecs-exec-logs"
  }
}

# =============================================================================
# ECS Task Definition
# =============================================================================
resource "aws_ecs_task_definition" "main" {
  family                   = "${local.name_prefix}-task"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = var.ecs_task_cpu
  memory                   = var.ecs_task_memory
  execution_role_arn       = aws_iam_role.ecs_task_execution.arn
  task_role_arn            = aws_iam_role.ecs_task.arn

  container_definitions = jsonencode([
    {
      name  = "aivota-app"
      image = "${aws_ecr_repository.main.repository_url}:latest"
      
      portMappings = [
        {
          containerPort = var.container_port
          hostPort      = var.container_port
          protocol      = "tcp"
        }
      ]

      environment = concat(
        [
          {
            name  = "NODE_ENV"
            value = var.environment == "prod" ? "production" : var.environment
          },
          {
            name  = "ENVIRONMENT"
            value = var.environment
          },
          {
            name  = "PORT"
            value = tostring(var.container_port)
          },
          {
            name  = "AWS_REGION"
            value = var.aws_region
          },
          {
            name  = "AWS_SECRETS_REGION"
            value = var.aws_region
          },
          # Automatic logoff for clinician/admin sessions (server/session-lifetime.ts).
          # `session_timeout_minutes` was declared in every tfvars and read by
          # nothing until 2026-08-26.
          {
            name  = "SESSION_IDLE_TIMEOUT_MINUTES"
            value = tostring(var.session_timeout_minutes)
          },
          # The container loads the WHOLE app-secrets JSON into process.env at
          # boot (server/config/aws-secrets.ts) — same as Lambda, so adding a
          # key to the secret needs no Terraform change. Unlike Lambda, values
          # set here WIN over keys in the secret.
          {
            name  = "DATABASE_SECRET_ARN"
            value = aws_secretsmanager_secret.database.arn
          },
          {
            name  = "APP_SECRETS_ARN"
            value = aws_secretsmanager_secret.app_secrets.arn
          },
          {
            name  = "S3_UPLOADS_BUCKET"
            value = aws_s3_bucket.uploads.bucket
          },
          {
            name  = "APP_URL"
            value = var.domain_name != "" ? "https://app.${var.domain_name}" : ""
          },
          {
            # Browser origins allowed by CORS/CSRF. The native app origins
            # (app://aac, capacitor://localhost) are always added by the server.
            name  = "ALLOWED_ORIGINS"
            value = var.domain_name != "" ? "https://${var.domain_name},https://app.${var.domain_name}" : ""
          },
          {
            # Transactional email via SES (docs/EMAIL.md). Sender identity is
            # config, not a secret — the role's ses:SendEmail grant is the
            # credential; region comes from AWS_REGION above.
            name  = "EMAIL_FROM"
            value = var.email_from
          },
          {
            name  = "EMAIL_REPLY_TO"
            value = var.email_reply_to
          },
          {
            # Realtime fanout selection. With Redis on, ID-only payloads cross
            # the bus (see server/services/personChat/personChatFanout.ts); without
            # it, falls back to Postgres LISTEN/NOTIFY.
            name  = "REALTIME_BUS"
            value = var.enable_redis ? "redis" : "postgres"
          }
        ],
        # TURN relay urls (non-secret). TURN_SECRET is injected via secrets below.
        var.enable_coturn ? [
          {
            name  = "TURN_URLS"
            value = local.coturn_turn_urls
          },
          {
            name  = "TURN_TTL"
            value = tostring(var.coturn_credential_ttl_seconds)
          }
        ] : []
      )

      secrets = concat(
        var.enable_redis ? [
          {
            name      = "REDIS_URL"
            valueFrom = "${aws_secretsmanager_secret.redis_auth[0].arn}:REDIS_URL::"
          }
        ] : [],
        var.enable_coturn ? [
          {
            name      = "TURN_SECRET"
            valueFrom = "${aws_secretsmanager_secret.turn[0].arn}:TURN_SECRET::"
          }
        ] : [],
        [
        # Database. Everything in app-secrets is loaded at boot by the app
        # itself (see APP_SECRETS_ARN above) rather than enumerated here — a
        # hand-maintained list silently dropped every key added after it was
        # written. Email needs NO secret: SES authenticates via the task role
        # (ses:SendEmail in ses.tf); EMAIL_FROM above wins over any stale
        # SMTP_*/EMAIL_* key still sitting in the secret.
        {
          name      = "DATABASE_URL"
          valueFrom = "${aws_secretsmanager_secret.database.arn}:DATABASE_URL::"
        }
        ]
      )

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.app.name
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "ecs"
        }
      }

      healthCheck = {
        command     = ["CMD-SHELL", "wget --no-verbose --tries=1 --spider http://localhost:${var.container_port}/health || exit 1"]
        interval    = 30
        timeout     = 10
        retries     = 3
        startPeriod = 120  # 2 minutes for migrations to complete
      }

      essential = true
    }
  ])

  tags = {
    Name = "${local.name_prefix}-task"
  }
}

# =============================================================================
# ECS Service
# =============================================================================
resource "aws_ecs_service" "main" {
  name            = "${local.name_prefix}-service"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.main.arn
  desired_count   = var.use_lambda ? 0 : var.ecs_desired_count  # Scale to 0 when using Lambda
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.ecs.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.main.arn
    container_name   = "aivota-app"
    container_port   = var.container_port
  }

  deployment_maximum_percent         = 200
  deployment_minimum_healthy_percent = 100
  health_check_grace_period_seconds  = 120  # Wait 2 minutes before ALB health checks

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  # Enable ECS Exec for debugging (uses IAM for auth)
  enable_execute_command = true

  # The deploy workflow registers a new revision per image (sha-tagged) and
  # points the service at it. Terraform still owns the task definition
  # template — a change here creates a new revision, and the next deploy
  # renders its image onto that revision — it just must not flip the service
  # back to its own :latest revision on every apply.
  lifecycle {
    ignore_changes = [task_definition]
  }

  depends_on = [
    aws_lb_listener.http
  ]

  tags = {
    Name = "${local.name_prefix}-service"
  }
}

# =============================================================================
# Auto Scaling
# =============================================================================
resource "aws_appautoscaling_target" "ecs" {
  max_capacity       = var.use_lambda ? 0 : var.ecs_autoscaling_max
  min_capacity       = var.use_lambda ? 0 : min(var.ecs_desired_count, var.ecs_autoscaling_max)
  resource_id        = "service/${aws_ecs_cluster.main.name}/${aws_ecs_service.main.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  service_namespace  = "ecs"
}

resource "aws_appautoscaling_policy" "cpu" {
  name               = "${local.name_prefix}-cpu-autoscaling"
  policy_type        = "TargetTrackingScaling"
  resource_id        = aws_appautoscaling_target.ecs.resource_id
  scalable_dimension = aws_appautoscaling_target.ecs.scalable_dimension
  service_namespace  = aws_appautoscaling_target.ecs.service_namespace

  target_tracking_scaling_policy_configuration {
    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
    target_value       = 70.0
    scale_in_cooldown  = 300
    scale_out_cooldown = 60
  }
}

resource "aws_appautoscaling_policy" "memory" {
  name               = "${local.name_prefix}-memory-autoscaling"
  policy_type        = "TargetTrackingScaling"
  resource_id        = aws_appautoscaling_target.ecs.resource_id
  scalable_dimension = aws_appautoscaling_target.ecs.scalable_dimension
  service_namespace  = aws_appautoscaling_target.ecs.service_namespace

  target_tracking_scaling_policy_configuration {
    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageMemoryUtilization"
    }
    target_value       = 80.0
    scale_in_cooldown  = 300
    scale_out_cooldown = 60
  }
}

# =============================================================================
# Application Load Balancer
# =============================================================================
resource "aws_lb" "main" {
  name               = "${local.name_prefix}-alb"
  internal           = false
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = aws_subnet.public[*].id

  enable_deletion_protection = var.environment == "prod" && !var.use_lambda
  idle_timeout               = var.alb_idle_timeout_seconds

  access_logs {
    bucket  = aws_s3_bucket.logs.bucket
    prefix  = "alb-logs"
    enabled = !var.use_lambda
  }

  tags = {
    Name = "${local.name_prefix}-alb"
  }
}

resource "aws_lb_target_group" "main" {
  name        = "${local.name_prefix}-tg"
  port        = var.container_port
  protocol    = "HTTP"
  vpc_id      = aws_vpc.main.id
  target_type = "ip"

  health_check {
    enabled             = true
    healthy_threshold   = 2
    interval            = 30
    matcher             = "200"
    path                = "/health"
    port                = "traffic-port"
    protocol            = "HTTP"
    timeout             = 10
    unhealthy_threshold = 5  # More lenient - 5 failures before unhealthy
  }

  # Give containers time to drain connections before deregistration
  deregistration_delay = 30

  # Sessions live in Postgres and realtime fanout crosses the bus, so
  # stickiness is not a correctness requirement — it just keeps a client's
  # HTTP + WebSocket traffic on one task, which keeps per-session in-memory
  # caches warm when running more than one.
  stickiness {
    type            = "lb_cookie"
    cookie_duration = 86400
    enabled         = true
  }

  tags = {
    Name = "${local.name_prefix}-tg"
  }
}

# HTTP listener
# - When using Lambda: Just forward to target group (no redirect needed, CloudFront handles HTTPS)
# - When using ECS with domain: Redirect HTTP to HTTPS
# - When using ECS without domain: Forward to target group
resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.main.arn
  port              = 80
  protocol          = "HTTP"

  # When NOT using Lambda and we have a domain, redirect to HTTPS
  dynamic "default_action" {
    for_each = var.domain_name != "" && !var.use_lambda ? [1] : []
    content {
      type = "redirect"

      redirect {
        port        = "443"
        protocol    = "HTTPS"
        status_code = "HTTP_301"
      }
    }
  }

  # When using Lambda OR no domain, forward to target group
  dynamic "default_action" {
    for_each = var.domain_name == "" || var.use_lambda ? [1] : []
    content {
      type             = "forward"
      target_group_arn = aws_lb_target_group.main.arn
    }
  }
}

# HTTPS listener (only when we have a domain AND NOT using Lambda)
# When using Lambda, CloudFront handles HTTPS termination
resource "aws_lb_listener" "https" {
  count = var.domain_name != "" && !var.use_lambda ? 1 : 0

  load_balancer_arn = aws_lb.main.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"  # TLS 1.2+ only
  certificate_arn   = aws_acm_certificate_validation.main[0].certificate_arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.main.arn
  }

  depends_on = [aws_acm_certificate_validation.main]
}

# =============================================================================
# ACM Certificate (for HTTPS - only when domain is provided AND NOT using Lambda)
# When using Lambda, CloudFront uses a separate certificate in us-east-1
# =============================================================================
locals {
  # Direct-to-ALB hostname (api.<domain>): CloudFront's origin and the packaged
  # AAC clients' API base. Empty when there is no domain or the subdomain is
  # disabled.
  api_host = var.domain_name != "" && var.api_subdomain != "" ? "${var.api_subdomain}.${var.domain_name}" : ""

  alb_cert_sans = {
    www = "www.${var.domain_name}"
    app = "app.${var.domain_name}"
    api = local.api_host
  }
}

resource "aws_acm_certificate" "main" {
  count = var.domain_name != "" && !var.use_lambda ? 1 : 0

  domain_name               = var.domain_name
  subject_alternative_names = compact(values(local.alb_cert_sans))
  validation_method         = "DNS"

  lifecycle {
    create_before_destroy = true
  }

  tags = {
    Name = "${local.name_prefix}-cert"
  }
}

# =============================================================================
# CloudWatch Log Group for Application
# =============================================================================
resource "aws_cloudwatch_log_group" "app" {
  name              = "/ecs/${local.name_prefix}"
  retention_in_days = var.app_log_retention_days
  kms_key_id        = aws_kms_key.main.arn

  tags = {
    Name = "${local.name_prefix}-app-logs"
  }
}
