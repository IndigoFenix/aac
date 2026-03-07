#!/bin/bash
# =============================================================================
# Migrate data from old cliniaacian-prod resources to new aivota-prod resources.
#
# Prerequisites:
#   - AWS CLI configured with appropriate permissions
#   - SSM Session Manager plugin installed
#   - New infrastructure must already be created (run Terraform first)
#   - Either: psql/pg_dump installed locally, OR Docker available
#
# This script opens SSM tunnels to both databases automatically.
#
# Usage:
#   bash terraform/migrate-data.sh
# =============================================================================
set -euo pipefail

REGION="il-central-1"
OLD_PREFIX="cliniaacian-prod"
NEW_PREFIX="aivota-prod"
# Auto-discover bastion instance by tag
EC2_INSTANCE=$(aws ec2 describe-instances --region "$REGION" \
  --filters "Name=tag:Name,Values=aivota-prod-bastion" "Name=instance-state-name,Values=running" \
  --query "Reservations[0].Instances[0].InstanceId" --output text 2>/dev/null || echo "None")

if [ "$EC2_INSTANCE" = "None" ] || [ -z "$EC2_INSTANCE" ]; then
  echo "ERROR: No running bastion instance found with tag 'aivota-prod-bastion'."
  echo "Make sure Terraform has been applied first."
  exit 1
fi
echo "Bastion instance: $EC2_INSTANCE"

OLD_LOCAL_PORT=5432
NEW_LOCAL_PORT=5433

# Track background tunnel PIDs for cleanup
TUNNEL_PIDS=()
cleanup_tunnels() {
  echo ""
  echo "Closing SSM tunnels..."
  for pid in "${TUNNEL_PIDS[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
}
trap cleanup_tunnels EXIT

# =============================================================================
# Check for pg_dump/psql — fall back to Docker if missing
# =============================================================================
USE_DOCKER=false
if command -v pg_dump &>/dev/null && command -v psql &>/dev/null; then
  echo "Using local pg_dump/psql"
  PG_DUMP="pg_dump"
  PSQL="psql"
else
  echo "pg_dump/psql not found locally."
  if command -v docker &>/dev/null; then
    echo "Using Docker (postgres:16-alpine) for pg_dump/psql"
    USE_DOCKER=true
    # Pull image if not present
    docker pull postgres:16-alpine 2>/dev/null || true
  else
    echo ""
    echo "ERROR: Neither pg_dump/psql nor Docker are available."
    echo ""
    echo "Install one of:"
    echo "  - PostgreSQL client: https://www.postgresql.org/download/"
    echo "    On Windows: winget install PostgreSQL.PostgreSQL"
    echo "    On Mac: brew install libpq"
    echo "  - Docker Desktop: https://www.docker.com/products/docker-desktop/"
    exit 1
  fi
fi

# =============================================================================
# Discover AWS Account ID
# =============================================================================
ACCOUNT_ID=$(aws sts get-caller-identity --query "Account" --output text)
echo "AWS Account: $ACCOUNT_ID"

# =============================================================================
# Step 1: Copy S3 Buckets
# =============================================================================

echo ""
echo "=== Step 1: Copy S3 bucket contents ==="

# Uploads bucket (most important — has user files referenced by DB)
OLD_UPLOADS="${OLD_PREFIX}-uploads-${ACCOUNT_ID}"
NEW_UPLOADS="${NEW_PREFIX}-uploads-${ACCOUNT_ID}"

if aws s3api head-bucket --bucket "$OLD_UPLOADS" --region "$REGION" 2>/dev/null; then
  echo "Copying uploads: s3://$OLD_UPLOADS -> s3://$NEW_UPLOADS"
  aws s3 sync "s3://$OLD_UPLOADS" "s3://$NEW_UPLOADS" --region "$REGION"
  echo "Uploads copy complete."
else
  echo "Old uploads bucket ($OLD_UPLOADS) not found, skipping."
fi

# Frontend bucket
OLD_FRONTEND="${OLD_PREFIX}-frontend"
NEW_FRONTEND="${NEW_PREFIX}-frontend"

if aws s3api head-bucket --bucket "$OLD_FRONTEND" --region "$REGION" 2>/dev/null; then
  echo "Copying frontend: s3://$OLD_FRONTEND -> s3://$NEW_FRONTEND"
  aws s3 sync "s3://$OLD_FRONTEND" "s3://$NEW_FRONTEND" --region "$REGION"
  echo "Frontend copy complete."
else
  echo "Old frontend bucket ($OLD_FRONTEND) not found, skipping."
fi

# Logs bucket (optional — old logs, not critical)
OLD_LOGS="${OLD_PREFIX}-logs-${ACCOUNT_ID}"
NEW_LOGS="${NEW_PREFIX}-logs-${ACCOUNT_ID}"

if aws s3api head-bucket --bucket "$OLD_LOGS" --region "$REGION" 2>/dev/null; then
  read -p "Copy logs bucket? This may be large and is not critical. (y/N) " COPY_LOGS
  if [ "$COPY_LOGS" = "y" ]; then
    echo "Copying logs: s3://$OLD_LOGS -> s3://$NEW_LOGS"
    aws s3 sync "s3://$OLD_LOGS" "s3://$NEW_LOGS" --region "$REGION"
    echo "Logs copy complete."
  else
    echo "Skipping logs bucket."
  fi
else
  echo "Old logs bucket ($OLD_LOGS) not found, skipping."
fi

# =============================================================================
# Step 2: Migrate RDS Database
# =============================================================================

echo ""
echo "=== Step 2: Migrate RDS database ==="

# Get old RDS endpoint
OLD_RDS_HOST=$(aws rds describe-db-instances \
  --db-instance-identifier "${OLD_PREFIX}-postgres" \
  --region "$REGION" \
  --query "DBInstances[0].Endpoint.Address" --output text 2>/dev/null || echo "")

if [ -z "$OLD_RDS_HOST" ] || [ "$OLD_RDS_HOST" = "None" ]; then
  echo "Old RDS instance (${OLD_PREFIX}-postgres) not found, skipping database migration."
  echo ""
  echo "=== Migration complete (S3 only) ==="
  exit 0
fi

# Get new RDS endpoint
NEW_RDS_HOST=$(aws rds describe-db-instances \
  --db-instance-identifier "${NEW_PREFIX}-postgres" \
  --region "$REGION" \
  --query "DBInstances[0].Endpoint.Address" --output text 2>/dev/null || echo "")

if [ -z "$NEW_RDS_HOST" ] || [ "$NEW_RDS_HOST" = "None" ]; then
  echo "ERROR: New RDS instance (${NEW_PREFIX}-postgres) not found."
  echo "Make sure Terraform has been applied first."
  exit 1
fi

echo "Old RDS: $OLD_RDS_HOST"
echo "New RDS: $NEW_RDS_HOST"

# Get old database credentials from Secrets Manager
# Secret naming: ${prefix}/database (e.g. cliniaacian-prod/database)
OLD_DB_CREDS=""
for SECRET_NAME in "${OLD_PREFIX}/database" "${OLD_PREFIX}-db-credentials" "${OLD_PREFIX}-database"; do
  OLD_DB_CREDS=$(aws secretsmanager get-secret-value \
    --secret-id "$SECRET_NAME" \
    --region "$REGION" \
    --query "SecretString" --output text 2>/dev/null || echo "")
  if [ -n "$OLD_DB_CREDS" ]; then
    echo "Found old credentials under: $SECRET_NAME"
    break
  fi
done

if [ -z "$OLD_DB_CREDS" ]; then
  echo "ERROR: Could not retrieve old database credentials from Secrets Manager."
  echo "Tried: ${OLD_PREFIX}/database, ${OLD_PREFIX}-db-credentials, ${OLD_PREFIX}-database"
  exit 1
fi

OLD_DB_USER=$(echo "$OLD_DB_CREDS" | python3 -c "import sys,json; print(json.load(sys.stdin).get('DB_USER',''))" 2>/dev/null || echo "")
OLD_DB_PASSWORD=$(echo "$OLD_DB_CREDS" | python3 -c "import sys,json; print(json.load(sys.stdin).get('DB_PASSWORD',''))" 2>/dev/null || echo "")
OLD_DB_NAME=$(echo "$OLD_DB_CREDS" | python3 -c "import sys,json; print(json.load(sys.stdin).get('DB_NAME','cliniaacian'))" 2>/dev/null || echo "cliniaacian")

# Get new database credentials from Secrets Manager
NEW_DB_CREDS=""
for SECRET_NAME in "${NEW_PREFIX}/database" "${NEW_PREFIX}-db-credentials" "${NEW_PREFIX}-database"; do
  NEW_DB_CREDS=$(aws secretsmanager get-secret-value \
    --secret-id "$SECRET_NAME" \
    --region "$REGION" \
    --query "SecretString" --output text 2>/dev/null || echo "")
  if [ -n "$NEW_DB_CREDS" ]; then
    echo "Found new credentials under: $SECRET_NAME"
    break
  fi
done

if [ -z "$NEW_DB_CREDS" ]; then
  echo "ERROR: Could not retrieve new database credentials from Secrets Manager."
  echo "Tried: ${NEW_PREFIX}/database, ${NEW_PREFIX}-db-credentials, ${NEW_PREFIX}-database"
  exit 1
fi

NEW_DB_USER=$(echo "$NEW_DB_CREDS" | python3 -c "import sys,json; print(json.load(sys.stdin).get('DB_USER',''))" 2>/dev/null || echo "")
NEW_DB_PASSWORD=$(echo "$NEW_DB_CREDS" | python3 -c "import sys,json; print(json.load(sys.stdin).get('DB_PASSWORD',''))" 2>/dev/null || echo "")
NEW_DB_NAME=$(echo "$NEW_DB_CREDS" | python3 -c "import sys,json; print(json.load(sys.stdin).get('DB_NAME','aivota'))" 2>/dev/null || echo "aivota")

echo ""
echo "Old database: $OLD_DB_NAME (will be on localhost:$OLD_LOCAL_PORT via SSM tunnel)"
echo "New database: $NEW_DB_NAME (will be on localhost:$NEW_LOCAL_PORT via SSM tunnel)"
echo ""
read -p "Proceed with database migration? (y/N) " CONFIRM
if [ "$CONFIRM" != "y" ]; then
  echo "Aborted."
  exit 0
fi

# =============================================================================
# Open SSM tunnels to both databases
# =============================================================================

echo ""
echo "=== Opening SSM tunnels ==="

echo "Opening tunnel to OLD database on localhost:$OLD_LOCAL_PORT..."
aws ssm start-session \
  --target "$EC2_INSTANCE" \
  --document-name AWS-StartPortForwardingSessionToRemoteHost \
  --parameters "host=$OLD_RDS_HOST,portNumber=5432,localPortNumber=$OLD_LOCAL_PORT" \
  --region "$REGION" &>/dev/null &
TUNNEL_PIDS+=($!)

echo "Opening tunnel to NEW database on localhost:$NEW_LOCAL_PORT..."
aws ssm start-session \
  --target "$EC2_INSTANCE" \
  --document-name AWS-StartPortForwardingSessionToRemoteHost \
  --parameters "host=$NEW_RDS_HOST,portNumber=5432,localPortNumber=$NEW_LOCAL_PORT" \
  --region "$REGION" &>/dev/null &
TUNNEL_PIDS+=($!)

echo "Waiting for tunnels to establish..."
sleep 5

# Verify tunnels are running
for pid in "${TUNNEL_PIDS[@]}"; do
  if ! kill -0 "$pid" 2>/dev/null; then
    echo "ERROR: SSM tunnel process died. Check that:"
    echo "  - The EC2 instance $EC2_INSTANCE is running"
    echo "  - SSM Session Manager plugin is installed"
    echo "  - You have IAM permissions for ssm:StartSession"
    exit 1
  fi
done
echo "Tunnels established."

# =============================================================================
# Dump old database and restore to new
# =============================================================================

DUMP_FILE="/tmp/cliniaacian-db-dump-$(date +%Y%m%d-%H%M%S).sql"

echo ""
echo "Dumping old database..."

if [ "$USE_DOCKER" = true ]; then
  # Use Docker for pg_dump — connect to host network
  PGPASSWORD="$OLD_DB_PASSWORD" docker run --rm --network host \
    -e PGPASSWORD="$OLD_DB_PASSWORD" \
    postgres:16-alpine \
    pg_dump \
      -h host.docker.internal \
      -p "$OLD_LOCAL_PORT" \
      -U "$OLD_DB_USER" \
      -d "$OLD_DB_NAME" \
      --no-owner \
      --no-privileges \
      --clean \
      --if-exists \
      -F p > "$DUMP_FILE"
else
  PGPASSWORD="$OLD_DB_PASSWORD" pg_dump \
    -h localhost \
    -p "$OLD_LOCAL_PORT" \
    -U "$OLD_DB_USER" \
    -d "$OLD_DB_NAME" \
    --no-owner \
    --no-privileges \
    --clean \
    --if-exists \
    -F p \
    -f "$DUMP_FILE"
fi

DUMP_SIZE=$(du -h "$DUMP_FILE" | cut -f1)
echo "Dump saved to: $DUMP_FILE ($DUMP_SIZE)"

# Update S3 bucket references in the dump if the uploads bucket name changed
if [ "$OLD_UPLOADS" != "$NEW_UPLOADS" ]; then
  echo "Updating S3 bucket references in dump file..."
  sed -i "s|${OLD_UPLOADS}|${NEW_UPLOADS}|g" "$DUMP_FILE"
fi

echo ""
echo "Restoring to new database..."

if [ "$USE_DOCKER" = true ]; then
  docker run --rm --network host \
    -e PGPASSWORD="$NEW_DB_PASSWORD" \
    -v "$DUMP_FILE:/dump.sql:ro" \
    postgres:16-alpine \
    psql \
      -h host.docker.internal \
      -p "$NEW_LOCAL_PORT" \
      -U "$NEW_DB_USER" \
      -d "$NEW_DB_NAME" \
      -f /dump.sql \
      --set ON_ERROR_STOP=off \
      2>&1 | tail -5
else
  PGPASSWORD="$NEW_DB_PASSWORD" psql \
    -h localhost \
    -p "$NEW_LOCAL_PORT" \
    -U "$NEW_DB_USER" \
    -d "$NEW_DB_NAME" \
    -f "$DUMP_FILE" \
    --set ON_ERROR_STOP=off \
    2>&1 | tail -5
fi

echo ""
echo "Database migration complete."
echo "Dump file retained at: $DUMP_FILE"

echo ""
echo "=== Migration complete ==="
echo ""
echo "Next steps:"
echo "  1. Verify the new site works at https://aivota.ai"
echo "  2. Check that uploads/files load correctly"
echo "  3. Once confirmed, run: bash terraform/cleanup-old-resources.sh"
echo "  4. Delete this script: rm terraform/migrate-data.sh"
