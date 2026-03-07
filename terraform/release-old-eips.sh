#!/bin/bash
# =============================================================================
# Release old cliniaacian-prod EIPs to free up quota for new aivota-prod ones.
# Deletes old NAT gateways first, waits, then releases the EIPs.
#
# Usage:
#   bash terraform/release-old-eips.sh
# =============================================================================
set -euo pipefail

REGION="il-central-1"
OLD_PREFIX="cliniaacian-prod"

echo "=== Finding old VPC ==="
OLD_VPC=$(aws ec2 describe-vpcs --region "$REGION" \
  --filters "Name=tag:Name,Values=${OLD_PREFIX}-vpc" \
  --query "Vpcs[0].VpcId" --output text 2>/dev/null || echo "None")

if [ "$OLD_VPC" = "None" ] || [ -z "$OLD_VPC" ]; then
  echo "No VPC found with tag ${OLD_PREFIX}-vpc"
  echo "Looking for EIPs by tag instead..."
else
  echo "Old VPC: $OLD_VPC"

  # Delete NAT gateways in the old VPC
  echo ""
  echo "=== Deleting old NAT gateways ==="
  NATS=$(aws ec2 describe-nat-gateways --region "$REGION" \
    --filter "Name=vpc-id,Values=$OLD_VPC" "Name=state,Values=available,pending" \
    --query "NatGateways[*].NatGatewayId" --output text 2>/dev/null || echo "")

  if [ -z "$NATS" ] || [ "$NATS" = "None" ]; then
    echo "No active NAT gateways found in old VPC."
  else
    for nat in $NATS; do
      echo "  Deleting NAT gateway: $nat"
      aws ec2 delete-nat-gateway --nat-gateway-id "$nat" --region "$REGION" 2>/dev/null || true
    done
    echo "  Waiting 60s for NAT gateways to release their EIPs..."
    sleep 60
  fi
fi

# Release EIPs tagged with old prefix
echo ""
echo "=== Releasing old EIPs ==="
EIPS=$(aws ec2 describe-addresses --region "$REGION" \
  --filters "Name=tag:Name,Values=${OLD_PREFIX}-nat-eip-*" \
  --query "Addresses[*].[AllocationId,PublicIp,AssociationId]" --output text 2>/dev/null || echo "")

if [ -z "$EIPS" ] || [ "$EIPS" = "None" ]; then
  echo "No EIPs found with tag ${OLD_PREFIX}-nat-eip-*"

  # Try finding all unassociated EIPs as fallback
  echo ""
  echo "=== Checking for any unassociated EIPs ==="
  ALL_EIPS=$(aws ec2 describe-addresses --region "$REGION" \
    --query "Addresses[?AssociationId==null || AssociationId==''].[AllocationId,PublicIp,Tags[?Key=='Name'].Value | [0]]" \
    --output text 2>/dev/null || echo "")

  if [ -z "$ALL_EIPS" ] || [ "$ALL_EIPS" = "None" ]; then
    echo "No unassociated EIPs found."
  else
    echo "Unassociated EIPs:"
    echo "$ALL_EIPS"
    echo ""
    read -p "Release all unassociated EIPs listed above? (y/N) " CONFIRM
    if [ "$CONFIRM" = "y" ]; then
      echo "$ALL_EIPS" | while IFS=$'\t' read -r alloc_id ip name; do
        echo "  Releasing EIP $alloc_id ($ip) [$name]..."
        aws ec2 release-address --allocation-id "$alloc_id" --region "$REGION" 2>/dev/null || true
      done
    fi
  fi
else
  echo "$EIPS" | while IFS=$'\t' read -r alloc_id ip assoc_id; do
    if [ -n "$assoc_id" ] && [ "$assoc_id" != "None" ] && [ "$assoc_id" != "" ]; then
      echo "  EIP $alloc_id ($ip) is still associated ($assoc_id) — waiting for NAT gateway deletion..."
      echo "  Try running this script again in a minute."
      continue
    fi
    echo "  Releasing EIP $alloc_id ($ip)..."
    aws ec2 release-address --allocation-id "$alloc_id" --region "$REGION" 2>/dev/null || true
  done
fi

echo ""
echo "=== Done ==="
echo "Re-run the GitHub Actions pipeline to retry infrastructure creation."
