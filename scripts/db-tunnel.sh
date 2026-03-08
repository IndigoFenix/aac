#!/bin/bash
# =============================================================================
# Open an SSM tunnel to the aivota RDS database.
#
# Usage:
#   npm run db-tunnel
# =============================================================================
set -euo pipefail

REGION="il-central-1"
PROFILE="${AWS_PROFILE:-aac}"
export AWS_PROFILE="$PROFILE"

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

# Discover RDS host
RDS_HOST=$(aws rds describe-db-instances \
  --db-instance-identifier "aivota-prod-postgres" \
  --region "$REGION" \
  --query "DBInstances[0].Endpoint.Address" --output text 2>/dev/null || echo "")

if [ -z "$RDS_HOST" ] || [ "$RDS_HOST" = "None" ]; then
  echo "ERROR: Could not find aivota-prod-postgres RDS instance."
  exit 1
fi

echo "Opening tunnel to aivota database on localhost:5432"
echo "RDS host: $RDS_HOST"
aws ssm start-session \
  --target "$EC2_INSTANCE" \
  --document-name AWS-StartPortForwardingSessionToRemoteHost \
  --parameters "host=$RDS_HOST,portNumber=5432,localPortNumber=5432" \
  --region "$REGION"
