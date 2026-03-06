#!/bin/bash
# =============================================================================
# Clean up duplicate AWS resources from failed Terraform applies.
# Run locally with AWS CLI. Review output before confirming.
# =============================================================================
set -euo pipefail
REGION="il-central-1"
PREFIX="cliniaacian-prod"

echo "=== Finding original VPC (the one with RDS) ==="
ORIGINAL_VPC=$(aws rds describe-db-instances \
  --db-instance-identifier "${PREFIX}-postgres" \
  --region "$REGION" \
  --query "DBInstances[0].DBSubnetGroup.VpcId" --output text 2>/dev/null || echo "")

if [ -z "$ORIGINAL_VPC" ] || [ "$ORIGINAL_VPC" = "None" ]; then
  echo "ERROR: Could not find original VPC via RDS. Aborting."
  exit 1
fi
echo "Original VPC (keep): $ORIGINAL_VPC"

echo ""
echo "=== Finding duplicate VPCs ==="
ALL_VPCS=$(aws ec2 describe-vpcs --region "$REGION" \
  --filters "Name=tag:Name,Values=${PREFIX}-vpc" \
  --query "Vpcs[*].VpcId" --output text 2>/dev/null || echo "")

DUPLICATE_VPCS=""
for vpc in $ALL_VPCS; do
  if [ "$vpc" != "$ORIGINAL_VPC" ]; then
    DUPLICATE_VPCS="$DUPLICATE_VPCS $vpc"
  fi
done

if [ -z "$DUPLICATE_VPCS" ]; then
  echo "No duplicate VPCs found."
else
  echo "Duplicate VPCs to delete:$DUPLICATE_VPCS"
fi

echo ""
echo "=== Finding duplicate security groups (not in original VPC) ==="
ALL_SG=$(aws ec2 describe-security-groups --region "$REGION" \
  --filters "Name=tag:Project,Values=CliniAACian" \
  --query "SecurityGroups[?VpcId!='${ORIGINAL_VPC}'].[GroupId,GroupName,VpcId]" \
  --output text 2>/dev/null || echo "")
echo "Duplicate security groups:"
echo "$ALL_SG"

echo ""
echo "=== Finding duplicate API Gateways ==="
aws apigatewayv2 get-apis --region "$REGION" \
  --query "Items[?Name=='${PREFIX}-api'].[ApiId,Name,CreatedDate]" \
  --output table 2>/dev/null || true

echo ""
read -p "Proceed with cleanup? (y/N) " CONFIRM
if [ "$CONFIRM" != "y" ]; then
  echo "Aborted."
  exit 0
fi

# Delete duplicate VPCs and all their contents
for vpc in $DUPLICATE_VPCS; do
  echo ""
  echo "=== Deleting VPC $vpc and all contents ==="

  # Delete NAT gateways
  NATS=$(aws ec2 describe-nat-gateways --region "$REGION" \
    --filter "Name=vpc-id,Values=$vpc" "Name=state,Values=available,pending" \
    --query "NatGateways[*].NatGatewayId" --output text 2>/dev/null || echo "")
  for nat in $NATS; do
    echo "  Deleting NAT gateway $nat..."
    aws ec2 delete-nat-gateway --nat-gateway-id "$nat" --region "$REGION" 2>/dev/null || true
  done

  if [ -n "$NATS" ]; then
    echo "  Waiting for NAT gateways to delete..."
    sleep 60
  fi

  # Release EIPs that were associated with this VPC's NAT gateways
  EIPS=$(aws ec2 describe-addresses --region "$REGION" \
    --filters "Name=tag:Name,Values=${PREFIX}-nat-eip-*" \
    --query "Addresses[?Domain=='vpc' && (AssociationId==null || AssociationId=='')].[AllocationId]" \
    --output text 2>/dev/null || echo "")
  for eip in $EIPS; do
    echo "  Releasing EIP $eip..."
    aws ec2 release-address --allocation-id "$eip" --region "$REGION" 2>/dev/null || true
  done

  # Delete VPC endpoints
  ENDPOINTS=$(aws ec2 describe-vpc-endpoints --region "$REGION" \
    --filters "Name=vpc-id,Values=$vpc" \
    --query "VpcEndpoints[*].VpcEndpointId" --output text 2>/dev/null || echo "")
  if [ -n "$ENDPOINTS" ]; then
    echo "  Deleting VPC endpoints: $ENDPOINTS"
    aws ec2 delete-vpc-endpoints --vpc-endpoint-ids $ENDPOINTS --region "$REGION" 2>/dev/null || true
    sleep 10
  fi

  # Delete load balancers
  ALBS=$(aws elbv2 describe-load-balancers --region "$REGION" \
    --query "LoadBalancers[?VpcId=='$vpc'].LoadBalancerArn" --output text 2>/dev/null || echo "")
  for alb in $ALBS; do
    echo "  Deleting ALB $alb..."
    aws elbv2 delete-load-balancer --load-balancer-arn "$alb" --region "$REGION" 2>/dev/null || true
  done

  # Disassociate and delete route tables (non-main)
  RTS=$(aws ec2 describe-route-tables --region "$REGION" \
    --filters "Name=vpc-id,Values=$vpc" \
    --query "RouteTables[?Associations[?Main!=\`true\`]].RouteTableId" --output text 2>/dev/null || echo "")
  for rt in $RTS; do
    ASSOCS=$(aws ec2 describe-route-tables --region "$REGION" \
      --route-table-ids "$rt" \
      --query "RouteTables[0].Associations[?!Main].RouteTableAssociationId" --output text 2>/dev/null || echo "")
    for assoc in $ASSOCS; do
      aws ec2 disassociate-route-table --association-id "$assoc" --region "$REGION" 2>/dev/null || true
    done
    echo "  Deleting route table $rt..."
    aws ec2 delete-route-table --route-table-id "$rt" --region "$REGION" 2>/dev/null || true
  done

  # Delete security groups (non-default)
  SGS=$(aws ec2 describe-security-groups --region "$REGION" \
    --filters "Name=vpc-id,Values=$vpc" \
    --query "SecurityGroups[?GroupName!='default'].GroupId" --output text 2>/dev/null || echo "")
  for sg in $SGS; do
    echo "  Deleting security group $sg..."
    aws ec2 delete-security-group --group-id "$sg" --region "$REGION" 2>/dev/null || true
  done

  # Delete subnets
  SUBNETS=$(aws ec2 describe-subnets --region "$REGION" \
    --filters "Name=vpc-id,Values=$vpc" \
    --query "Subnets[*].SubnetId" --output text 2>/dev/null || echo "")
  for subnet in $SUBNETS; do
    echo "  Deleting subnet $subnet..."
    aws ec2 delete-subnet --subnet-id "$subnet" --region "$REGION" 2>/dev/null || true
  done

  # Detach and delete internet gateway
  IGWS=$(aws ec2 describe-internet-gateways --region "$REGION" \
    --filters "Name=attachment.vpc-id,Values=$vpc" \
    --query "InternetGateways[*].InternetGatewayId" --output text 2>/dev/null || echo "")
  for igw in $IGWS; do
    echo "  Detaching and deleting IGW $igw..."
    aws ec2 detach-internet-gateway --internet-gateway-id "$igw" --vpc-id "$vpc" --region "$REGION" 2>/dev/null || true
    aws ec2 delete-internet-gateway --internet-gateway-id "$igw" --region "$REGION" 2>/dev/null || true
  done

  # Delete the VPC itself
  echo "  Deleting VPC $vpc..."
  aws ec2 delete-vpc --vpc-id "$vpc" --region "$REGION" 2>/dev/null || true
done

# Delete duplicate API Gateways (keep the oldest one)
echo ""
echo "=== Cleaning up duplicate API Gateways ==="
APIGW_IDS=$(aws apigatewayv2 get-apis --region "$REGION" \
  --query "Items[?Name=='${PREFIX}-api'] | sort_by(@, &CreatedDate)[1:].[ApiId]" \
  --output text 2>/dev/null || echo "")
for apigw in $APIGW_IDS; do
  echo "  Deleting duplicate API Gateway $apigw..."
  aws apigatewayv2 delete-api --api-id "$apigw" --region "$REGION" 2>/dev/null || true
done

# Delete the typo state bucket
echo ""
echo "=== Deleting typo state bucket ==="
aws s3 rb "s3://cliniaccian-prod-terraform-state" --force --region "$REGION" 2>/dev/null && echo "  Deleted cliniaccian-prod-terraform-state" || echo "  Bucket not found or already deleted"

# Clean up stale DynamoDB entries for the typo bucket
echo ""
echo "=== Cleaning up DynamoDB lock entries ==="
aws dynamodb delete-item \
  --table-name terraform-state-lock \
  --key '{"LockID":{"S":"cliniaccian-prod-terraform-state/cliniaacian/prod/terraform.tfstate-md5"}}' \
  --region "$REGION" 2>/dev/null || true
aws dynamodb delete-item \
  --table-name terraform-state-lock \
  --key '{"LockID":{"S":"cliniaccian-prod-terraform-state/cliniaacian/prod/terraform.tfstate"}}' \
  --region "$REGION" 2>/dev/null || true

echo ""
echo "=== Cleanup complete ==="
echo "You can now push to trigger the CI pipeline."
echo "Delete this script after cleanup: rm terraform/cleanup-duplicates.sh"
