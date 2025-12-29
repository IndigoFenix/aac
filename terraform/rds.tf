# =============================================================================
# RDS PostgreSQL - HIPAA Compliant Database
# =============================================================================

# =============================================================================
# Find available PostgreSQL version for this region
# =============================================================================
data "aws_rds_engine_version" "postgres" {
  engine             = "postgres"
  preferred_versions = ["16.11", "16.10", "16.9", "16.8", "16.6", "15.15", "15.14", "15.13", "15.12", "15.10", "14.20", "14.19"]
}

# =============================================================================
# DB Subnet Group
# =============================================================================
resource "aws_db_subnet_group" "main" {
  name        = "${local.name_prefix}-db-subnet-group"
  description = "Database subnet group for CliniAACian"
  subnet_ids  = aws_subnet.private[*].id

  tags = {
    Name = "${local.name_prefix}-db-subnet-group"
  }
}

# =============================================================================
# RDS Parameter Group (for PostgreSQL tuning)
# =============================================================================
resource "aws_db_parameter_group" "main" {
  family = data.aws_rds_engine_version.postgres.parameter_group_family
  name   = "${local.name_prefix}-pg-params"

  # Force SSL connections (HIPAA requirement)
  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }

  # Logging parameters for audit (don't log actual query data for privacy)
  parameter {
    name  = "log_connections"
    value = "1"
  }

  parameter {
    name  = "log_disconnections"
    value = "1"
  }

  parameter {
    name  = "log_statement"
    value = "ddl"  # Only log DDL statements, not data queries
  }

  tags = {
    Name = "${local.name_prefix}-pg-params"
  }
}

# =============================================================================
# RDS Instance
# =============================================================================
resource "aws_db_instance" "main" {
  identifier = "${local.name_prefix}-postgres"

  # Engine - using data source to find available version in this region
  engine               = "postgres"
  engine_version       = data.aws_rds_engine_version.postgres.version
  instance_class       = var.db_instance_class
  
  # Storage
  allocated_storage     = var.db_allocated_storage
  max_allocated_storage = var.db_max_allocated_storage
  storage_type          = "gp3"
  storage_encrypted     = true
  kms_key_id            = aws_kms_key.main.arn

  # Database
  db_name  = "cliniaccian"
  username = "cliniaccian_admin"
  password = random_password.db_password.result

  # Network
  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.rds.id]
  publicly_accessible    = false
  port                   = 5432

  # Parameter group
  parameter_group_name = aws_db_parameter_group.main.name

  # Backup (HIPAA requires point-in-time recovery)
  backup_retention_period = var.environment == "prod" ? 35 : 7
  backup_window           = "03:00-04:00"  # UTC
  maintenance_window      = "Mon:04:00-Mon:05:00"

  # High Availability (production only)
  multi_az = var.environment == "prod"

  # Monitoring
  monitoring_interval             = 60
  monitoring_role_arn             = aws_iam_role.rds_monitoring.arn
  performance_insights_enabled    = true
  performance_insights_kms_key_id = aws_kms_key.main.arn
  performance_insights_retention_period = 7

  # Logs
  enabled_cloudwatch_logs_exports = ["postgresql", "upgrade"]

  # Protection
  deletion_protection = var.environment == "prod"
  skip_final_snapshot = var.environment != "prod"
  final_snapshot_identifier = var.environment == "prod" ? "${local.name_prefix}-final-snapshot" : null

  # Updates
  auto_minor_version_upgrade  = true
  allow_major_version_upgrade = false
  apply_immediately           = var.environment != "prod"

  tags = {
    Name       = "${local.name_prefix}-postgres"
    DataClass  = "PHI"
    Compliance = "HIPAA-FERPA"
  }

  lifecycle {
    prevent_destroy = false  # Set to true in production after initial setup
  }
}

# =============================================================================
# Generate random password for database
# =============================================================================
resource "random_password" "db_password" {
  length           = 32
  special          = true
  override_special = "!#$%&*()-_=+[]{}<>:?"
}

# =============================================================================
# Store database credentials in Secrets Manager
# =============================================================================
resource "aws_secretsmanager_secret_version" "database_generated" {
  secret_id = aws_secretsmanager_secret.database.id
  secret_string = jsonencode({
    DATABASE_URL = "postgresql://${aws_db_instance.main.username}:${random_password.db_password.result}@${aws_db_instance.main.endpoint}/${aws_db_instance.main.db_name}?sslmode=require"
    DB_HOST      = aws_db_instance.main.address
    DB_PORT      = tostring(aws_db_instance.main.port)
    DB_NAME      = aws_db_instance.main.db_name
    DB_USER      = aws_db_instance.main.username
    DB_PASSWORD  = random_password.db_password.result
  })

  lifecycle {
    ignore_changes = [secret_string]  # Don't overwrite if manually updated
  }
}

# =============================================================================
# RDS Enhanced Monitoring Role
# =============================================================================
resource "aws_iam_role" "rds_monitoring" {
  name = "${local.name_prefix}-rds-monitoring-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "monitoring.rds.amazonaws.com"
        }
      }
    ]
  })

  tags = {
    Name = "${local.name_prefix}-rds-monitoring-role"
  }
}

resource "aws_iam_role_policy_attachment" "rds_monitoring" {
  role       = aws_iam_role.rds_monitoring.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonRDSEnhancedMonitoringRole"
}

# =============================================================================
# CloudWatch Alarms for RDS
# =============================================================================
resource "aws_cloudwatch_metric_alarm" "db_cpu" {
  alarm_name          = "${local.name_prefix}-db-high-cpu"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "CPUUtilization"
  namespace           = "AWS/RDS"
  period              = 300
  statistic           = "Average"
  threshold           = 80
  alarm_description   = "Database CPU utilization is high"

  dimensions = {
    DBInstanceIdentifier = aws_db_instance.main.identifier
  }

  alarm_actions = [aws_sns_topic.alerts.arn]
  ok_actions    = [aws_sns_topic.alerts.arn]

  tags = {
    Name = "${local.name_prefix}-db-cpu-alarm"
  }
}

resource "aws_cloudwatch_metric_alarm" "db_storage" {
  alarm_name          = "${local.name_prefix}-db-low-storage"
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = 1
  metric_name         = "FreeStorageSpace"
  namespace           = "AWS/RDS"
  period              = 300
  statistic           = "Average"
  threshold           = 5368709120  # 5 GB in bytes
  alarm_description   = "Database free storage is low"

  dimensions = {
    DBInstanceIdentifier = aws_db_instance.main.identifier
  }

  alarm_actions = [aws_sns_topic.alerts.arn]

  tags = {
    Name = "${local.name_prefix}-db-storage-alarm"
  }
}

resource "aws_cloudwatch_metric_alarm" "db_connections" {
  alarm_name          = "${local.name_prefix}-db-high-connections"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "DatabaseConnections"
  namespace           = "AWS/RDS"
  period              = 300
  statistic           = "Average"
  threshold           = 100
  alarm_description   = "Database connection count is high"

  dimensions = {
    DBInstanceIdentifier = aws_db_instance.main.identifier
  }

  alarm_actions = [aws_sns_topic.alerts.arn]

  tags = {
    Name = "${local.name_prefix}-db-connections-alarm"
  }
}
