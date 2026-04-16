# =============================================================================
# ElastiCache for Redis — Realtime fanout bus
# =============================================================================
# Used by server/services/realtime/redis-bus.ts when REALTIME_BUS=redis.
#
# Payloads on this bus are intentionally ID-only (no message bodies, no PHI).
# The application rehydrates from Postgres before delivering to sockets, so
# Redis is *not* a PHI store. Even so, we provision it with TLS in transit,
# at-rest encryption (KMS), AUTH token, private subnets, and BAA-eligible
# settings — both because we are inside the HIPAA boundary and because losing
# the bus would break realtime delivery silently.
#
# Gated on var.enable_redis. Lean mode leaves all of this off (count = 0) so
# nothing is created and there is no cost. Flip enable_redis = true plus
# REALTIME_BUS=redis when moving to multi-instance ECS.

# =============================================================================
# Subnet group (private subnets only — no public access)
# =============================================================================
resource "aws_elasticache_subnet_group" "main" {
  count       = var.enable_redis ? 1 : 0
  name        = "${local.name_prefix}-redis-subnet-group"
  description = "Redis subnet group for AiVota realtime fanout"
  subnet_ids  = aws_subnet.private[*].id

  tags = {
    Name = "${local.name_prefix}-redis-subnet-group"
  }
}

# =============================================================================
# Parameter group
# =============================================================================
resource "aws_elasticache_parameter_group" "main" {
  count  = var.enable_redis ? 1 : 0
  name   = "${local.name_prefix}-redis-params"
  family = "redis7"

  # Disable potentially noisy / dangerous commands in production. KEYS and
  # FLUSHALL/FLUSHDB are blast-radius commands; renaming to "" disables them.
  # MONITOR is disabled by default; we explicitly do not re-enable it because
  # it would expose every payload (still ID-only, but unnecessary).
  parameter {
    name  = "maxmemory-policy"
    value = "allkeys-lru"
  }

  tags = {
    Name = "${local.name_prefix}-redis-params"
  }
}

# =============================================================================
# AUTH token (stored in Secrets Manager so ECS can inject it)
# =============================================================================
resource "random_password" "redis_auth" {
  count   = var.enable_redis ? 1 : 0
  length  = 64
  special = false # ElastiCache AUTH disallows certain symbols; printable alnum is safest
}

resource "aws_secretsmanager_secret" "redis_auth" {
  count       = var.enable_redis ? 1 : 0
  name        = "${local.name_prefix}/redis-auth"
  description = "ElastiCache Redis AUTH token for AiVota realtime bus"
  kms_key_id  = aws_kms_key.main.arn

  recovery_window_in_days = var.environment == "prod" ? 30 : 7

  tags = {
    Name = "${local.name_prefix}-redis-auth-secret"
  }
}

resource "aws_secretsmanager_secret_version" "redis_auth" {
  count     = var.enable_redis ? 1 : 0
  secret_id = aws_secretsmanager_secret.redis_auth[0].id
  secret_string = jsonencode({
    REDIS_AUTH_TOKEN = random_password.redis_auth[0].result
    REDIS_URL = format(
      "rediss://:%s@%s:6379",
      random_password.redis_auth[0].result,
      aws_elasticache_replication_group.main[0].primary_endpoint_address,
    )
  })
}

# =============================================================================
# Replication group (use this even for single-node — it's the modern resource
# and the only one that supports transit + at-rest encryption + AUTH).
# =============================================================================
resource "aws_elasticache_replication_group" "main" {
  count                = var.enable_redis ? 1 : 0
  replication_group_id = "${local.name_prefix}-redis"
  description          = "AiVota realtime fanout bus (ID-only payloads — no PHI)"

  engine               = "redis"
  engine_version       = var.redis_engine_version
  node_type            = var.redis_node_type
  num_cache_clusters   = var.redis_num_cache_clusters
  parameter_group_name = aws_elasticache_parameter_group.main[0].name
  port                 = 6379

  subnet_group_name  = aws_elasticache_subnet_group.main[0].name
  security_group_ids = [aws_security_group.redis.id]

  # Multi-AZ + automatic failover only meaningful with >=2 nodes.
  automatic_failover_enabled = var.redis_num_cache_clusters > 1
  multi_az_enabled           = var.redis_num_cache_clusters > 1 && var.environment == "prod"

  # HIPAA-grade encryption.
  at_rest_encryption_enabled = true
  transit_encryption_enabled = true
  kms_key_id                 = aws_kms_key.main.arn
  auth_token                 = random_password.redis_auth[0].result

  # Backups — even though we treat the bus as ephemeral, snapshot retention
  # gives us a recovery story if a node is replaced unexpectedly.
  snapshot_retention_limit = var.redis_snapshot_retention_days
  snapshot_window          = "03:00-05:00"
  maintenance_window       = "sun:05:00-sun:07:00"

  apply_immediately   = var.environment != "prod"
  auto_minor_version_upgrade = true

  log_delivery_configuration {
    destination      = aws_cloudwatch_log_group.redis_slow[0].name
    destination_type = "cloudwatch-logs"
    log_format       = "json"
    log_type         = "slow-log"
  }

  log_delivery_configuration {
    destination      = aws_cloudwatch_log_group.redis_engine[0].name
    destination_type = "cloudwatch-logs"
    log_format       = "json"
    log_type         = "engine-log"
  }

  tags = {
    Name = "${local.name_prefix}-redis"
  }
}

# =============================================================================
# CloudWatch log groups for Redis logs
# =============================================================================
resource "aws_cloudwatch_log_group" "redis_slow" {
  count             = var.enable_redis ? 1 : 0
  name              = "/aws/elasticache/${local.name_prefix}-redis/slow-log"
  retention_in_days = var.app_log_retention_days
  kms_key_id        = aws_kms_key.main.arn

  tags = {
    Name = "${local.name_prefix}-redis-slow-log"
  }
}

resource "aws_cloudwatch_log_group" "redis_engine" {
  count             = var.enable_redis ? 1 : 0
  name              = "/aws/elasticache/${local.name_prefix}-redis/engine-log"
  retention_in_days = var.app_log_retention_days
  kms_key_id        = aws_kms_key.main.arn

  tags = {
    Name = "${local.name_prefix}-redis-engine-log"
  }
}

# =============================================================================
# Outputs
# =============================================================================
output "redis_primary_endpoint" {
  description = "Primary endpoint for the Redis replication group (empty if disabled)"
  value       = var.enable_redis ? aws_elasticache_replication_group.main[0].primary_endpoint_address : ""
}

output "redis_auth_secret_arn" {
  description = "ARN of the Secrets Manager entry holding REDIS_AUTH_TOKEN and REDIS_URL"
  value       = var.enable_redis ? aws_secretsmanager_secret.redis_auth[0].arn : ""
}
