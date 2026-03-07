#!/bin/bash
# =============================================================================
# Migrate data from old cliniaacian-prod resources to new aivota-prod resources.
#
# Prerequisites:
#   - AWS CLI configured with appropriate permissions
#   - Both old and new RDS instances must be running
#   - psql and pg_dump must be installed locally
#   - New infrastructure must already be created (run Terraform first)
#
# Usage:
#   bash terraform/migrate-data.sh
# =============================================================================
set -euo pipefail

REGION="il-central-1"
OLD_PREFIX="cliniaacian-prod"
NEW_PREFIX="aivota-prod"

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
OLD_RDS_ENDPOINT=$(aws rds describe-db-instances \
  --db-instance-identifier "${OLD_PREFIX}-postgres" \
  --region "$REGION" \
  --query "DBInstances[0].Endpoint.Address" --output text 2>/dev/null || echo "")

if [ -z "$OLD_RDS_ENDPOINT" ] || [ "$OLD_RDS_ENDPOINT" = "None" ]; then
  echo "Old RDS instance (${OLD_PREFIX}-postgres) not found, skipping database migration."
  echo ""
  echo "=== Migration complete (S3 only) ==="
  exit 0
fi

# Get new RDS endpoint
NEW_RDS_ENDPOINT=$(aws rds describe-db-instances \
  --db-instance-identifier "${NEW_PREFIX}-postgres" \
  --region "$REGION" \
  --query "DBInstances[0].Endpoint.Address" --output text 2>/dev/null || echo "")

if [ -z "$NEW_RDS_ENDPOINT" ] || [ "$NEW_RDS_ENDPOINT" = "None" ]; then
  echo "ERROR: New RDS instance (${NEW_PREFIX}-postgres) not found."
  echo "Make sure Terraform has been applied first."
  exit 1
fi

echo "Old RDS: $OLD_RDS_ENDPOINT"
echo "New RDS: $NEW_RDS_ENDPOINT"

# Get old database credentials from Secrets Manager
OLD_SECRET_NAME="${OLD_PREFIX}-db-credentials"
OLD_DB_CREDS=$(aws secretsmanager get-secret-value \
  --secret-id "$OLD_SECRET_NAME" \
  --region "$REGION" \
  --query "SecretString" --output text 2>/dev/null || echo "")

if [ -z "$OLD_DB_CREDS" ]; then
  echo "ERROR: Could not retrieve old database credentials from Secrets Manager."
  echo "Secret name: $OLD_SECRET_NAME"
  echo ""
  echo "You can manually provide credentials by setting these environment variables:"
  echo "  OLD_DB_USER, OLD_DB_PASSWORD, OLD_DB_NAME"
  exit 1
fi

OLD_DB_USER=$(echo "$OLD_DB_CREDS" | python3 -c "import sys,json; print(json.load(sys.stdin).get('DB_USER',''))" 2>/dev/null || echo "")
OLD_DB_PASSWORD=$(echo "$OLD_DB_CREDS" | python3 -c "import sys,json; print(json.load(sys.stdin).get('DB_PASSWORD',''))" 2>/dev/null || echo "")
OLD_DB_NAME=$(echo "$OLD_DB_CREDS" | python3 -c "import sys,json; print(json.load(sys.stdin).get('DB_NAME','cliniaacian'))" 2>/dev/null || echo "cliniaacian")

# Get new database credentials from Secrets Manager
NEW_SECRET_NAME="${NEW_PREFIX}-db-credentials"
NEW_DB_CREDS=$(aws secretsmanager get-secret-value \
  --secret-id "$NEW_SECRET_NAME" \
  --region "$REGION" \
  --query "SecretString" --output text 2>/dev/null || echo "")

if [ -z "$NEW_DB_CREDS" ]; then
  echo "ERROR: Could not retrieve new database credentials from Secrets Manager."
  echo "Secret name: $NEW_SECRET_NAME"
  exit 1
fi

NEW_DB_USER=$(echo "$NEW_DB_CREDS" | python3 -c "import sys,json; print(json.load(sys.stdin).get('DB_USER',''))" 2>/dev/null || echo "")
NEW_DB_PASSWORD=$(echo "$NEW_DB_CREDS" | python3 -c "import sys,json; print(json.load(sys.stdin).get('DB_PASSWORD',''))" 2>/dev/null || echo "")
NEW_DB_NAME=$(echo "$NEW_DB_CREDS" | python3 -c "import sys,json; print(json.load(sys.stdin).get('DB_NAME','aivota'))" 2>/dev/null || echo "aivota")

echo ""
echo "Old database: $OLD_DB_NAME on $OLD_RDS_ENDPOINT"
echo "New database: $NEW_DB_NAME on $NEW_RDS_ENDPOINT"
echo ""
echo "NOTE: Both RDS instances must be accessible from this machine."
echo "If they are in private subnets, you may need to:"
echo "  - Use an SSH tunnel / bastion host"
echo "  - Temporarily make them publicly accessible"
echo "  - Run this script from an EC2 instance in the same VPC"
echo ""
read -p "Proceed with database migration? (y/N) " CONFIRM
if [ "$CONFIRM" != "y" ]; then
  echo "Aborted."
  exit 0
fi

DUMP_FILE="/tmp/cliniaacian-db-dump-$(date +%Y%m%d-%H%M%S).sql"

echo ""
echo "Dumping old database..."
PGPASSWORD="$OLD_DB_PASSWORD" pg_dump \
  -h "$OLD_RDS_ENDPOINT" \
  -U "$OLD_DB_USER" \
  -d "$OLD_DB_NAME" \
  --no-owner \
  --no-privileges \
  --clean \
  --if-exists \
  -F p \
  -f "$DUMP_FILE"

echo "Dump saved to: $DUMP_FILE ($(du -h "$DUMP_FILE" | cut -f1))"

# Update S3 bucket references in the dump if the uploads bucket name changed
if [ "$OLD_UPLOADS" != "$NEW_UPLOADS" ]; then
  echo "Updating S3 bucket references in dump file..."
  sed -i "s|${OLD_UPLOADS}|${NEW_UPLOADS}|g" "$DUMP_FILE"
fi

echo "Restoring to new database..."
PGPASSWORD="$NEW_DB_PASSWORD" psql \
  -h "$NEW_RDS_ENDPOINT" \
  -U "$NEW_DB_USER" \
  -d "$NEW_DB_NAME" \
  -f "$DUMP_FILE" \
  --set ON_ERROR_STOP=off \
  2>&1 | tail -5

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
