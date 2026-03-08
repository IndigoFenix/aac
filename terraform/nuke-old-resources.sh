#!/bin/bash
# =============================================================================
# Comprehensive cleanup of ALL old/orphaned AWS resources in il-central-1.
#
# Strategy:
#   1. Identify the aivota-prod VPC (the keeper) from Terraform state or tags
#   2. Discover ALL VPCs, security groups, ENIs, etc. in the region
#   3. Everything NOT belonging to aivota-prod is flagged for deletion
#   4. Delete in proper dependency order with retries for stubborn resources
#
# This replaces cleanup-old-resources.sh which only looked for specific names.
#
# Usage:
#   bash terraform/nuke-old-resources.sh [--dry-run]
# =============================================================================
# NOTE: Do NOT use set -e or set -u here. This is a cleanup script where many
# commands are expected to fail (resources already deleted, dependencies, etc.).
# set -e silently kills the script on the first failure.
# set -u kills it on empty array iteration in older bash (like MINGW).
set -o pipefail

# Show where the script dies if it crashes
trap 'echo ""; echo "*** Script died at line $LINENO ***"; echo "Last command exit code: $?"' ERR

REGION="il-central-1"
PROFILE="${AWS_PROFILE:-aac}"
export AWS_PROFILE="$PROFILE"
DRY_RUN=false

if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=true
  echo "*** DRY RUN MODE — no resources will be deleted ***"
  echo ""
fi

ACCOUNT_ID=$(aws sts get-caller-identity --query "Account" --output text)

echo "============================================================"
echo "  Comprehensive AWS Resource Cleanup"
echo "  Account: $ACCOUNT_ID"
echo "  Region:  $REGION"
echo "  Mode:    $(if $DRY_RUN; then echo 'DRY RUN'; else echo 'LIVE'; fi)"
echo "============================================================"
echo ""

# =============================================================================
# Helper functions
# =============================================================================

is_valid() {
  local val="$1"
  [[ -n "$val" && "$val" != "None" && "$val" != "null" ]]
}

# Tracks overall success/failure
FAIL_COUNT=0
OK_COUNT=0

# Run an AWS delete command with visible error reporting.
# Usage: try_delete "description" aws ec2 delete-thing --id xxx
try_delete() {
  local desc="$1"
  shift
  local output
  if output=$("$@" 2>&1); then
    echo "  OK    $desc"
    ((OK_COUNT++)) || true
  else
    echo "  FAIL  $desc"
    echo "        $output" | head -5
    ((FAIL_COUNT++)) || true
  fi
}

# =============================================================================
# Phase 1: Identify the KEEPER VPC (aivota-prod)
# =============================================================================

echo "=== Phase 1: Identifying keeper VPC (aivota-prod) ==="

KEEPER_VPC=""

# Method 1: Find by tag
KEEPER_VPC=$(aws ec2 describe-vpcs --region "$REGION" \
  --filters "Name=tag:Name,Values=aivota-prod-vpc" \
  --query "Vpcs[0].VpcId" --output text 2>/dev/null || echo "None")

if ! is_valid "$KEEPER_VPC"; then
  # Method 2: Find by Project tag
  KEEPER_VPC=$(aws ec2 describe-vpcs --region "$REGION" \
    --filters "Name=tag:Project,Values=AiVota" \
    --query "Vpcs[0].VpcId" --output text 2>/dev/null || echo "None")
fi

if ! is_valid "$KEEPER_VPC"; then
  # Method 3: Find by RDS association
  KEEPER_VPC=$(aws rds describe-db-instances \
    --db-instance-identifier "aivota-prod-postgres" \
    --region "$REGION" \
    --query "DBInstances[0].DBSubnetGroup.VpcId" --output text 2>/dev/null || echo "None")
fi

if is_valid "$KEEPER_VPC"; then
  echo "  Keeper VPC: $KEEPER_VPC"
else
  echo "  WARNING: Could not find aivota-prod VPC. Will list ALL VPCs for manual review."
  KEEPER_VPC="NONE_FOUND"
fi

# =============================================================================
# Phase 2: Discover ALL resources in the region
# =============================================================================

echo ""
echo "=== Phase 2: Discovering all resources ==="

# --- VPCs ---
echo ""
echo "--- VPCs ---"
ALL_VPCS=$(aws ec2 describe-vpcs --region "$REGION" \
  --query "Vpcs[*].[VpcId, Tags[?Key=='Name'].Value | [0] || 'no-name', CidrBlock, IsDefault]" \
  --output text 2>/dev/null || echo "")

ORPHAN_VPCS=()
DEFAULT_VPC=""
while IFS=$'\t' read -r vpc_id name cidr is_default; do
  [[ -z "$vpc_id" ]] && continue
  if [[ "$is_default" == "true" || "$is_default" == "True" ]]; then
    echo "  [DEFAULT] $vpc_id  $name  $cidr"
    DEFAULT_VPC="$vpc_id"
  elif [[ "$vpc_id" == "$KEEPER_VPC" ]]; then
    echo "  [KEEP]    $vpc_id  $name  $cidr"
  else
    echo "  [DELETE]  $vpc_id  $name  $cidr"
    ORPHAN_VPCS+=("$vpc_id")
  fi
done <<< "$ALL_VPCS"

# --- Security Groups (outside keeper VPC) ---
echo ""
echo "--- Security Groups ---"
ALL_SGS=$(aws ec2 describe-security-groups --region "$REGION" \
  --query "SecurityGroups[*].[GroupId, GroupName, VpcId, Description]" \
  --output text 2>/dev/null || echo "")

ORPHAN_SGS=()
while IFS=$'\t' read -r sg_id name vpc_id desc; do
  [[ -z "$sg_id" ]] && continue
  if [[ "$vpc_id" == "$KEEPER_VPC" || "$vpc_id" == "$DEFAULT_VPC" ]]; then
    continue  # belongs to keeper or default VPC
  fi
  if [[ "$name" == "default" ]]; then
    echo "  [DEFAULT] $sg_id  in $vpc_id"
    continue  # default SGs can't be deleted directly, VPC deletion handles them
  fi
  echo "  [DELETE]  $sg_id  $name  in $vpc_id  ($desc)"
  ORPHAN_SGS+=("$sg_id")
done <<< "$ALL_SGS"

if [[ ${#ORPHAN_SGS[@]} -eq 0 ]]; then
  echo "  No orphan security groups found."
fi

# --- Network Interfaces ---
echo ""
echo "--- Network Interfaces ---"
ALL_ENIS=$(aws ec2 describe-network-interfaces --region "$REGION" \
  --query "NetworkInterfaces[*].[NetworkInterfaceId, VpcId, Status, InterfaceType, Description, Attachment.AttachmentId || 'none']" \
  --output text 2>/dev/null || echo "")

ORPHAN_ENIS=()
ORPHAN_ENI_ATTACHMENTS=()
while IFS=$'\t' read -r eni_id vpc_id status iface_type desc attach_id; do
  [[ -z "$eni_id" ]] && continue
  if [[ "$vpc_id" == "$KEEPER_VPC" || "$vpc_id" == "$DEFAULT_VPC" ]]; then
    continue
  fi
  echo "  [DELETE]  $eni_id  $status  type=$iface_type  vpc=$vpc_id  attach=$attach_id"
  echo "            $desc"
  ORPHAN_ENIS+=("$eni_id")
  if is_valid "$attach_id" && [[ "$attach_id" != "none" ]]; then
    ORPHAN_ENI_ATTACHMENTS+=("$attach_id")
  fi
done <<< "$ALL_ENIS"

if [[ ${#ORPHAN_ENIS[@]} -eq 0 ]]; then
  echo "  No orphan ENIs found."
fi

# --- NAT Gateways ---
echo ""
echo "--- NAT Gateways ---"
ALL_NATS=$(aws ec2 describe-nat-gateways --region "$REGION" \
  --filter "Name=state,Values=available,pending,deleting,failed" \
  --query "NatGateways[*].[NatGatewayId, VpcId, State, Tags[?Key=='Name'].Value | [0] || 'no-name']" \
  --output text 2>/dev/null || echo "")

ORPHAN_NATS=()
while IFS=$'\t' read -r nat_id vpc_id state name; do
  [[ -z "$nat_id" ]] && continue
  if [[ "$vpc_id" == "$KEEPER_VPC" ]]; then
    continue
  fi
  echo "  [DELETE]  $nat_id  $state  $name  vpc=$vpc_id"
  if [[ "$state" == "available" || "$state" == "pending" ]]; then
    ORPHAN_NATS+=("$nat_id")
  fi
done <<< "$ALL_NATS"

if [[ ${#ORPHAN_NATS[@]} -eq 0 ]]; then
  echo "  No orphan NAT gateways found."
fi

# --- Elastic IPs ---
echo ""
echo "--- Elastic IPs ---"
ALL_EIPS=$(aws ec2 describe-addresses --region "$REGION" \
  --query "Addresses[*].[AllocationId, PublicIp, AssociationId || 'none', Tags[?Key=='Name'].Value | [0] || 'no-name', NetworkInterfaceId || 'none']" \
  --output text 2>/dev/null || echo "")

ORPHAN_EIPS=()
KEEPER_EIPS=()
while IFS=$'\t' read -r alloc_id ip assoc_id name eni_id; do
  [[ -z "$alloc_id" ]] && continue
  # Check if this EIP's ENI is in the keeper VPC
  if is_valid "$eni_id" && [[ "$eni_id" != "none" ]]; then
    ENI_VPC=$(aws ec2 describe-network-interfaces --network-interface-ids "$eni_id" --region "$REGION" \
      --query "NetworkInterfaces[0].VpcId" --output text 2>/dev/null || echo "unknown")
    if [[ "$ENI_VPC" == "$KEEPER_VPC" ]]; then
      KEEPER_EIPS+=("$alloc_id")
      continue
    fi
  fi
  # Anything tagged aivota is a keeper
  if [[ "$name" == *aivota* ]]; then
    echo "  [KEEP]    $alloc_id  $ip  $name"
    KEEPER_EIPS+=("$alloc_id")
    continue
  fi
  echo "  [DELETE]  $alloc_id  $ip  $name  assoc=$assoc_id"
  ORPHAN_EIPS+=("$alloc_id")
done <<< "$ALL_EIPS"

if [[ ${#ORPHAN_EIPS[@]} -eq 0 ]]; then
  echo "  No orphan EIPs found."
fi

# --- Internet Gateways ---
echo ""
echo "--- Internet Gateways ---"
ALL_IGWS=$(aws ec2 describe-internet-gateways --region "$REGION" \
  --query "InternetGateways[*].[InternetGatewayId, Attachments[0].VpcId || 'detached', Tags[?Key=='Name'].Value | [0] || 'no-name']" \
  --output text 2>/dev/null || echo "")

ORPHAN_IGWS=()
ORPHAN_IGW_VPCS=()
while IFS=$'\t' read -r igw_id vpc_id name; do
  [[ -z "$igw_id" ]] && continue
  if [[ "$vpc_id" == "$KEEPER_VPC" || "$vpc_id" == "$DEFAULT_VPC" ]]; then
    continue
  fi
  echo "  [DELETE]  $igw_id  $name  vpc=$vpc_id"
  ORPHAN_IGWS+=("$igw_id")
  ORPHAN_IGW_VPCS+=("$vpc_id")
done <<< "$ALL_IGWS"

if [[ ${#ORPHAN_IGWS[@]} -eq 0 ]]; then
  echo "  No orphan IGWs found."
fi

# --- Load Balancers ---
echo ""
echo "--- Load Balancers ---"
ALL_ALBS=$(aws elbv2 describe-load-balancers --region "$REGION" \
  --query "LoadBalancers[*].[LoadBalancerArn, LoadBalancerName, VpcId, State.Code]" \
  --output text 2>/dev/null || echo "")

ORPHAN_ALBS=()
while IFS=$'\t' read -r alb_arn name vpc_id state; do
  [[ -z "$alb_arn" ]] && continue
  if [[ "$vpc_id" == "$KEEPER_VPC" ]]; then
    continue
  fi
  echo "  [DELETE]  $name  $state  vpc=$vpc_id"
  ORPHAN_ALBS+=("$alb_arn")
done <<< "$ALL_ALBS"

if [[ ${#ORPHAN_ALBS[@]} -eq 0 ]]; then
  echo "  No orphan ALBs found."
fi

# --- Target Groups ---
echo ""
echo "--- Target Groups ---"
ALL_TGS=$(aws elbv2 describe-target-groups --region "$REGION" \
  --query "TargetGroups[*].[TargetGroupArn, TargetGroupName, VpcId]" \
  --output text 2>/dev/null || echo "")

ORPHAN_TGS=()
while IFS=$'\t' read -r tg_arn name vpc_id; do
  [[ -z "$tg_arn" ]] && continue
  if [[ "$vpc_id" == "$KEEPER_VPC" ]]; then
    continue
  fi
  echo "  [DELETE]  $name  vpc=$vpc_id"
  ORPHAN_TGS+=("$tg_arn")
done <<< "$ALL_TGS"

if [[ ${#ORPHAN_TGS[@]} -eq 0 ]]; then
  echo "  No orphan target groups found."
fi

# --- VPC Endpoints ---
echo ""
echo "--- VPC Endpoints ---"
ALL_VPCE=$(aws ec2 describe-vpc-endpoints --region "$REGION" \
  --query "VpcEndpoints[*].[VpcEndpointId, VpcId, ServiceName, State]" \
  --output text 2>/dev/null || echo "")

ORPHAN_VPCE=()
while IFS=$'\t' read -r vpce_id vpc_id svc state; do
  [[ -z "$vpce_id" ]] && continue
  if [[ "$vpc_id" == "$KEEPER_VPC" || "$vpc_id" == "$DEFAULT_VPC" ]]; then
    continue
  fi
  echo "  [DELETE]  $vpce_id  $svc  $state  vpc=$vpc_id"
  ORPHAN_VPCE+=("$vpce_id")
done <<< "$ALL_VPCE"

if [[ ${#ORPHAN_VPCE[@]} -eq 0 ]]; then
  echo "  No orphan VPC endpoints found."
fi

# --- Route Tables ---
echo ""
echo "--- Route Tables (non-main, non-keeper) ---"
ALL_RTS=$(aws ec2 describe-route-tables --region "$REGION" \
  --query "RouteTables[*].[RouteTableId, VpcId, Associations[0].Main || \`false\`, Tags[?Key=='Name'].Value | [0] || 'no-name']" \
  --output text 2>/dev/null || echo "")

ORPHAN_RTS=()
while IFS=$'\t' read -r rt_id vpc_id is_main name; do
  [[ -z "$rt_id" ]] && continue
  if [[ "$vpc_id" == "$KEEPER_VPC" || "$vpc_id" == "$DEFAULT_VPC" ]]; then
    continue
  fi
  if [[ "$is_main" == "true" || "$is_main" == "True" ]]; then
    continue  # Main route tables are deleted with VPC
  fi
  echo "  [DELETE]  $rt_id  $name  vpc=$vpc_id"
  ORPHAN_RTS+=("$rt_id")
done <<< "$ALL_RTS"

if [[ ${#ORPHAN_RTS[@]} -eq 0 ]]; then
  echo "  No orphan route tables found."
fi

# --- Subnets ---
echo ""
echo "--- Subnets ---"
ALL_SUBNETS=$(aws ec2 describe-subnets --region "$REGION" \
  --query "Subnets[*].[SubnetId, VpcId, CidrBlock, Tags[?Key=='Name'].Value | [0] || 'no-name']" \
  --output text 2>/dev/null || echo "")

ORPHAN_SUBNETS=()
while IFS=$'\t' read -r subnet_id vpc_id cidr name; do
  [[ -z "$subnet_id" ]] && continue
  if [[ "$vpc_id" == "$KEEPER_VPC" || "$vpc_id" == "$DEFAULT_VPC" ]]; then
    continue
  fi
  echo "  [DELETE]  $subnet_id  $name  $cidr  vpc=$vpc_id"
  ORPHAN_SUBNETS+=("$subnet_id")
done <<< "$ALL_SUBNETS"

if [[ ${#ORPHAN_SUBNETS[@]} -eq 0 ]]; then
  echo "  No orphan subnets found."
fi

# --- ECS Clusters & Services ---
echo ""
echo "--- ECS Clusters ---"
ALL_ECS=$(aws ecs list-clusters --region "$REGION" \
  --query "clusterArns" --output text 2>/dev/null || echo "")
ORPHAN_ECS_CLUSTERS=()
for cluster_arn in $ALL_ECS; do
  cluster_name="${cluster_arn##*/}"
  if [[ "$cluster_name" == *aivota* ]]; then
    echo "  [KEEP]    $cluster_name"
    continue
  fi
  echo "  [DELETE]  $cluster_name"
  ORPHAN_ECS_CLUSTERS+=("$cluster_arn")
done

if [[ ${#ORPHAN_ECS_CLUSTERS[@]} -eq 0 ]]; then
  echo "  No orphan ECS clusters found."
fi

# --- ECR Repositories ---
echo ""
echo "--- ECR Repositories ---"
ALL_ECR=$(aws ecr describe-repositories --region "$REGION" \
  --query "repositories[*].[repositoryName, repositoryUri]" --output text 2>/dev/null || echo "")

ORPHAN_ECR=()
while IFS=$'\t' read -r repo_name repo_uri; do
  [[ -z "$repo_name" ]] && continue
  if [[ "$repo_name" == aivota* ]]; then
    echo "  [KEEP]    $repo_name"
    continue
  fi
  echo "  [DELETE]  $repo_name  $repo_uri"
  ORPHAN_ECR+=("$repo_name")
done <<< "$ALL_ECR"

if [[ ${#ORPHAN_ECR[@]} -eq 0 ]]; then
  echo "  No orphan ECR repos found."
fi

# --- Lambda Functions ---
echo ""
echo "--- Lambda Functions ---"
ALL_LAMBDA=$(aws lambda list-functions --region "$REGION" \
  --query "Functions[*].[FunctionName, Runtime || 'container', LastModified]" \
  --output text 2>/dev/null || echo "")

ORPHAN_LAMBDAS=()
while IFS=$'\t' read -r func_name runtime modified; do
  [[ -z "$func_name" ]] && continue
  if [[ "$func_name" == aivota* ]]; then
    echo "  [KEEP]    $func_name"
    continue
  fi
  echo "  [DELETE]  $func_name  $runtime  $modified"
  ORPHAN_LAMBDAS+=("$func_name")
done <<< "$ALL_LAMBDA"

if [[ ${#ORPHAN_LAMBDAS[@]} -eq 0 ]]; then
  echo "  No orphan Lambda functions found."
fi

# --- API Gateways ---
echo ""
echo "--- API Gateways ---"
ALL_APIGW=$(aws apigatewayv2 get-apis --region "$REGION" \
  --query "Items[*].[ApiId, Name, ProtocolType, CreatedDate]" \
  --output text 2>/dev/null || echo "")

ORPHAN_APIGWS=()
while IFS=$'\t' read -r api_id name protocol created; do
  [[ -z "$api_id" ]] && continue
  if [[ "$name" == aivota* ]]; then
    echo "  [KEEP]    $api_id  $name"
    continue
  fi
  echo "  [DELETE]  $api_id  $name  $protocol  $created"
  ORPHAN_APIGWS+=("$api_id")
done <<< "$ALL_APIGW"

if [[ ${#ORPHAN_APIGWS[@]} -eq 0 ]]; then
  echo "  No orphan API Gateways found."
fi

# --- RDS Instances ---
echo ""
echo "--- RDS Instances ---"
ALL_RDS=$(aws rds describe-db-instances --region "$REGION" \
  --query "DBInstances[*].[DBInstanceIdentifier, DBInstanceStatus, Engine, DBInstanceClass]" \
  --output text 2>/dev/null || echo "")

ORPHAN_RDS=()
while IFS=$'\t' read -r db_id status engine class; do
  [[ -z "$db_id" ]] && continue
  if [[ "$db_id" == aivota* ]]; then
    echo "  [KEEP]    $db_id  $status  $engine  $class"
    continue
  fi
  echo "  [DELETE]  $db_id  $status  $engine  $class"
  ORPHAN_RDS+=("$db_id")
done <<< "$ALL_RDS"

if [[ ${#ORPHAN_RDS[@]} -eq 0 ]]; then
  echo "  No orphan RDS instances found."
fi

# --- RDS Subnet Groups ---
echo ""
echo "--- RDS Subnet Groups ---"
ALL_DB_SUBNET_GROUPS=$(aws rds describe-db-subnet-groups --region "$REGION" \
  --query "DBSubnetGroups[*].[DBSubnetGroupName, VpcId, DBSubnetGroupDescription]" \
  --output text 2>/dev/null || echo "")

ORPHAN_DB_SUBNET_GROUPS=()
while IFS=$'\t' read -r sg_name vpc_id desc; do
  [[ -z "$sg_name" ]] && continue
  if [[ "$vpc_id" == "$KEEPER_VPC" ]] || [[ "$sg_name" == aivota* ]]; then
    echo "  [KEEP]    $sg_name  vpc=$vpc_id"
    continue
  fi
  echo "  [DELETE]  $sg_name  vpc=$vpc_id  ($desc)"
  ORPHAN_DB_SUBNET_GROUPS+=("$sg_name")
done <<< "$ALL_DB_SUBNET_GROUPS"

if [[ ${#ORPHAN_DB_SUBNET_GROUPS[@]} -eq 0 ]]; then
  echo "  No orphan DB subnet groups found."
fi

# --- RDS Parameter Groups ---
echo ""
echo "--- RDS Parameter Groups (custom only) ---"
ALL_DB_PARAM_GROUPS=$(aws rds describe-db-parameter-groups --region "$REGION" \
  --query "DBParameterGroups[?!starts_with(DBParameterGroupName, 'default.')].[DBParameterGroupName, Description]" \
  --output text 2>/dev/null || echo "")

ORPHAN_DB_PARAM_GROUPS=()
while IFS=$'\t' read -r pg_name desc; do
  [[ -z "$pg_name" ]] && continue
  if [[ "$pg_name" == aivota* ]]; then
    echo "  [KEEP]    $pg_name"
    continue
  fi
  echo "  [DELETE]  $pg_name  ($desc)"
  ORPHAN_DB_PARAM_GROUPS+=("$pg_name")
done <<< "$ALL_DB_PARAM_GROUPS"

if [[ ${#ORPHAN_DB_PARAM_GROUPS[@]} -eq 0 ]]; then
  echo "  No orphan parameter groups found."
fi

# --- S3 Buckets ---
echo ""
echo "--- S3 Buckets ---"
ALL_BUCKETS=$(aws s3api list-buckets --query "Buckets[*].Name" --output text 2>/dev/null || echo "")

ORPHAN_BUCKETS=()
for bucket in $ALL_BUCKETS; do
  # Check bucket region
  BUCKET_REGION=$(aws s3api get-bucket-location --bucket "$bucket" \
    --query "LocationConstraint || 'us-east-1'" --output text 2>/dev/null || echo "unknown")
  if [[ "$BUCKET_REGION" != "$REGION" && "$BUCKET_REGION" != "None" ]]; then
    continue  # Different region, skip
  fi
  if [[ "$bucket" == aivota* ]]; then
    echo "  [KEEP]    $bucket"
    continue
  fi
  if [[ "$bucket" == *cliniaacian* || "$bucket" == *cliniaccian* ]]; then
    echo "  [DELETE]  $bucket"
    ORPHAN_BUCKETS+=("$bucket")
  fi
done

if [[ ${#ORPHAN_BUCKETS[@]} -eq 0 ]]; then
  echo "  No orphan S3 buckets found."
fi

# --- Secrets Manager ---
echo ""
echo "--- Secrets Manager ---"
ALL_SECRETS=$(aws secretsmanager list-secrets --region "$REGION" \
  --query "SecretList[*].[Name, ARN]" --output text 2>/dev/null || echo "")

ORPHAN_SECRETS=()
while IFS=$'\t' read -r name arn; do
  [[ -z "$name" ]] && continue
  if [[ "$name" == aivota* ]]; then
    echo "  [KEEP]    $name"
    continue
  fi
  if [[ "$name" == cliniaacian* ]]; then
    echo "  [DELETE]  $name"
    ORPHAN_SECRETS+=("$name")
  fi
done <<< "$ALL_SECRETS"

if [[ ${#ORPHAN_SECRETS[@]} -eq 0 ]]; then
  echo "  No orphan secrets found."
fi

# --- KMS Keys ---
echo ""
echo "--- KMS Keys ---"
ALL_KMS_ALIASES=$(aws kms list-aliases --region "$REGION" \
  --query "Aliases[?!starts_with(AliasName, 'alias/aws/')].[AliasName, TargetKeyId]" \
  --output text 2>/dev/null || echo "")

ORPHAN_KMS_KEYS=()
while IFS=$'\t' read -r alias key_id; do
  [[ -z "$alias" ]] && continue
  if [[ "$alias" == *aivota* ]]; then
    echo "  [KEEP]    $alias  $key_id"
    continue
  fi
  if [[ "$alias" == *cliniaacian* ]]; then
    echo "  [DELETE]  $alias  $key_id"
    ORPHAN_KMS_KEYS+=("$key_id")
  fi
done <<< "$ALL_KMS_ALIASES"

if [[ ${#ORPHAN_KMS_KEYS[@]} -eq 0 ]]; then
  echo "  No orphan KMS keys found."
fi

# --- IAM Roles ---
echo ""
echo "--- IAM Roles (cliniaacian-*) ---"
ALL_IAM_ROLES=$(aws iam list-roles \
  --query "Roles[?starts_with(RoleName, 'cliniaacian')].RoleName" --output text 2>/dev/null || echo "")

ORPHAN_ROLES=()
for role in $ALL_IAM_ROLES; do
  echo "  [DELETE]  $role"
  ORPHAN_ROLES+=("$role")
done

if [[ ${#ORPHAN_ROLES[@]} -eq 0 ]]; then
  echo "  No orphan IAM roles found."
fi

# --- IAM Instance Profiles ---
echo ""
echo "--- IAM Instance Profiles (cliniaacian-*) ---"
ALL_INSTANCE_PROFILES=$(aws iam list-instance-profiles \
  --query "InstanceProfiles[?starts_with(InstanceProfileName, 'cliniaacian')].InstanceProfileName" \
  --output text 2>/dev/null || echo "")

ORPHAN_PROFILES=()
for prof in $ALL_INSTANCE_PROFILES; do
  echo "  [DELETE]  $prof"
  ORPHAN_PROFILES+=("$prof")
done

if [[ ${#ORPHAN_PROFILES[@]} -eq 0 ]]; then
  echo "  No orphan instance profiles found."
fi

# --- IAM Policies (standalone, cliniaacian-*) ---
echo ""
echo "--- IAM Policies (cliniaacian-*) ---"
ALL_IAM_POLICIES=$(aws iam list-policies --scope Local \
  --query "Policies[?starts_with(PolicyName, 'cliniaacian')].[PolicyName, Arn]" --output text 2>/dev/null || echo "")

ORPHAN_POLICIES=()
while IFS=$'\t' read -r name arn; do
  [[ -z "$name" ]] && continue
  echo "  [DELETE]  $name"
  ORPHAN_POLICIES+=("$arn")
done <<< "$ALL_IAM_POLICIES"

if [[ ${#ORPHAN_POLICIES[@]} -eq 0 ]]; then
  echo "  No orphan IAM policies found."
fi

# --- SNS Topics ---
echo ""
echo "--- SNS Topics ---"
ALL_SNS=$(aws sns list-topics --region "$REGION" \
  --query "Topics[*].TopicArn" --output text 2>/dev/null || echo "")

ORPHAN_SNS=()
for topic_arn in $ALL_SNS; do
  topic_name="${topic_arn##*:}"
  if [[ "$topic_name" == aivota* ]]; then
    echo "  [KEEP]    $topic_name"
    continue
  fi
  if [[ "$topic_name" == cliniaacian* ]]; then
    echo "  [DELETE]  $topic_name"
    ORPHAN_SNS+=("$topic_arn")
  fi
done

if [[ ${#ORPHAN_SNS[@]} -eq 0 ]]; then
  echo "  No orphan SNS topics found."
fi

# --- CloudWatch Log Groups ---
echo ""
echo "--- CloudWatch Log Groups (cliniaacian) ---"
ORPHAN_LOG_GROUPS=()
for prefix in "cliniaacian" "/aws/lambda/cliniaacian" "/aws/ecs/cliniaacian" "/ecs/cliniaacian" "/aws/rds/instance/cliniaacian"; do
  GROUPS=$(aws logs describe-log-groups --region "$REGION" \
    --log-group-name-prefix "$prefix" \
    --query "logGroups[*].logGroupName" --output text 2>/dev/null || echo "")
  for lg in $GROUPS; do
    echo "  [DELETE]  $lg"
    ORPHAN_LOG_GROUPS+=("$lg")
  done
done

# Also check specific /aws/ sub-prefixes (avoid scanning ALL /aws/ log groups)
for aws_prefix in "/aws/lambda/cliniaacian" "/aws/ecs/cliniaacian" "/aws/rds/instance/cliniaacian" "/aws/apigateway/cliniaacian" "/aws/cloudtrail/cliniaacian"; do
  GROUPS2=$(aws logs describe-log-groups --region "$REGION" \
    --log-group-name-prefix "$aws_prefix" \
    --query "logGroups[*].logGroupName" --output text 2>/dev/null || echo "")
  for lg in $GROUPS2; do
    [[ -z "$lg" || "$lg" == "None" ]] && continue
    # Avoid duplicates
    if [[ ! " ${ORPHAN_LOG_GROUPS[*]:-} " =~ " ${lg} " ]]; then
      echo "  [DELETE]  $lg"
      ORPHAN_LOG_GROUPS+=("$lg")
    fi
  done
done

if [[ ${#ORPHAN_LOG_GROUPS[@]} -eq 0 ]]; then
  echo "  No orphan log groups found."
fi

# --- ACM Certificates ---
echo ""
echo "--- ACM Certificates ---"
ORPHAN_CERTS=()
for cert_region in "$REGION" "us-east-1"; do
  CERTS=$(aws acm list-certificates --region "$cert_region" \
    --query "CertificateSummaryList[?DomainName=='cliniaacian.com'].[CertificateArn, DomainName, Status]" \
    --output text 2>/dev/null || echo "")
  while IFS=$'\t' read -r arn domain status; do
    [[ -z "$arn" ]] && continue
    echo "  [DELETE]  $arn  $domain  $status  ($cert_region)"
    ORPHAN_CERTS+=("$cert_region:$arn")
  done <<< "$CERTS"
done

if [[ ${#ORPHAN_CERTS[@]} -eq 0 ]]; then
  echo "  No orphan ACM certificates found."
fi

# --- CloudFront Distributions ---
echo ""
echo "--- CloudFront Distributions ---"
ALL_CF=$(aws cloudfront list-distributions \
  --query "DistributionList.Items[*].[Id, DomainName, Status, Aliases.Items[0] || 'no-alias']" \
  --output text 2>/dev/null || echo "")

ORPHAN_CFS=()
while IFS=$'\t' read -r cf_id domain status alias; do
  [[ -z "$cf_id" ]] && continue
  if [[ "$alias" == *aivota* ]]; then
    echo "  [KEEP]    $cf_id  $alias  $status"
    continue
  fi
  if [[ "$alias" == *cliniaacian* ]]; then
    echo "  [DELETE]  $cf_id  $alias  $status"
    ORPHAN_CFS+=("$cf_id")
  fi
done <<< "$ALL_CF"

if [[ ${#ORPHAN_CFS[@]} -eq 0 ]]; then
  echo "  No orphan CloudFront distributions found."
fi

# --- EC2 Instances (bastion, etc.) ---
echo ""
echo "--- EC2 Instances ---"
ALL_EC2=$(aws ec2 describe-instances --region "$REGION" \
  --filters "Name=instance-state-name,Values=running,stopped,pending" \
  --query "Reservations[*].Instances[*].[InstanceId, InstanceType, State.Name, Tags[?Key=='Name'].Value | [0] || 'no-name', VpcId]" \
  --output text 2>/dev/null || echo "")

ORPHAN_EC2=()
while IFS=$'\t' read -r inst_id type state name vpc_id; do
  [[ -z "$inst_id" ]] && continue
  if [[ "$vpc_id" == "$KEEPER_VPC" ]] || [[ "$name" == *aivota* ]]; then
    echo "  [KEEP]    $inst_id  $name  $type  $state  vpc=$vpc_id"
    continue
  fi
  echo "  [DELETE]  $inst_id  $name  $type  $state  vpc=$vpc_id"
  ORPHAN_EC2+=("$inst_id")
done <<< "$ALL_EC2"

if [[ ${#ORPHAN_EC2[@]} -eq 0 ]]; then
  echo "  No orphan EC2 instances found."
fi

# --- Network ACLs (non-default) ---
echo ""
echo "--- Network ACLs (non-default) ---"
ALL_NACLS=$(aws ec2 describe-network-acls --region "$REGION" \
  --query "NetworkAcls[?!IsDefault].[NetworkAclId, VpcId, Tags[?Key=='Name'].Value | [0] || 'no-name']" \
  --output text 2>/dev/null || echo "")

ORPHAN_NACLS=()
while IFS=$'\t' read -r nacl_id vpc_id name; do
  [[ -z "$nacl_id" ]] && continue
  if [[ "$vpc_id" == "$KEEPER_VPC" || "$vpc_id" == "$DEFAULT_VPC" ]]; then
    continue
  fi
  echo "  [DELETE]  $nacl_id  $name  vpc=$vpc_id"
  ORPHAN_NACLS+=("$nacl_id")
done <<< "$ALL_NACLS"

if [[ ${#ORPHAN_NACLS[@]} -eq 0 ]]; then
  echo "  No orphan NACLs found."
fi

# --- CloudWatch Alarms ---
echo ""
echo "--- CloudWatch Alarms (cliniaacian) ---"
ORPHAN_ALARMS=()
ALL_ALARMS=$(aws cloudwatch describe-alarms --region "$REGION" \
  --alarm-name-prefix "cliniaacian" \
  --query "MetricAlarms[*].AlarmName" --output text 2>/dev/null || echo "")
for alarm in $ALL_ALARMS; do
  echo "  [DELETE]  $alarm"
  ORPHAN_ALARMS+=("$alarm")
done

if [[ ${#ORPHAN_ALARMS[@]} -eq 0 ]]; then
  echo "  No orphan alarms found."
fi

# --- WAF Web ACLs ---
echo ""
echo "--- WAF Web ACLs ---"
ALL_WAF=$(aws wafv2 list-web-acls --scope REGIONAL --region "$REGION" \
  --query "WebACLs[*].[Name, Id, ARN]" --output text 2>/dev/null || echo "")

ORPHAN_WAFS=()
while IFS=$'\t' read -r name waf_id arn; do
  [[ -z "$name" ]] && continue
  if [[ "$name" == *aivota* ]]; then
    echo "  [KEEP]    $name"
    continue
  fi
  if [[ "$name" == *cliniaacian* ]]; then
    echo "  [DELETE]  $name  $waf_id"
    ORPHAN_WAFS+=("$waf_id:$name:$arn")
  fi
done <<< "$ALL_WAF"

if [[ ${#ORPHAN_WAFS[@]} -eq 0 ]]; then
  echo "  No orphan WAF ACLs found."
fi

# --- CloudWatch Dashboards ---
echo ""
echo "--- CloudWatch Dashboards ---"
ALL_DASHBOARDS=$(aws cloudwatch list-dashboards --region "$REGION" \
  --dashboard-name-prefix "cliniaacian" \
  --query "DashboardEntries[*].DashboardName" --output text 2>/dev/null || echo "")

ORPHAN_DASHBOARDS=()
for dash in $ALL_DASHBOARDS; do
  echo "  [DELETE]  $dash"
  ORPHAN_DASHBOARDS+=("$dash")
done

if [[ ${#ORPHAN_DASHBOARDS[@]} -eq 0 ]]; then
  echo "  No orphan dashboards found."
fi

# =============================================================================
# Phase 3: Summary
# =============================================================================

echo ""
echo "============================================================"
echo "  CLEANUP SUMMARY"
echo "============================================================"
echo ""
echo "  VPCs:                ${#ORPHAN_VPCS[@]}"
echo "  Security Groups:     ${#ORPHAN_SGS[@]}"
echo "  Network Interfaces:  ${#ORPHAN_ENIS[@]}"
echo "  NAT Gateways:        ${#ORPHAN_NATS[@]}"
echo "  Elastic IPs:         ${#ORPHAN_EIPS[@]}"
echo "  Internet Gateways:   ${#ORPHAN_IGWS[@]}"
echo "  Load Balancers:      ${#ORPHAN_ALBS[@]}"
echo "  Target Groups:       ${#ORPHAN_TGS[@]}"
echo "  VPC Endpoints:       ${#ORPHAN_VPCE[@]}"
echo "  Route Tables:        ${#ORPHAN_RTS[@]}"
echo "  Subnets:             ${#ORPHAN_SUBNETS[@]}"
echo "  ECS Clusters:        ${#ORPHAN_ECS_CLUSTERS[@]}"
echo "  ECR Repositories:    ${#ORPHAN_ECR[@]}"
echo "  Lambda Functions:    ${#ORPHAN_LAMBDAS[@]}"
echo "  API Gateways:        ${#ORPHAN_APIGWS[@]}"
echo "  RDS Instances:       ${#ORPHAN_RDS[@]}"
echo "  DB Subnet Groups:    ${#ORPHAN_DB_SUBNET_GROUPS[@]}"
echo "  DB Parameter Groups: ${#ORPHAN_DB_PARAM_GROUPS[@]}"
echo "  S3 Buckets:          ${#ORPHAN_BUCKETS[@]}"
echo "  Secrets:             ${#ORPHAN_SECRETS[@]}"
echo "  KMS Keys:            ${#ORPHAN_KMS_KEYS[@]}"
echo "  IAM Roles:           ${#ORPHAN_ROLES[@]}"
echo "  IAM Profiles:        ${#ORPHAN_PROFILES[@]}"
echo "  IAM Policies:        ${#ORPHAN_POLICIES[@]}"
echo "  SNS Topics:          ${#ORPHAN_SNS[@]}"
echo "  Log Groups:          ${#ORPHAN_LOG_GROUPS[@]}"
echo "  ACM Certificates:    ${#ORPHAN_CERTS[@]}"
echo "  CloudFront Distros:  ${#ORPHAN_CFS[@]}"
echo "  EC2 Instances:       ${#ORPHAN_EC2[@]}"
echo "  Network ACLs:        ${#ORPHAN_NACLS[@]}"
echo "  CloudWatch Alarms:   ${#ORPHAN_ALARMS[@]}"
echo "  WAF Web ACLs:        ${#ORPHAN_WAFS[@]}"
echo "  Dashboards:          ${#ORPHAN_DASHBOARDS[@]}"
echo ""

if $DRY_RUN; then
  echo "*** DRY RUN complete. Re-run without --dry-run to delete. ***"
  exit 0
fi

# =============================================================================
# Phase 4: Confirmation
# =============================================================================

echo "========================================="
echo "WARNING: This will PERMANENTLY DELETE all resources listed above."
echo "The aivota-prod VPC ($KEEPER_VPC) and its resources will NOT be touched."
echo "========================================="
echo ""
read -p "Type 'DELETE' to proceed: " CONFIRM
if [ "$CONFIRM" != "DELETE" ]; then
  echo "Aborted."
  exit 0
fi

echo ""
echo "=== Phase 5: Deleting resources (dependency-ordered) ==="
echo ""

# Verify arrays survived (debug diagnostic)
echo "  Arrays populated: VPCs=${#ORPHAN_VPCS[@]} SGs=${#ORPHAN_SGS[@]} ENIs=${#ORPHAN_ENIS[@]} Subnets=${#ORPHAN_SUBNETS[@]}"
echo ""

# =============================================================================
# Step 1: CloudFront (disable first, takes time)
# =============================================================================
for cf_id in "${ORPHAN_CFS[@]}"; do
  echo "--- Disabling CloudFront $cf_id ---"
  ETAG=$(aws cloudfront get-distribution-config --id "$cf_id" \
    --query "ETag" --output text 2>&1) || { echo "  FAIL  Could not get CloudFront config: $ETAG"; continue; }
  if is_valid "$ETAG"; then
    aws cloudfront get-distribution-config --id "$cf_id" --output json > /tmp/cf-config-$cf_id.json 2>&1 || true
    python3 -c "
import json
with open('/tmp/cf-config-$cf_id.json') as f: data = json.load(f)
config = data['DistributionConfig']
config['Enabled'] = False
with open('/tmp/cf-update-$cf_id.json', 'w') as f: json.dump(config, f)
" || { echo "  FAIL  Python config rewrite failed"; continue; }
    try_delete "Disable CloudFront $cf_id" \
      aws cloudfront update-distribution --id "$cf_id" \
        --distribution-config file:///tmp/cf-update-$cf_id.json \
        --if-match "$ETAG"
  fi
done

# =============================================================================
# Step 2: EC2 Instances (terminate before VPC cleanup)
# =============================================================================
for inst_id in "${ORPHAN_EC2[@]}"; do
  try_delete "Terminate EC2 $inst_id" \
    aws ec2 terminate-instances --instance-ids "$inst_id" --region "$REGION"
done
if [[ ${#ORPHAN_EC2[@]} -gt 0 ]]; then
  echo "  Waiting for instances to terminate..."
  for inst_id in "${ORPHAN_EC2[@]}"; do
    aws ec2 wait instance-terminated --instance-ids "$inst_id" --region "$REGION" 2>&1 || echo "  WARN  Wait timed out for $inst_id"
  done
fi

# =============================================================================
# Step 3: ECS — drain services, then delete cluster
# =============================================================================
for cluster_arn in "${ORPHAN_ECS_CLUSTERS[@]}"; do
  echo ""
  echo "--- Cleaning ECS cluster ${cluster_arn##*/} ---"
  SERVICES=$(aws ecs list-services --cluster "$cluster_arn" --region "$REGION" \
    --query "serviceArns" --output text 2>/dev/null || echo "")
  for svc in $SERVICES; do
    [[ -z "$svc" || "$svc" == "None" ]] && continue
    try_delete "Scale down ECS service" \
      aws ecs update-service --cluster "$cluster_arn" --service "$svc" --desired-count 0 --region "$REGION"
    try_delete "Delete ECS service" \
      aws ecs delete-service --cluster "$cluster_arn" --service "$svc" --force --region "$REGION"
  done
  TASK_DEFS=$(aws ecs list-task-definitions --region "$REGION" \
    --family-prefix "${cluster_arn##*/}" \
    --query "taskDefinitionArns" --output text 2>/dev/null || echo "")
  for td in $TASK_DEFS; do
    [[ -z "$td" || "$td" == "None" ]] && continue
    try_delete "Deregister task def ${td##*/}" \
      aws ecs deregister-task-definition --task-definition "$td" --region "$REGION"
  done
  try_delete "Delete ECS cluster ${cluster_arn##*/}" \
    aws ecs delete-cluster --cluster "$cluster_arn" --region "$REGION"
done

# =============================================================================
# Step 4: Lambda functions (delete before VPC/ENI cleanup)
# =============================================================================
for func in "${ORPHAN_LAMBDAS[@]}"; do
  # Function URL may not exist, that's fine
  aws lambda delete-function-url-config --function-name "$func" --region "$REGION" 2>/dev/null || true
  try_delete "Delete Lambda $func" \
    aws lambda delete-function --function-name "$func" --region "$REGION"
done

# =============================================================================
# Step 5: API Gateways
# =============================================================================
for api_id in "${ORPHAN_APIGWS[@]}"; do
  try_delete "Delete API Gateway $api_id" \
    aws apigatewayv2 delete-api --api-id "$api_id" --region "$REGION"
done

# =============================================================================
# Step 6: RDS (takes a long time)
# =============================================================================
for db_id in "${ORPHAN_RDS[@]}"; do
  echo ""
  echo "--- Deleting RDS $db_id ---"
  try_delete "Disable RDS deletion protection" \
    aws rds modify-db-instance --db-instance-identifier "$db_id" \
      --no-deletion-protection --apply-immediately --region "$REGION"
  echo "  Waiting 10s for modification to apply..."
  sleep 10
  try_delete "Delete RDS instance $db_id" \
    aws rds delete-db-instance --db-instance-identifier "$db_id" \
      --skip-final-snapshot --region "$REGION"
done

# =============================================================================
# Step 7: Load Balancers (listeners first)
# =============================================================================
for alb_arn in "${ORPHAN_ALBS[@]}"; do
  echo ""
  echo "--- Deleting ALB ---"
  LISTENERS=$(aws elbv2 describe-listeners --load-balancer-arn "$alb_arn" --region "$REGION" \
    --query "Listeners[*].ListenerArn" --output text 2>/dev/null || echo "")
  for listener in $LISTENERS; do
    [[ -z "$listener" || "$listener" == "None" ]] && continue
    try_delete "Delete ALB listener" \
      aws elbv2 delete-listener --listener-arn "$listener" --region "$REGION"
  done
  try_delete "Delete ALB ${alb_arn##*/}" \
    aws elbv2 delete-load-balancer --load-balancer-arn "$alb_arn" --region "$REGION"
done
for tg_arn in "${ORPHAN_TGS[@]}"; do
  try_delete "Delete target group" \
    aws elbv2 delete-target-group --target-group-arn "$tg_arn" --region "$REGION"
done

# =============================================================================
# Step 8: NAT Gateways (must delete before EIPs and subnets)
# =============================================================================
for nat_id in "${ORPHAN_NATS[@]}"; do
  try_delete "Delete NAT Gateway $nat_id" \
    aws ec2 delete-nat-gateway --nat-gateway-id "$nat_id" --region "$REGION"
done
if [[ ${#ORPHAN_NATS[@]} -gt 0 ]]; then
  echo "  Waiting 90s for NAT gateways to fully delete..."
  sleep 90
fi

# =============================================================================
# Step 9: VPC Endpoints
# =============================================================================
if [[ ${#ORPHAN_VPCE[@]} -gt 0 ]]; then
  try_delete "Delete ${#ORPHAN_VPCE[@]} VPC Endpoints" \
    aws ec2 delete-vpc-endpoints --vpc-endpoint-ids "${ORPHAN_VPCE[@]}" --region "$REGION"
  sleep 10
fi

# =============================================================================
# Step 10: Elastic IPs
# =============================================================================
for alloc_id in "${ORPHAN_EIPS[@]}"; do
  ASSOC=$(aws ec2 describe-addresses --allocation-ids "$alloc_id" --region "$REGION" \
    --query "Addresses[0].AssociationId" --output text 2>/dev/null || echo "None")
  if is_valid "$ASSOC"; then
    try_delete "Disassociate EIP $alloc_id" \
      aws ec2 disassociate-address --association-id "$ASSOC" --region "$REGION"
    sleep 2
  fi
  try_delete "Release EIP $alloc_id" \
    aws ec2 release-address --allocation-id "$alloc_id" --region "$REGION"
done

# =============================================================================
# Step 11: Network Interfaces (detach + delete, with retries)
# =============================================================================
if [[ ${#ORPHAN_ENIS[@]} -gt 0 ]]; then
  echo ""
  echo "--- Deleting Network Interfaces (${#ORPHAN_ENIS[@]} ENIs, with retries) ---"

  for attempt in 1 2 3; do
    REMAINING=()
    for eni_id in "${ORPHAN_ENIS[@]}"; do
      # Check if ENI still exists
      ENI_STATUS=$(aws ec2 describe-network-interfaces --network-interface-ids "$eni_id" --region "$REGION" \
        --query "NetworkInterfaces[0].Status" --output text 2>&1) || { echo "  OK    ENI $eni_id already gone"; continue; }

      # Detach if attached
      ATTACH=$(aws ec2 describe-network-interfaces --network-interface-ids "$eni_id" --region "$REGION" \
        --query "NetworkInterfaces[0].Attachment.AttachmentId" --output text 2>/dev/null || echo "None")
      if is_valid "$ATTACH"; then
        echo "  Detaching ENI $eni_id (attachment=$ATTACH, status=$ENI_STATUS)..."
        aws ec2 detach-network-interface --attachment-id "$ATTACH" --force --region "$REGION" 2>&1 || true
        sleep 5
      fi

      # Try to delete
      DEL_OUTPUT=$(aws ec2 delete-network-interface --network-interface-id "$eni_id" --region "$REGION" 2>&1)
      if [[ $? -eq 0 ]]; then
        echo "  OK    Deleted ENI $eni_id"
        ((OK_COUNT++)) || true
      else
        echo "  FAIL  ENI $eni_id: $DEL_OUTPUT"
        REMAINING+=("$eni_id")
        ((FAIL_COUNT++)) || true
      fi
    done
    if [[ ${#REMAINING[@]} -eq 0 ]]; then
      echo "  All ENIs deleted."
      break
    fi
    if [[ $attempt -lt 3 ]]; then
      echo "  ${#REMAINING[@]} ENIs still blocked. Waiting 30s before retry $((attempt+1))..."
      sleep 30
      ORPHAN_ENIS=("${REMAINING[@]}")
    else
      echo "  WARNING: ${#REMAINING[@]} ENIs could not be deleted after 3 attempts:"
      printf "    %s\n" "${REMAINING[@]}"
    fi
  done
fi

# =============================================================================
# Step 12: WAF Web ACLs
# =============================================================================
for waf_entry in "${ORPHAN_WAFS[@]}"; do
  IFS=':' read -r waf_id waf_name waf_arn <<< "$waf_entry"
  LOCK_TOKEN=$(aws wafv2 get-web-acl --name "$waf_name" --scope REGIONAL --id "$waf_id" \
    --region "$REGION" --query "LockToken" --output text 2>/dev/null || echo "")
  if is_valid "$LOCK_TOKEN"; then
    try_delete "Delete WAF $waf_name" \
      aws wafv2 delete-web-acl --name "$waf_name" --scope REGIONAL --id "$waf_id" \
        --lock-token "$LOCK_TOKEN" --region "$REGION"
  else
    echo "  FAIL  Could not get lock token for WAF $waf_name"
    ((FAIL_COUNT++)) || true
  fi
done

# =============================================================================
# Step 13: Network ACLs
# =============================================================================
for nacl_id in "${ORPHAN_NACLS[@]}"; do
  try_delete "Delete NACL $nacl_id" \
    aws ec2 delete-network-acl --network-acl-id "$nacl_id" --region "$REGION"
done

# =============================================================================
# Step 14: Security Groups — clear rules first, then delete
# =============================================================================
if [[ ${#ORPHAN_SGS[@]} -gt 0 ]]; then
  echo ""
  echo "--- Clearing security group rules (${#ORPHAN_SGS[@]} SGs) ---"
  for sg_id in "${ORPHAN_SGS[@]}"; do
    # Check if SG still exists
    SG_CHECK=$(aws ec2 describe-security-groups --group-ids "$sg_id" --region "$REGION" 2>&1) || {
      echo "  OK    SG $sg_id already gone"
      continue
    }

    INGRESS=$(echo "$SG_CHECK" | python3 -c "import sys,json; print(json.dumps(json.load(sys.stdin)['SecurityGroups'][0].get('IpPermissions',[])))" 2>/dev/null || echo "[]")
    if [[ "$INGRESS" != "[]" ]]; then
      try_delete "Revoke ingress on $sg_id" \
        aws ec2 revoke-security-group-ingress --group-id "$sg_id" \
          --ip-permissions "$INGRESS" --region "$REGION"
    fi
    EGRESS=$(echo "$SG_CHECK" | python3 -c "import sys,json; print(json.dumps(json.load(sys.stdin)['SecurityGroups'][0].get('IpPermissionsEgress',[])))" 2>/dev/null || echo "[]")
    if [[ "$EGRESS" != "[]" ]]; then
      try_delete "Revoke egress on $sg_id" \
        aws ec2 revoke-security-group-egress --group-id "$sg_id" \
          --ip-permissions "$EGRESS" --region "$REGION"
    fi
  done

  echo ""
  echo "--- Deleting security groups ---"
  for sg_id in "${ORPHAN_SGS[@]}"; do
    try_delete "Delete SG $sg_id" \
      aws ec2 delete-security-group --group-id "$sg_id" --region "$REGION"
  done
fi

# =============================================================================
# Step 15: Route Tables
# =============================================================================
for rt_id in "${ORPHAN_RTS[@]}"; do
  ASSOCS=$(aws ec2 describe-route-tables --route-table-ids "$rt_id" --region "$REGION" \
    --query "RouteTables[0].Associations[?!Main].RouteTableAssociationId" --output text 2>/dev/null || echo "")
  for assoc in $ASSOCS; do
    [[ -z "$assoc" || "$assoc" == "None" ]] && continue
    try_delete "Disassociate route table $rt_id" \
      aws ec2 disassociate-route-table --association-id "$assoc" --region "$REGION"
  done
  try_delete "Delete route table $rt_id" \
    aws ec2 delete-route-table --route-table-id "$rt_id" --region "$REGION"
done

# =============================================================================
# Step 16: Subnets
# =============================================================================
for subnet_id in "${ORPHAN_SUBNETS[@]}"; do
  try_delete "Delete subnet $subnet_id" \
    aws ec2 delete-subnet --subnet-id "$subnet_id" --region "$REGION"
done

# =============================================================================
# Step 17: Internet Gateways
# =============================================================================
for i in "${!ORPHAN_IGWS[@]}"; do
  igw_id="${ORPHAN_IGWS[$i]}"
  vpc_id="${ORPHAN_IGW_VPCS[$i]}"
  if is_valid "$vpc_id" && [[ "$vpc_id" != "detached" ]]; then
    try_delete "Detach IGW $igw_id from $vpc_id" \
      aws ec2 detach-internet-gateway --internet-gateway-id "$igw_id" --vpc-id "$vpc_id" --region "$REGION"
  fi
  try_delete "Delete IGW $igw_id" \
    aws ec2 delete-internet-gateway --internet-gateway-id "$igw_id" --region "$REGION"
done

# =============================================================================
# Step 18: Delete orphan VPCs
# =============================================================================
for vpc_id in "${ORPHAN_VPCS[@]}"; do
  echo ""
  echo "--- Deleting VPC $vpc_id ---"
  DEL_OUT=$(aws ec2 delete-vpc --vpc-id "$vpc_id" --region "$REGION" 2>&1)
  if [[ $? -eq 0 ]]; then
    echo "  OK    Deleted VPC $vpc_id"
    ((OK_COUNT++)) || true
  else
    echo "  FAIL  VPC $vpc_id: $DEL_OUT"
    ((FAIL_COUNT++)) || true
    echo "  Checking remaining dependencies..."
    aws ec2 describe-network-interfaces --region "$REGION" \
      --filters "Name=vpc-id,Values=$vpc_id" \
      --query "NetworkInterfaces[*].[NetworkInterfaceId, InterfaceType, Status, Description]" \
      --output table 2>/dev/null || true
    aws ec2 describe-security-groups --region "$REGION" \
      --filters "Name=vpc-id,Values=$vpc_id" \
      --query "SecurityGroups[?GroupName!='default'].[GroupId, GroupName]" \
      --output table 2>/dev/null || true
  fi
done

# =============================================================================
# Step 19: RDS Subnet Groups + Parameter Groups
# =============================================================================
for sg_name in "${ORPHAN_DB_SUBNET_GROUPS[@]}"; do
  try_delete "Delete DB subnet group $sg_name" \
    aws rds delete-db-subnet-group --db-subnet-group-name "$sg_name" --region "$REGION"
done
for pg_name in "${ORPHAN_DB_PARAM_GROUPS[@]}"; do
  try_delete "Delete DB parameter group $pg_name" \
    aws rds delete-db-parameter-group --db-parameter-group-name "$pg_name" --region "$REGION"
done

# =============================================================================
# Step 20: ECR Repositories
# =============================================================================
for repo in "${ORPHAN_ECR[@]}"; do
  try_delete "Delete ECR repo $repo" \
    aws ecr delete-repository --repository-name "$repo" --force --region "$REGION"
done

# =============================================================================
# Step 21: S3 Buckets (empty all versions, then delete)
# =============================================================================
for bucket in "${ORPHAN_BUCKETS[@]}"; do
  echo ""
  echo "--- Emptying and deleting S3 bucket $bucket ---"
  if ! aws s3api head-bucket --bucket "$bucket" 2>/dev/null; then
    echo "  SKIP  Bucket does not exist"
    continue
  fi

  # Delete all object versions
  while true; do
    VERSIONS=$(aws s3api list-object-versions --bucket "$bucket" --max-items 1000 \
      --query '{Objects: Versions[].{Key:Key,VersionId:VersionId}}' --output json 2>&1)
    if [[ $? -ne 0 ]]; then echo "  FAIL  list-object-versions: $VERSIONS"; break; fi
    COUNT=$(echo "$VERSIONS" | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d.get('Objects') or []))" 2>/dev/null || echo "0")
    if [[ "$COUNT" == "0" ]]; then break; fi
    echo "  Deleting $COUNT object versions..."
    DEL_OUT=$(aws s3api delete-objects --bucket "$bucket" --delete "$VERSIONS" 2>&1)
    [[ $? -ne 0 ]] && echo "  FAIL  delete-objects: $DEL_OUT"
  done

  # Delete all delete markers
  while true; do
    MARKERS=$(aws s3api list-object-versions --bucket "$bucket" --max-items 1000 \
      --query '{Objects: DeleteMarkers[].{Key:Key,VersionId:VersionId}}' --output json 2>&1)
    if [[ $? -ne 0 ]]; then echo "  FAIL  list delete markers: $MARKERS"; break; fi
    COUNT=$(echo "$MARKERS" | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d.get('Objects') or []))" 2>/dev/null || echo "0")
    if [[ "$COUNT" == "0" ]]; then break; fi
    echo "  Deleting $COUNT delete markers..."
    DEL_OUT=$(aws s3api delete-objects --bucket "$bucket" --delete "$MARKERS" 2>&1)
    [[ $? -ne 0 ]] && echo "  FAIL  delete-markers: $DEL_OUT"
  done

  try_delete "Delete S3 bucket $bucket" aws s3 rb "s3://$bucket"
done

# =============================================================================
# Step 22: Secrets Manager
# =============================================================================
for secret in "${ORPHAN_SECRETS[@]}"; do
  try_delete "Delete secret $secret" \
    aws secretsmanager delete-secret --secret-id "$secret" \
      --force-delete-without-recovery --region "$REGION"
done

# =============================================================================
# Step 23: KMS Keys (schedule for deletion)
# =============================================================================
for key_id in "${ORPHAN_KMS_KEYS[@]}"; do
  try_delete "Schedule KMS key $key_id for deletion" \
    aws kms schedule-key-deletion --key-id "$key_id" \
      --pending-window-in-days 7 --region "$REGION"
done

# =============================================================================
# Step 24: IAM Roles, Profiles, Policies
# =============================================================================
for role in "${ORPHAN_ROLES[@]}"; do
  echo "  Cleaning IAM role $role..."
  # Detach managed policies
  POLICIES=$(aws iam list-attached-role-policies --role-name "$role" \
    --query "AttachedPolicies[*].PolicyArn" --output text 2>/dev/null || echo "")
  for policy_arn in $POLICIES; do
    [[ -z "$policy_arn" || "$policy_arn" == "None" ]] && continue
    try_delete "Detach policy from $role" \
      aws iam detach-role-policy --role-name "$role" --policy-arn "$policy_arn"
  done
  # Delete inline policies
  INLINE=$(aws iam list-role-policies --role-name "$role" \
    --query "PolicyNames" --output text 2>/dev/null || echo "")
  for pol in $INLINE; do
    [[ -z "$pol" || "$pol" == "None" ]] && continue
    try_delete "Delete inline policy $pol from $role" \
      aws iam delete-role-policy --role-name "$role" --policy-name "$pol"
  done
  # Remove from instance profiles
  PROFILES=$(aws iam list-instance-profiles-for-role --role-name "$role" \
    --query "InstanceProfiles[*].InstanceProfileName" --output text 2>/dev/null || echo "")
  for prof in $PROFILES; do
    [[ -z "$prof" || "$prof" == "None" ]] && continue
    try_delete "Remove $role from profile $prof" \
      aws iam remove-role-from-instance-profile --role-name "$role" --instance-profile-name "$prof"
  done
  try_delete "Delete IAM role $role" \
    aws iam delete-role --role-name "$role"
done

for prof in "${ORPHAN_PROFILES[@]}"; do
  try_delete "Delete instance profile $prof" \
    aws iam delete-instance-profile --instance-profile-name "$prof"
done

for policy_arn in "${ORPHAN_POLICIES[@]}"; do
  echo "  Cleaning IAM policy $policy_arn..."
  ENTITIES=$(aws iam list-entities-for-policy --policy-arn "$policy_arn" \
    --query "[PolicyRoles[*].RoleName, PolicyUsers[*].UserName, PolicyGroups[*].GroupName]" \
    --output json 2>/dev/null || echo "[[],[],[]]")
  ROLES_LIST=$(echo "$ENTITIES" | python3 -c "import sys,json; print(' '.join(json.load(sys.stdin)[0]))" 2>/dev/null || echo "")
  for r in $ROLES_LIST; do
    try_delete "Detach policy from role $r" \
      aws iam detach-role-policy --role-name "$r" --policy-arn "$policy_arn"
  done
  VERSIONS=$(aws iam list-policy-versions --policy-arn "$policy_arn" \
    --query "Versions[?!IsDefaultVersion].VersionId" --output text 2>/dev/null || echo "")
  for v in $VERSIONS; do
    [[ -z "$v" || "$v" == "None" ]] && continue
    try_delete "Delete policy version $v" \
      aws iam delete-policy-version --policy-arn "$policy_arn" --version-id "$v"
  done
  try_delete "Delete IAM policy" \
    aws iam delete-policy --policy-arn "$policy_arn"
done

# =============================================================================
# Step 25: SNS Topics
# =============================================================================
for topic_arn in "${ORPHAN_SNS[@]}"; do
  try_delete "Delete SNS topic ${topic_arn##*:}" \
    aws sns delete-topic --topic-arn "$topic_arn" --region "$REGION"
done

# =============================================================================
# Step 26: CloudWatch Log Groups
# =============================================================================
for lg in "${ORPHAN_LOG_GROUPS[@]}"; do
  try_delete "Delete log group $lg" \
    aws logs delete-log-group --log-group-name "$lg" --region "$REGION"
done

# =============================================================================
# Step 27: CloudWatch Alarms
# =============================================================================
if [[ ${#ORPHAN_ALARMS[@]} -gt 0 ]]; then
  try_delete "Delete ${#ORPHAN_ALARMS[@]} CloudWatch alarms" \
    aws cloudwatch delete-alarms --alarm-names "${ORPHAN_ALARMS[@]}" --region "$REGION"
fi

# =============================================================================
# Step 28: CloudWatch Dashboards
# =============================================================================
for dash in "${ORPHAN_DASHBOARDS[@]}"; do
  try_delete "Delete dashboard $dash" \
    aws cloudwatch delete-dashboards --dashboard-names "$dash" --region "$REGION"
done

# =============================================================================
# Step 29: ACM Certificates
# =============================================================================
for cert_entry in "${ORPHAN_CERTS[@]}"; do
  # Entry format: region:arn:aws:acm:region:account:certificate/id
  # Split on first colon only
  cert_region="${cert_entry%%:*}"
  cert_arn="${cert_entry#*:}"
  try_delete "Delete ACM cert in $cert_region" \
    aws acm delete-certificate --certificate-arn "$cert_arn" --region "$cert_region"
done

# =============================================================================
# Step 30: CloudFront (attempt deletion)
# =============================================================================
for cf_id in "${ORPHAN_CFS[@]}"; do
  ETAG=$(aws cloudfront get-distribution --id "$cf_id" \
    --query "ETag" --output text 2>/dev/null || echo "")
  if is_valid "$ETAG"; then
    DEL_OUT=$(aws cloudfront delete-distribution --id "$cf_id" --if-match "$ETAG" 2>&1)
    if [[ $? -eq 0 ]]; then
      echo "  OK    Deleted CloudFront $cf_id"
      ((OK_COUNT++)) || true
    else
      echo "  FAIL  CloudFront $cf_id (may still be disabling): $DEL_OUT"
      echo "        Retry later:"
      echo "          ETAG=\$(aws cloudfront get-distribution --id $cf_id --query ETag --output text)"
      echo "          aws cloudfront delete-distribution --id $cf_id --if-match \$ETAG"
      ((FAIL_COUNT++)) || true
    fi
  fi
done

# =============================================================================
# Step 31: DynamoDB stale lock entries
# =============================================================================
echo ""
echo "--- Cleaning DynamoDB lock entries ---"
for KEY in \
  "cliniaacian-prod-terraform-state/cliniaacian/prod/terraform.tfstate-md5" \
  "cliniaacian-prod-terraform-state/cliniaacian/prod/terraform.tfstate" \
  "cliniaccian-prod-terraform-state/cliniaacian/prod/terraform.tfstate-md5" \
  "cliniaccian-prod-terraform-state/cliniaacian/prod/terraform.tfstate"; do
  try_delete "Delete DynamoDB lock entry" \
    aws dynamodb delete-item \
      --table-name terraform-state-lock \
      --key "{\"LockID\":{\"S\":\"${KEY}\"}}" \
      --region "$REGION"
done

# =============================================================================
# Step 32: Wait for RDS, retry dependent resources
# =============================================================================
if [[ ${#ORPHAN_RDS[@]} -gt 0 ]]; then
  echo ""
  echo "--- Waiting for RDS instances to finish deleting ---"
  for db_id in "${ORPHAN_RDS[@]}"; do
    echo "  Waiting for $db_id..."
    aws rds wait db-instance-deleted --db-instance-identifier "$db_id" --region "$REGION" 2>&1 || echo "  WARN  Wait timed out for $db_id"
  done
  for sg_name in "${ORPHAN_DB_SUBNET_GROUPS[@]}"; do
    try_delete "Retry DB subnet group $sg_name" \
      aws rds delete-db-subnet-group --db-subnet-group-name "$sg_name" --region "$REGION"
  done
  for pg_name in "${ORPHAN_DB_PARAM_GROUPS[@]}"; do
    try_delete "Retry DB parameter group $pg_name" \
      aws rds delete-db-parameter-group --db-parameter-group-name "$pg_name" --region "$REGION"
  done
fi

# =============================================================================
# Step 33: Route 53 (informational only)
# =============================================================================
echo ""
echo "--- Route 53 ---"
OLD_ZONE=$(aws route53 list-hosted-zones-by-name --dns-name "cliniaacian.com" \
  --query "HostedZones[?Name=='cliniaacian.com.'].Id" --output text 2>/dev/null || echo "None")
if is_valid "$OLD_ZONE"; then
  echo "  Old hosted zone for cliniaacian.com still exists: $OLD_ZONE"
  echo "  Delete manually if no longer needed:"
  echo "    aws route53 delete-hosted-zone --id $OLD_ZONE"
fi

# =============================================================================
# Final report
# =============================================================================
echo ""
echo "============================================================"
echo "  CLEANUP COMPLETE"
echo "============================================================"
echo ""
echo "  Successful:  $OK_COUNT"
echo "  Failed:      $FAIL_COUNT"
echo ""
if [[ $FAIL_COUNT -gt 0 ]]; then
  echo "  Some deletions failed! Scroll up and look for 'FAIL' lines"
  echo "  to see the error messages from AWS."
  echo ""
  echo "  Common causes:"
  echo "    - DependencyViolation: Another resource still references this one"
  echo "    - ENI in use: Lambda/ECS ENIs take 5-20 min to release after deletion"
  echo "    - DeleteConflict: IAM resource still attached somewhere"
  echo ""
  echo "  Re-run this script to retry failed deletions."
fi
echo ""
echo "  Run with --dry-run to verify everything is cleaned up."
echo ""
