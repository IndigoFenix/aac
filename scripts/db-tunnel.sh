#!/bin/bash
# =============================================================================
# Open an SSM tunnel to the RDS database.
#
# Usage:
#   npm run db-tunnel          # tunnel to new (aivota) database on port 5432
#   npm run db-tunnel:new      # same as above
#   npm run db-tunnel:old      # tunnel to old (cliniaacian) database on port 5432
#   bash scripts/db-tunnel.sh both  # both tunnels: old on 5432, new on 5433
# =============================================================================
set -euo pipefail

REGION="il-central-1"
PROFILE="${AWS_PROFILE:-aac}"
export AWS_PROFILE="$PROFILE"

OLD_RDS_HOST="cliniaacian-prod-postgres.cpea2as2c1xa.il-central-1.rds.amazonaws.com"

# Auto-discover bastion instance by tag
EC2_INSTANCE=$(aws ec2 describe-instances --region "$REGION" \
  --filters "Name=tag:Name,Values=aivota-prod-bastion" "Name=instance-state-name,Values=running" \
  --query "Reservations[0].Instances[0].InstanceId" --output text 2>/dev/null || echo "None")

if [ "$EC2_INSTANCE" = "None" ] || [ -z "$EC2_INSTANCE" ]; then
  echo "ERROR: No running bastion instance found with tag 'aivota-prod-bastion'."
  echo ""
  echo "Make sure Terraform has been applied (the bastion is defined in bastion.tf)."
  echo "Check with: aws ec2 describe-instances --region $REGION --filters Name=tag:Name,Values=aivota-prod-bastion"
  exit 1
fi
echo "Using bastion instance: $EC2_INSTANCE"

# Discover new RDS host
NEW_RDS_HOST=$(aws rds describe-db-instances \
  --db-instance-identifier "aivota-prod-postgres" \
  --region "$REGION" \
  --query "DBInstances[0].Endpoint.Address" --output text 2>/dev/null || echo "")

if [ -z "$NEW_RDS_HOST" ] || [ "$NEW_RDS_HOST" = "None" ]; then
  echo "WARNING: Could not find aivota-prod-postgres RDS instance."
  echo "Falling back to old database."
  NEW_RDS_HOST="$OLD_RDS_HOST"
fi

MODE="${1:-new}"

case "$MODE" in
  old)
    echo "Opening tunnel to OLD database (cliniaacian-prod) on localhost:5432"
    aws ssm start-session \
      --target "$EC2_INSTANCE" \
      --document-name AWS-StartPortForwardingSessionToRemoteHost \
      --parameters "host=$OLD_RDS_HOST,portNumber=5432,localPortNumber=5432" \
      --region "$REGION"
    ;;
  new|"")
    echo "Opening tunnel to NEW database (aivota-prod) on localhost:5432"
    echo "RDS host: $NEW_RDS_HOST"
    aws ssm start-session \
      --target "$EC2_INSTANCE" \
      --document-name AWS-StartPortForwardingSessionToRemoteHost \
      --parameters "host=$NEW_RDS_HOST,portNumber=5432,localPortNumber=5432" \
      --region "$REGION"
    ;;
  both)
    echo "Opening tunnels to BOTH databases:"
    echo "  OLD (cliniaacian-prod) → localhost:5432"
    echo "  NEW (aivota-prod)     → localhost:5433"
    echo ""
    echo "Starting old tunnel in background..."
    aws ssm start-session \
      --target "$EC2_INSTANCE" \
      --document-name AWS-StartPortForwardingSessionToRemoteHost \
      --parameters "host=$OLD_RDS_HOST,portNumber=5432,localPortNumber=5432" \
      --region "$REGION" &
    OLD_PID=$!
    sleep 3
    echo ""
    echo "Starting new tunnel in foreground..."
    echo "(Press Ctrl+C to close both tunnels)"
    trap "kill $OLD_PID 2>/dev/null; exit 0" INT TERM
    aws ssm start-session \
      --target "$EC2_INSTANCE" \
      --document-name AWS-StartPortForwardingSessionToRemoteHost \
      --parameters "host=$NEW_RDS_HOST,portNumber=5432,localPortNumber=5433" \
      --region "$REGION"
    kill $OLD_PID 2>/dev/null || true
    ;;
  *)
    echo "Usage: bash scripts/db-tunnel.sh [old|new|both]"
    exit 1
    ;;
esac
