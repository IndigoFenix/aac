#!/bin/bash
# =============================================================================
# Delete all old cliniaacian-prod AWS resources after migration is verified.
#
# Run this ONLY after:
#   1. migrate-data.sh has been run successfully
#   2. The new aivota-prod infrastructure is working
#   3. You have verified uploads and data are intact
#
# Usage:
#   bash terraform/cleanup-old-resources.sh
# =============================================================================
set -euo pipefail

REGION="il-central-1"
OLD_PREFIX="cliniaacian-prod"
ACCOUNT_ID=$(aws sts get-caller-identity --query "Account" --output text)

echo "=== Cleanup old cliniaacian-prod resources ==="
echo "AWS Account: $ACCOUNT_ID"
echo "Region: $REGION"
echo ""

# =============================================================================
# Discover resources
# =============================================================================

echo "--- Discovering resources to delete ---"
echo ""

# VPC
OLD_VPC=$(aws ec2 describe-vpcs --region "$REGION" \
  --filters "Name=tag:Name,Values=${OLD_PREFIX}-vpc" \
  --query "Vpcs[0].VpcId" --output text 2>/dev/null || echo "None")
echo "VPC: $OLD_VPC"

# RDS
OLD_RDS=$(aws rds describe-db-instances \
  --db-instance-identifier "${OLD_PREFIX}-postgres" \
  --region "$REGION" \
  --query "DBInstances[0].DBInstanceIdentifier" --output text 2>/dev/null || echo "None")
echo "RDS: $OLD_RDS"

# Lambda
OLD_LAMBDA=$(aws lambda get-function \
  --function-name "${OLD_PREFIX}-api" \
  --region "$REGION" \
  --query "Configuration.FunctionName" --output text 2>/dev/null || echo "None")
echo "Lambda: $OLD_LAMBDA"

# API Gateway
OLD_APIGW=$(aws apigatewayv2 get-apis --region "$REGION" \
  --query "Items[?Name=='${OLD_PREFIX}-api'].ApiId | [0]" --output text 2>/dev/null || echo "None")
echo "API Gateway: $OLD_APIGW"

# CloudFront
OLD_CF=$(aws cloudfront list-distributions \
  --query "DistributionList.Items[?contains(Aliases.Items || [''], 'cliniaacian.com')].Id | [0]" \
  --output text 2>/dev/null || echo "None")
echo "CloudFront: $OLD_CF"

# S3 Buckets
OLD_UPLOADS="${OLD_PREFIX}-uploads-${ACCOUNT_ID}"
OLD_LOGS="${OLD_PREFIX}-logs-${ACCOUNT_ID}"
OLD_FRONTEND="${OLD_PREFIX}-frontend"
OLD_STATE="cliniaacian-prod-terraform-state"
TYPO_STATE="cliniaccian-prod-terraform-state"

echo "S3 Uploads: $OLD_UPLOADS"
echo "S3 Logs: $OLD_LOGS"
echo "S3 Frontend: $OLD_FRONTEND"
echo "S3 State: $OLD_STATE"
echo "S3 Typo State: $TYPO_STATE"

# ECR
OLD_ECR_MAIN=$(aws ecr describe-repositories --repository-names "cliniaacian" \
  --region "$REGION" --query "repositories[0].repositoryName" --output text 2>/dev/null || echo "None")
OLD_ECR_LAMBDA=$(aws ecr describe-repositories --repository-names "cliniaacian-lambda" \
  --region "$REGION" --query "repositories[0].repositoryName" --output text 2>/dev/null || echo "None")
echo "ECR Main: $OLD_ECR_MAIN"
echo "ECR Lambda: $OLD_ECR_LAMBDA"

# Secrets Manager
OLD_SECRET_DB=$(aws secretsmanager describe-secret --secret-id "${OLD_PREFIX}-db-credentials" \
  --region "$REGION" --query "Name" --output text 2>/dev/null || echo "None")
OLD_SECRET_APP=$(aws secretsmanager describe-secret --secret-id "${OLD_PREFIX}-app-secrets" \
  --region "$REGION" --query "Name" --output text 2>/dev/null || echo "None")
echo "Secret DB: $OLD_SECRET_DB"
echo "Secret App: $OLD_SECRET_APP"

# KMS
OLD_KMS=$(aws kms list-aliases --region "$REGION" \
  --query "Aliases[?AliasName=='alias/${OLD_PREFIX}-key'].TargetKeyId | [0]" --output text 2>/dev/null || echo "None")
echo "KMS Key: $OLD_KMS"

echo ""
echo "========================================="
echo "WARNING: This will permanently delete ALL of the above resources."
echo "Make sure the new aivota-prod infrastructure is working first!"
echo "========================================="
echo ""
read -p "Type 'DELETE' to proceed: " CONFIRM
if [ "$CONFIRM" != "DELETE" ]; then
  echo "Aborted."
  exit 0
fi

# =============================================================================
# Delete CloudFront (must be disabled first)
# =============================================================================
if [ "$OLD_CF" != "None" ] && [ -n "$OLD_CF" ]; then
  echo ""
  echo "=== Disabling and deleting CloudFront distribution $OLD_CF ==="
  ETAG=$(aws cloudfront get-distribution-config --id "$OLD_CF" \
    --query "ETag" --output text 2>/dev/null || echo "")
  if [ -n "$ETAG" ]; then
    # Get config, disable it, update
    aws cloudfront get-distribution-config --id "$OLD_CF" --output json > /tmp/cf-config.json
    python3 -c "
import json
with open('/tmp/cf-config.json') as f: data = json.load(f)
config = data['DistributionConfig']
config['Enabled'] = False
with open('/tmp/cf-update.json', 'w') as f: json.dump(config, f)
"
    aws cloudfront update-distribution --id "$OLD_CF" \
      --distribution-config file:///tmp/cf-update.json \
      --if-match "$ETAG" > /dev/null 2>&1 || true
    echo "  Distribution disabled. It may take 10-15 minutes before it can be deleted."
    echo "  You can delete it later with:"
    echo "    ETAG=\$(aws cloudfront get-distribution --id $OLD_CF --query ETag --output text)"
    echo "    aws cloudfront delete-distribution --id $OLD_CF --if-match \$ETAG"
  fi
fi

# =============================================================================
# Delete API Gateway
# =============================================================================
if [ "$OLD_APIGW" != "None" ] && [ -n "$OLD_APIGW" ]; then
  echo ""
  echo "=== Deleting API Gateway $OLD_APIGW ==="
  aws apigatewayv2 delete-api --api-id "$OLD_APIGW" --region "$REGION" 2>/dev/null || true
fi

# =============================================================================
# Delete Lambda
# =============================================================================
if [ "$OLD_LAMBDA" != "None" ] && [ -n "$OLD_LAMBDA" ]; then
  echo ""
  echo "=== Deleting Lambda function $OLD_LAMBDA ==="
  # Delete function URL first
  aws lambda delete-function-url-config --function-name "$OLD_LAMBDA" --region "$REGION" 2>/dev/null || true
  aws lambda delete-function --function-name "$OLD_LAMBDA" --region "$REGION" 2>/dev/null || true
fi

# =============================================================================
# Delete RDS (disable deletion protection first)
# =============================================================================
if [ "$OLD_RDS" != "None" ] && [ -n "$OLD_RDS" ]; then
  echo ""
  echo "=== Deleting RDS instance $OLD_RDS ==="
  aws rds modify-db-instance \
    --db-instance-identifier "$OLD_RDS" \
    --no-deletion-protection \
    --apply-immediately \
    --region "$REGION" 2>/dev/null || true
  echo "  Waiting for deletion protection to be disabled..."
  sleep 15
  aws rds delete-db-instance \
    --db-instance-identifier "$OLD_RDS" \
    --skip-final-snapshot \
    --region "$REGION" 2>/dev/null || true
  echo "  RDS deletion initiated (takes several minutes)."
fi

# =============================================================================
# Delete ECR repositories
# =============================================================================
if [ "$OLD_ECR_MAIN" != "None" ] && [ -n "$OLD_ECR_MAIN" ]; then
  echo ""
  echo "=== Deleting ECR repository $OLD_ECR_MAIN ==="
  aws ecr delete-repository --repository-name "$OLD_ECR_MAIN" --force --region "$REGION" 2>/dev/null || true
fi
if [ "$OLD_ECR_LAMBDA" != "None" ] && [ -n "$OLD_ECR_LAMBDA" ]; then
  echo ""
  echo "=== Deleting ECR repository $OLD_ECR_LAMBDA ==="
  aws ecr delete-repository --repository-name "$OLD_ECR_LAMBDA" --force --region "$REGION" 2>/dev/null || true
fi

# =============================================================================
# Delete S3 Buckets (empty first)
# =============================================================================
for BUCKET in "$OLD_UPLOADS" "$OLD_LOGS" "$OLD_FRONTEND" "$OLD_STATE" "$TYPO_STATE"; do
  if aws s3api head-bucket --bucket "$BUCKET" --region "$REGION" 2>/dev/null; then
    echo ""
    echo "=== Deleting S3 bucket $BUCKET ==="
    # Remove all objects (including versions)
    aws s3api list-object-versions --bucket "$BUCKET" --region "$REGION" \
      --query '{Objects: Versions[].{Key:Key,VersionId:VersionId}}' --output json 2>/dev/null | \
      python3 -c "
import sys, json
data = json.load(sys.stdin)
objects = data.get('Objects') or []
if objects:
    # Batch delete in groups of 1000
    for i in range(0, len(objects), 1000):
        batch = objects[i:i+1000]
        print(json.dumps({'Objects': batch, 'Quiet': True}))
" | while read -r batch; do
      aws s3api delete-objects --bucket "$BUCKET" --delete "$batch" --region "$REGION" > /dev/null 2>&1 || true
    done

    # Delete markers too
    aws s3api list-object-versions --bucket "$BUCKET" --region "$REGION" \
      --query '{Objects: DeleteMarkers[].{Key:Key,VersionId:VersionId}}' --output json 2>/dev/null | \
      python3 -c "
import sys, json
data = json.load(sys.stdin)
objects = data.get('Objects') or []
if objects:
    for i in range(0, len(objects), 1000):
        batch = objects[i:i+1000]
        print(json.dumps({'Objects': batch, 'Quiet': True}))
" | while read -r batch; do
      aws s3api delete-objects --bucket "$BUCKET" --delete "$batch" --region "$REGION" > /dev/null 2>&1 || true
    done

    aws s3 rb "s3://$BUCKET" --region "$REGION" 2>/dev/null && echo "  Deleted." || echo "  Could not delete (may need to retry after versions are cleared)."
  fi
done

# =============================================================================
# Delete Secrets Manager secrets
# =============================================================================
for SECRET in "$OLD_SECRET_DB" "$OLD_SECRET_APP"; do
  if [ "$SECRET" != "None" ] && [ -n "$SECRET" ]; then
    echo ""
    echo "=== Deleting secret $SECRET ==="
    aws secretsmanager delete-secret --secret-id "$SECRET" \
      --force-delete-without-recovery --region "$REGION" 2>/dev/null || true
  fi
done

# =============================================================================
# Schedule KMS key for deletion (minimum 7 days)
# =============================================================================
if [ "$OLD_KMS" != "None" ] && [ -n "$OLD_KMS" ]; then
  echo ""
  echo "=== Scheduling KMS key $OLD_KMS for deletion (7 days) ==="
  aws kms schedule-key-deletion --key-id "$OLD_KMS" \
    --pending-window-in-days 7 --region "$REGION" 2>/dev/null || true
fi

# =============================================================================
# Delete VPC and all contents
# =============================================================================
if [ "$OLD_VPC" != "None" ] && [ -n "$OLD_VPC" ]; then
  echo ""
  echo "=== Deleting VPC $OLD_VPC and all contents ==="

  # NAT gateways
  NATS=$(aws ec2 describe-nat-gateways --region "$REGION" \
    --filter "Name=vpc-id,Values=$OLD_VPC" "Name=state,Values=available,pending" \
    --query "NatGateways[*].NatGatewayId" --output text 2>/dev/null || echo "")
  for nat in $NATS; do
    echo "  Deleting NAT gateway $nat..."
    aws ec2 delete-nat-gateway --nat-gateway-id "$nat" --region "$REGION" 2>/dev/null || true
  done
  if [ -n "$NATS" ] && [ "$NATS" != "None" ]; then
    echo "  Waiting for NAT gateways to delete..."
    sleep 60
  fi

  # Release EIPs
  EIPS=$(aws ec2 describe-addresses --region "$REGION" \
    --filters "Name=tag:Name,Values=${OLD_PREFIX}-nat-eip-*" \
    --query "Addresses[*].AllocationId" --output text 2>/dev/null || echo "")
  for eip in $EIPS; do
    echo "  Releasing EIP $eip..."
    aws ec2 release-address --allocation-id "$eip" --region "$REGION" 2>/dev/null || true
  done

  # VPC endpoints
  ENDPOINTS=$(aws ec2 describe-vpc-endpoints --region "$REGION" \
    --filters "Name=vpc-id,Values=$OLD_VPC" \
    --query "VpcEndpoints[*].VpcEndpointId" --output text 2>/dev/null || echo "")
  if [ -n "$ENDPOINTS" ] && [ "$ENDPOINTS" != "None" ]; then
    echo "  Deleting VPC endpoints..."
    aws ec2 delete-vpc-endpoints --vpc-endpoint-ids $ENDPOINTS --region "$REGION" 2>/dev/null || true
    sleep 10
  fi

  # Load balancers
  ALBS=$(aws elbv2 describe-load-balancers --region "$REGION" \
    --query "LoadBalancers[?VpcId=='$OLD_VPC'].LoadBalancerArn" --output text 2>/dev/null || echo "")
  for alb in $ALBS; do
    echo "  Deleting ALB $alb..."
    # Delete listeners first
    LISTENERS=$(aws elbv2 describe-listeners --load-balancer-arn "$alb" --region "$REGION" \
      --query "Listeners[*].ListenerArn" --output text 2>/dev/null || echo "")
    for listener in $LISTENERS; do
      aws elbv2 delete-listener --listener-arn "$listener" --region "$REGION" 2>/dev/null || true
    done
    aws elbv2 delete-load-balancer --load-balancer-arn "$alb" --region "$REGION" 2>/dev/null || true
  done

  # Target groups
  TGS=$(aws elbv2 describe-target-groups --region "$REGION" \
    --query "TargetGroups[?VpcId=='$OLD_VPC'].TargetGroupArn" --output text 2>/dev/null || echo "")
  for tg in $TGS; do
    echo "  Deleting target group $tg..."
    aws elbv2 delete-target-group --target-group-arn "$tg" --region "$REGION" 2>/dev/null || true
  done

  # Network interfaces (ENIs)
  ENIS=$(aws ec2 describe-network-interfaces --region "$REGION" \
    --filters "Name=vpc-id,Values=$OLD_VPC" \
    --query "NetworkInterfaces[*].NetworkInterfaceId" --output text 2>/dev/null || echo "")
  for eni in $ENIS; do
    # Detach first
    ATTACH=$(aws ec2 describe-network-interfaces --network-interface-ids "$eni" --region "$REGION" \
      --query "NetworkInterfaces[0].Attachment.AttachmentId" --output text 2>/dev/null || echo "None")
    if [ "$ATTACH" != "None" ] && [ -n "$ATTACH" ]; then
      aws ec2 detach-network-interface --attachment-id "$ATTACH" --force --region "$REGION" 2>/dev/null || true
      sleep 5
    fi
    echo "  Deleting ENI $eni..."
    aws ec2 delete-network-interface --network-interface-id "$eni" --region "$REGION" 2>/dev/null || true
  done

  # Route tables (non-main)
  RTS=$(aws ec2 describe-route-tables --region "$REGION" \
    --filters "Name=vpc-id,Values=$OLD_VPC" \
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

  # Security groups (non-default) — clear all rules first to break circular refs
  SGS=$(aws ec2 describe-security-groups --region "$REGION" \
    --filters "Name=vpc-id,Values=$OLD_VPC" \
    --query "SecurityGroups[?GroupName!='default'].GroupId" --output text 2>/dev/null || echo "")
  for sg in $SGS; do
    # Revoke all ingress/egress rules
    aws ec2 describe-security-groups --group-ids "$sg" --region "$REGION" --output json 2>/dev/null | \
      python3 -c "
import sys, json
data = json.load(sys.stdin)
sg = data['SecurityGroups'][0]
gid = sg['GroupId']
for rule in sg.get('IpPermissions', []):
    print(json.dumps({'GroupId': gid, 'IpPermissions': [rule]}))
" 2>/dev/null | while read -r rule; do
      aws ec2 revoke-security-group-ingress --cli-input-json "$rule" --region "$REGION" > /dev/null 2>&1 || true
    done
  done
  for sg in $SGS; do
    echo "  Deleting security group $sg..."
    aws ec2 delete-security-group --group-id "$sg" --region "$REGION" 2>/dev/null || true
  done

  # Subnets
  SUBNETS=$(aws ec2 describe-subnets --region "$REGION" \
    --filters "Name=vpc-id,Values=$OLD_VPC" \
    --query "Subnets[*].SubnetId" --output text 2>/dev/null || echo "")
  for subnet in $SUBNETS; do
    echo "  Deleting subnet $subnet..."
    aws ec2 delete-subnet --subnet-id "$subnet" --region "$REGION" 2>/dev/null || true
  done

  # Internet gateway
  IGWS=$(aws ec2 describe-internet-gateways --region "$REGION" \
    --filters "Name=attachment.vpc-id,Values=$OLD_VPC" \
    --query "InternetGateways[*].InternetGatewayId" --output text 2>/dev/null || echo "")
  for igw in $IGWS; do
    echo "  Detaching and deleting IGW $igw..."
    aws ec2 detach-internet-gateway --internet-gateway-id "$igw" --vpc-id "$OLD_VPC" --region "$REGION" 2>/dev/null || true
    aws ec2 delete-internet-gateway --internet-gateway-id "$igw" --region "$REGION" 2>/dev/null || true
  done

  # Delete the VPC
  echo "  Deleting VPC $OLD_VPC..."
  aws ec2 delete-vpc --vpc-id "$OLD_VPC" --region "$REGION" 2>/dev/null || true
fi

# =============================================================================
# Delete IAM roles (with cliniaacian-prod prefix)
# =============================================================================
echo ""
echo "=== Deleting old IAM roles ==="
OLD_ROLES=$(aws iam list-roles \
  --query "Roles[?starts_with(RoleName, '${OLD_PREFIX}')].RoleName" --output text 2>/dev/null || echo "")
for role in $OLD_ROLES; do
  echo "  Deleting IAM role $role..."
  # Detach managed policies
  POLICIES=$(aws iam list-attached-role-policies --role-name "$role" \
    --query "AttachedPolicies[*].PolicyArn" --output text 2>/dev/null || echo "")
  for policy in $POLICIES; do
    aws iam detach-role-policy --role-name "$role" --policy-arn "$policy" 2>/dev/null || true
  done
  # Delete inline policies
  INLINE=$(aws iam list-role-policies --role-name "$role" \
    --query "PolicyNames" --output text 2>/dev/null || echo "")
  for pol in $INLINE; do
    aws iam delete-role-policy --role-name "$role" --policy-name "$pol" 2>/dev/null || true
  done
  # Delete instance profiles
  PROFILES=$(aws iam list-instance-profiles-for-role --role-name "$role" \
    --query "InstanceProfiles[*].InstanceProfileName" --output text 2>/dev/null || echo "")
  for prof in $PROFILES; do
    aws iam remove-role-from-instance-profile --role-name "$role" --instance-profile-name "$prof" 2>/dev/null || true
  done
  aws iam delete-role --role-name "$role" 2>/dev/null || true
done

# =============================================================================
# Delete CloudWatch log groups
# =============================================================================
echo ""
echo "=== Deleting old CloudWatch log groups ==="
OLD_LOG_GROUPS=$(aws logs describe-log-groups --region "$REGION" \
  --log-group-name-prefix "/aws/" \
  --query "logGroups[?contains(logGroupName, 'cliniaacian')].logGroupName" --output text 2>/dev/null || echo "")
# Also check with the prefix pattern
OLD_LOG_GROUPS2=$(aws logs describe-log-groups --region "$REGION" \
  --log-group-name-prefix "${OLD_PREFIX}" \
  --query "logGroups[*].logGroupName" --output text 2>/dev/null || echo "")
for lg in $OLD_LOG_GROUPS $OLD_LOG_GROUPS2; do
  echo "  Deleting log group $lg..."
  aws logs delete-log-group --log-group-name "$lg" --region "$REGION" 2>/dev/null || true
done

# =============================================================================
# Clean up DynamoDB stale entries
# =============================================================================
echo ""
echo "=== Cleaning up DynamoDB lock entries ==="
for KEY in \
  "cliniaacian-prod-terraform-state/cliniaacian/prod/terraform.tfstate-md5" \
  "cliniaacian-prod-terraform-state/cliniaacian/prod/terraform.tfstate" \
  "cliniaccian-prod-terraform-state/cliniaacian/prod/terraform.tfstate-md5" \
  "cliniaccian-prod-terraform-state/cliniaacian/prod/terraform.tfstate"; do
  aws dynamodb delete-item \
    --table-name terraform-state-lock \
    --key "{\"LockID\":{\"S\":\"${KEY}\"}}" \
    --region "$REGION" 2>/dev/null || true
done
echo "  Done."

# =============================================================================
# Delete ACM certificates for old domain
# =============================================================================
echo ""
echo "=== Deleting old ACM certificates ==="
# Check us-east-1 (CloudFront certs)
OLD_CERTS_USE1=$(aws acm list-certificates --region us-east-1 \
  --query "CertificateSummaryList[?DomainName=='cliniaacian.com'].CertificateArn" --output text 2>/dev/null || echo "")
for cert in $OLD_CERTS_USE1; do
  echo "  Deleting certificate $cert (us-east-1)..."
  aws acm delete-certificate --certificate-arn "$cert" --region us-east-1 2>/dev/null || true
done
# Check regional certs
OLD_CERTS=$(aws acm list-certificates --region "$REGION" \
  --query "CertificateSummaryList[?DomainName=='cliniaacian.com'].CertificateArn" --output text 2>/dev/null || echo "")
for cert in $OLD_CERTS; do
  echo "  Deleting certificate $cert ($REGION)..."
  aws acm delete-certificate --certificate-arn "$cert" --region "$REGION" 2>/dev/null || true
done

# =============================================================================
# Delete old Route53 records for cliniaacian.com
# =============================================================================
echo ""
echo "=== Checking for old Route53 hosted zone ==="
OLD_ZONE=$(aws route53 list-hosted-zones-by-name --dns-name "cliniaacian.com" \
  --query "HostedZones[?Name=='cliniaacian.com.'].Id" --output text 2>/dev/null || echo "None")
if [ "$OLD_ZONE" != "None" ] && [ -n "$OLD_ZONE" ]; then
  echo "  Found hosted zone: $OLD_ZONE"
  echo "  You may want to delete this zone manually if cliniaacian.com is no longer needed."
  echo "  Command: aws route53 delete-hosted-zone --id $OLD_ZONE"
fi

echo ""
echo "=== Cleanup complete ==="
echo ""
echo "Some resources may still be deleting in the background (RDS, CloudFront)."
echo "Check the AWS Console to confirm everything is gone."
echo ""
echo "You can now delete the migration scripts:"
echo "  rm terraform/migrate-data.sh terraform/cleanup-old-resources.sh"
echo "  rm terraform/cleanup-duplicates.sh terraform/import-existing.sh"
