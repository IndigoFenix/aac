#!/bin/bash
# =============================================================================
# Import existing AWS resources into fresh Terraform state
# =============================================================================
# This script discovers existing resources by name/tag and imports them.
# It's idempotent — already-imported resources are skipped.
# Run from the terraform/ directory after `terraform init`.
# =============================================================================

set -euo pipefail

PREFIX="cliniaacian-prod"
REGION="${AWS_REGION:-il-central-1}"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)

echo "=== Importing existing resources ==="
echo "Prefix: $PREFIX"
echo "Region: $REGION"
echo "Account: $ACCOUNT_ID"

# Helper: import a resource, skip if already in state or not found in AWS
tf_import() {
  local addr="$1"
  local id="$2"

  if [ -z "$id" ] || [ "$id" = "None" ] || [ "$id" = "null" ]; then
    echo "SKIP $addr (not found in AWS)"
    return 0
  fi

  if terraform state show "$addr" &>/dev/null; then
    echo "SKIP $addr (already in state)"
    return 0
  fi

  echo "IMPORT $addr = $id"
  terraform import "$addr" "$id" || echo "WARN: Failed to import $addr"
}

# =============================================================================
# KMS
# =============================================================================
echo "--- KMS ---"
KMS_KEY_ID=$(aws kms list-aliases --region "$REGION" \
  --query "Aliases[?AliasName=='alias/${PREFIX}'].TargetKeyId | [0]" --output text 2>/dev/null || echo "")
tf_import "aws_kms_key.main" "$KMS_KEY_ID"
tf_import "aws_kms_alias.main" "alias/${PREFIX}"

# =============================================================================
# VPC
# =============================================================================
echo "--- VPC ---"
VPC_ID=$(aws ec2 describe-vpcs --region "$REGION" \
  --filters "Name=tag:Name,Values=${PREFIX}-vpc" \
  --query "Vpcs[0].VpcId" --output text 2>/dev/null || echo "")
tf_import "aws_vpc.main" "$VPC_ID"

# Internet Gateway
IGW_ID=$(aws ec2 describe-internet-gateways --region "$REGION" \
  --filters "Name=tag:Name,Values=${PREFIX}-igw" \
  --query "InternetGateways[0].InternetGatewayId" --output text 2>/dev/null || echo "")
tf_import "aws_internet_gateway.main" "$IGW_ID"

# Subnets
AZS=($(aws ec2 describe-availability-zones --region "$REGION" \
  --query "AvailabilityZones[?State=='available'].ZoneName | [:2]" --output text 2>/dev/null))

for i in 0 1; do
  AZ="${AZS[$i]:-}"
  if [ -n "$AZ" ]; then
    PUB_SUBNET=$(aws ec2 describe-subnets --region "$REGION" \
      --filters "Name=tag:Name,Values=${PREFIX}-public-${AZ}" "Name=vpc-id,Values=${VPC_ID}" \
      --query "Subnets[0].SubnetId" --output text 2>/dev/null || echo "")
    tf_import "aws_subnet.public[$i]" "$PUB_SUBNET"

    PRIV_SUBNET=$(aws ec2 describe-subnets --region "$REGION" \
      --filters "Name=tag:Name,Values=${PREFIX}-private-${AZ}" "Name=vpc-id,Values=${VPC_ID}" \
      --query "Subnets[0].SubnetId" --output text 2>/dev/null || echo "")
    tf_import "aws_subnet.private[$i]" "$PRIV_SUBNET"
  fi
done

# NAT Gateway (single_nat_gateway=true, so just one)
NAT_GW_ID=$(aws ec2 describe-nat-gateways --region "$REGION" \
  --filter "Name=tag:Name,Values=${PREFIX}-nat-*" "Name=state,Values=available" \
  --query "NatGateways[0].NatGatewayId" --output text 2>/dev/null || echo "")
tf_import "aws_nat_gateway.main[0]" "$NAT_GW_ID"

# EIP for NAT
EIP_ALLOC=$(aws ec2 describe-addresses --region "$REGION" \
  --filters "Name=tag:Name,Values=${PREFIX}-nat-eip-0" \
  --query "Addresses[0].AllocationId" --output text 2>/dev/null || echo "")
tf_import "aws_eip.nat[0]" "$EIP_ALLOC"

# Route Tables
PUB_RT=$(aws ec2 describe-route-tables --region "$REGION" \
  --filters "Name=tag:Name,Values=${PREFIX}-public-rt" "Name=vpc-id,Values=${VPC_ID}" \
  --query "RouteTables[0].RouteTableId" --output text 2>/dev/null || echo "")
tf_import "aws_route_table.public" "$PUB_RT"

for i in 0 1; do
  AZ="${AZS[$i]:-}"
  if [ -n "$AZ" ]; then
    PRIV_RT=$(aws ec2 describe-route-tables --region "$REGION" \
      --filters "Name=tag:Name,Values=${PREFIX}-private-rt-${AZ}" "Name=vpc-id,Values=${VPC_ID}" \
      --query "RouteTables[0].RouteTableId" --output text 2>/dev/null || echo "")
    tf_import "aws_route_table.private[$i]" "$PRIV_RT"

    # Route table associations
    PUB_SUBNET=$(aws ec2 describe-subnets --region "$REGION" \
      --filters "Name=tag:Name,Values=${PREFIX}-public-${AZ}" "Name=vpc-id,Values=${VPC_ID}" \
      --query "Subnets[0].SubnetId" --output text 2>/dev/null || echo "")
    if [ -n "$PUB_RT" ] && [ "$PUB_RT" != "None" ] && [ -n "$PUB_SUBNET" ] && [ "$PUB_SUBNET" != "None" ]; then
      PUB_ASSOC=$(aws ec2 describe-route-tables --region "$REGION" \
        --route-table-ids "$PUB_RT" \
        --query "RouteTables[0].Associations[?SubnetId=='${PUB_SUBNET}'].RouteTableAssociationId | [0]" \
        --output text 2>/dev/null || echo "")
      tf_import "aws_route_table_association.public[$i]" "$PUB_ASSOC"
    fi

    PRIV_SUBNET=$(aws ec2 describe-subnets --region "$REGION" \
      --filters "Name=tag:Name,Values=${PREFIX}-private-${AZ}" "Name=vpc-id,Values=${VPC_ID}" \
      --query "Subnets[0].SubnetId" --output text 2>/dev/null || echo "")
    if [ -n "$PRIV_RT" ] && [ "$PRIV_RT" != "None" ] && [ -n "$PRIV_SUBNET" ] && [ "$PRIV_SUBNET" != "None" ]; then
      PRIV_ASSOC=$(aws ec2 describe-route-tables --region "$REGION" \
        --route-table-ids "$PRIV_RT" \
        --query "RouteTables[0].Associations[?SubnetId=='${PRIV_SUBNET}'].RouteTableAssociationId | [0]" \
        --output text 2>/dev/null || echo "")
      tf_import "aws_route_table_association.private[$i]" "$PRIV_ASSOC"
    fi
  fi
done

# S3 Gateway Endpoint
S3_ENDPOINT=$(aws ec2 describe-vpc-endpoints --region "$REGION" \
  --filters "Name=tag:Name,Values=${PREFIX}-s3-endpoint" "Name=vpc-id,Values=${VPC_ID}" \
  --query "VpcEndpoints[0].VpcEndpointId" --output text 2>/dev/null || echo "")
tf_import "aws_vpc_endpoint.s3" "$S3_ENDPOINT"

# =============================================================================
# Security Groups
# =============================================================================
echo "--- Security Groups ---"
for sg_suffix in alb ecs rds redis bastion lambda; do
  SG_ID=$(aws ec2 describe-security-groups --region "$REGION" \
    --filters "Name=tag:Name,Values=${PREFIX}-${sg_suffix}-sg" "Name=vpc-id,Values=${VPC_ID}" \
    --query "SecurityGroups[0].GroupId" --output text 2>/dev/null || echo "")
  if [ "$sg_suffix" = "lambda" ]; then
    tf_import "aws_security_group.${sg_suffix}[0]" "$SG_ID"
  else
    tf_import "aws_security_group.${sg_suffix}" "$SG_ID"
  fi
done

# =============================================================================
# S3 Buckets
# =============================================================================
echo "--- S3 Buckets ---"
UPLOADS_BUCKET="${PREFIX}-uploads-${ACCOUNT_ID}"
if aws s3api head-bucket --bucket "$UPLOADS_BUCKET" 2>/dev/null; then
  tf_import "aws_s3_bucket.uploads" "$UPLOADS_BUCKET"
  tf_import "aws_s3_bucket_versioning.uploads" "$UPLOADS_BUCKET"
  tf_import "aws_s3_bucket_server_side_encryption_configuration.uploads" "$UPLOADS_BUCKET"
  tf_import "aws_s3_bucket_public_access_block.uploads" "$UPLOADS_BUCKET"
  tf_import "aws_s3_bucket_logging.uploads" "$UPLOADS_BUCKET"
  tf_import "aws_s3_bucket_cors_configuration.uploads" "$UPLOADS_BUCKET"
fi

LOGS_BUCKET="${PREFIX}-logs-${ACCOUNT_ID}"
if aws s3api head-bucket --bucket "$LOGS_BUCKET" 2>/dev/null; then
  tf_import "aws_s3_bucket.logs" "$LOGS_BUCKET"
  tf_import "aws_s3_bucket_versioning.logs" "$LOGS_BUCKET"
  tf_import "aws_s3_bucket_server_side_encryption_configuration.logs" "$LOGS_BUCKET"
  tf_import "aws_s3_bucket_public_access_block.logs" "$LOGS_BUCKET"
  tf_import "aws_s3_bucket_policy.logs" "$LOGS_BUCKET"
  tf_import "aws_s3_bucket_lifecycle_configuration.logs" "$LOGS_BUCKET"
fi

FRONTEND_BUCKET="${PREFIX}-frontend"
if aws s3api head-bucket --bucket "$FRONTEND_BUCKET" 2>/dev/null; then
  tf_import "aws_s3_bucket.frontend[0]" "$FRONTEND_BUCKET"
  tf_import "aws_s3_bucket_public_access_block.frontend[0]" "$FRONTEND_BUCKET"
  tf_import "aws_s3_bucket_versioning.frontend[0]" "$FRONTEND_BUCKET"
fi

# =============================================================================
# Secrets Manager
# =============================================================================
echo "--- Secrets Manager ---"
DB_SECRET_ARN=$(aws secretsmanager describe-secret --secret-id "${PREFIX}/database" --region "$REGION" \
  --query "ARN" --output text 2>/dev/null || echo "")
tf_import "aws_secretsmanager_secret.database" "$DB_SECRET_ARN"

APP_SECRET_ARN=$(aws secretsmanager describe-secret --secret-id "${PREFIX}/app-secrets" --region "$REGION" \
  --query "ARN" --output text 2>/dev/null || echo "")
tf_import "aws_secretsmanager_secret.app_secrets" "$APP_SECRET_ARN"

# Secret version (use AWSCURRENT)
if [ -n "$DB_SECRET_ARN" ] && [ "$DB_SECRET_ARN" != "None" ]; then
  DB_VERSION_ID=$(aws secretsmanager describe-secret --secret-id "${PREFIX}/database" --region "$REGION" \
    --query "VersionIdsToStages | keys(@) | [0]" --output text 2>/dev/null || echo "")
  if [ -n "$DB_VERSION_ID" ] && [ "$DB_VERSION_ID" != "None" ]; then
    tf_import "aws_secretsmanager_secret_version.database_generated" "${DB_SECRET_ARN}|${DB_VERSION_ID}"
  fi
fi

# =============================================================================
# RDS
# =============================================================================
echo "--- RDS ---"
RDS_ID="${PREFIX}-postgres"
RDS_EXISTS=$(aws rds describe-db-instances --db-instance-identifier "$RDS_ID" --region "$REGION" \
  --query "DBInstances[0].DBInstanceIdentifier" --output text 2>/dev/null || echo "")
if [ -n "$RDS_EXISTS" ] && [ "$RDS_EXISTS" != "None" ]; then
  tf_import "aws_db_instance.main" "$RDS_ID"
fi

tf_import "aws_db_subnet_group.main" "${PREFIX}-db-subnet-group"

# Parameter group — find by name prefix since family may vary
PG_NAME=$(aws rds describe-db-parameter-groups --region "$REGION" \
  --query "DBParameterGroups[?DBParameterGroupName=='${PREFIX}-pg-params'].DBParameterGroupName | [0]" \
  --output text 2>/dev/null || echo "")
tf_import "aws_db_parameter_group.main" "$PG_NAME"

# =============================================================================
# IAM Roles
# =============================================================================
echo "--- IAM Roles ---"
for role in github-actions ecs-task-execution ecs-task lambda-execution; do
  ROLE_NAME="${PREFIX}-${role}"
  ROLE_EXISTS=$(aws iam get-role --role-name "$ROLE_NAME" --query "Role.RoleName" --output text 2>/dev/null || echo "")
  if [ -n "$ROLE_EXISTS" ] && [ "$ROLE_EXISTS" != "None" ]; then
    if [ "$role" = "lambda-execution" ]; then
      tf_import "aws_iam_role.lambda_execution[0]" "$ROLE_NAME"
    elif [ "$role" = "github-actions" ]; then
      tf_import "aws_iam_role.github_actions" "$ROLE_NAME"
    elif [ "$role" = "ecs-task-execution" ]; then
      tf_import "aws_iam_role.ecs_task_execution" "$ROLE_NAME"
    elif [ "$role" = "ecs-task" ]; then
      tf_import "aws_iam_role.ecs_task" "$ROLE_NAME"
    fi
  fi
done

# IAM Role Policies (inline)
tf_import "aws_iam_role_policy.github_actions" "${PREFIX}-github-actions-role/${PREFIX}-github-actions-policy"
tf_import "aws_iam_role_policy.ecs_task_execution_secrets" "${PREFIX}-ecs-task-execution-role/${PREFIX}-ecs-secrets-policy"
tf_import "aws_iam_role_policy.ecs_task" "${PREFIX}-ecs-task-role/${PREFIX}-ecs-task-policy"
tf_import "aws_iam_role_policy.lambda_secrets[0]" "${PREFIX}-lambda-execution/${PREFIX}-lambda-secrets"
tf_import "aws_iam_role_policy.lambda_s3[0]" "${PREFIX}-lambda-execution/${PREFIX}-lambda-s3"
tf_import "aws_iam_role_policy.github_actions_lambda_phase1[0]" "${PREFIX}-github-actions-role/${PREFIX}-github-actions-lambda-phase1"

# IAM Role Policy Attachments
tf_import "aws_iam_role_policy_attachment.ecs_task_execution" "${PREFIX}-ecs-task-execution-role/arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
tf_import "aws_iam_role_policy_attachment.lambda_basic[0]" "${PREFIX}-lambda-execution/arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
tf_import "aws_iam_role_policy_attachment.lambda_vpc[0]" "${PREFIX}-lambda-execution/arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"

# =============================================================================
# ECR
# =============================================================================
echo "--- ECR ---"
ECR_MAIN=$(aws ecr describe-repositories --repository-names "cliniaacian" --region "$REGION" \
  --query "repositories[0].repositoryArn" --output text 2>/dev/null || echo "")
if [ -n "$ECR_MAIN" ] && [ "$ECR_MAIN" != "None" ]; then
  tf_import "aws_ecr_repository.main" "cliniaacian"
  tf_import "aws_ecr_lifecycle_policy.main" "cliniaacian"
fi

ECR_LAMBDA=$(aws ecr describe-repositories --repository-names "cliniaacian-lambda" --region "$REGION" \
  --query "repositories[0].repositoryArn" --output text 2>/dev/null || echo "")
if [ -n "$ECR_LAMBDA" ] && [ "$ECR_LAMBDA" != "None" ]; then
  tf_import "aws_ecr_repository.lambda[0]" "cliniaacian-lambda"
  tf_import "aws_ecr_lifecycle_policy.lambda[0]" "cliniaacian-lambda"
fi

# =============================================================================
# ECS
# =============================================================================
echo "--- ECS ---"
ECS_CLUSTER_ARN=$(aws ecs describe-clusters --clusters "${PREFIX}-cluster" --region "$REGION" \
  --query "clusters[?status=='ACTIVE'].clusterArn | [0]" --output text 2>/dev/null || echo "")
if [ -n "$ECS_CLUSTER_ARN" ] && [ "$ECS_CLUSTER_ARN" != "None" ]; then
  tf_import "aws_ecs_cluster.main" "$ECS_CLUSTER_ARN"

  # ECS Service
  SVC_ARN=$(aws ecs describe-services --cluster "${PREFIX}-cluster" --services "${PREFIX}-service" --region "$REGION" \
    --query "services[?status=='ACTIVE'].serviceArn | [0]" --output text 2>/dev/null || echo "")
  tf_import "aws_ecs_service.main" "${ECS_CLUSTER_ARN}/${PREFIX}-service"
fi

# ECS Task Definition
TASK_DEF_ARN=$(aws ecs describe-task-definition --task-definition "${PREFIX}-task" --region "$REGION" \
  --query "taskDefinition.taskDefinitionArn" --output text 2>/dev/null || echo "")
tf_import "aws_ecs_task_definition.main" "$TASK_DEF_ARN"

# Auto Scaling
tf_import "aws_appautoscaling_target.ecs" "service/${PREFIX}-cluster/${PREFIX}-service"
tf_import "aws_appautoscaling_policy.cpu" "service/${PREFIX}-cluster/${PREFIX}-service"
tf_import "aws_appautoscaling_policy.memory" "service/${PREFIX}-cluster/${PREFIX}-service"

# =============================================================================
# ALB
# =============================================================================
echo "--- ALB ---"
ALB_ARN=$(aws elbv2 describe-load-balancers --names "${PREFIX}-alb" --region "$REGION" \
  --query "LoadBalancers[0].LoadBalancerArn" --output text 2>/dev/null || echo "")
tf_import "aws_lb.main" "$ALB_ARN"

TG_ARN=$(aws elbv2 describe-target-groups --names "${PREFIX}-tg" --region "$REGION" \
  --query "TargetGroups[0].TargetGroupArn" --output text 2>/dev/null || echo "")
tf_import "aws_lb_target_group.main" "$TG_ARN"

if [ -n "$ALB_ARN" ] && [ "$ALB_ARN" != "None" ]; then
  HTTP_LISTENER_ARN=$(aws elbv2 describe-listeners --load-balancer-arn "$ALB_ARN" --region "$REGION" \
    --query "Listeners[?Port==\`80\`].ListenerArn | [0]" --output text 2>/dev/null || echo "")
  tf_import "aws_lb_listener.http" "$HTTP_LISTENER_ARN"
fi

# =============================================================================
# Lambda
# =============================================================================
echo "--- Lambda ---"
LAMBDA_NAME="${PREFIX}-api"
LAMBDA_EXISTS=$(aws lambda get-function --function-name "$LAMBDA_NAME" --region "$REGION" \
  --query "Configuration.FunctionName" --output text 2>/dev/null || echo "")
if [ -n "$LAMBDA_EXISTS" ] && [ "$LAMBDA_EXISTS" != "None" ]; then
  tf_import "aws_lambda_function.api[0]" "$LAMBDA_NAME"

  # Lambda permission for API Gateway
  tf_import "aws_lambda_permission.api_gateway[0]" "${LAMBDA_NAME}/AllowAPIGatewayInvoke" || true
fi

# =============================================================================
# API Gateway
# =============================================================================
echo "--- API Gateway ---"
APIGW_ID=$(aws apigatewayv2 get-apis --region "$REGION" \
  --query "Items[?Name=='${PREFIX}-api'].ApiId | [0]" --output text 2>/dev/null || echo "")
if [ -n "$APIGW_ID" ] && [ "$APIGW_ID" != "None" ]; then
  tf_import "aws_apigatewayv2_api.lambda[0]" "$APIGW_ID"
  tf_import 'aws_apigatewayv2_stage.lambda[0]' "${APIGW_ID}/\$default"

  INTEGRATION_ID=$(aws apigatewayv2 get-integrations --api-id "$APIGW_ID" --region "$REGION" \
    --query "Items[0].IntegrationId" --output text 2>/dev/null || echo "")
  tf_import "aws_apigatewayv2_integration.lambda[0]" "${APIGW_ID}/${INTEGRATION_ID}"

  ROUTE_ID=$(aws apigatewayv2 get-routes --api-id "$APIGW_ID" --region "$REGION" \
    --query "Items[0].RouteId" --output text 2>/dev/null || echo "")
  tf_import "aws_apigatewayv2_route.lambda[0]" "${APIGW_ID}/${ROUTE_ID}"
fi

# =============================================================================
# CloudFront
# =============================================================================
echo "--- CloudFront ---"
CF_ID=$(aws cloudfront list-distributions \
  --query "DistributionList.Items[?contains(Aliases.Items || [''], 'cliniaacian.com') || contains(Origins.Items[].Id, 'S3-frontend')].Id | [0]" \
  --output text 2>/dev/null || echo "")
# Fallback: search by tag
if [ -z "$CF_ID" ] || [ "$CF_ID" = "None" ]; then
  CF_ID=$(aws cloudfront list-distributions \
    --query "DistributionList.Items[?Comment!='' || Id!=''].{Id:Id,Origins:Origins.Items[*].DomainName}" \
    --output json 2>/dev/null | \
    python3 -c "
import sys, json
data = json.load(sys.stdin)
for d in (data or []):
  origins = d.get('Origins') or []
  for o in origins:
    if '${PREFIX}-frontend' in (o or ''):
      print(d['Id'])
      sys.exit()
" 2>/dev/null || echo "")
fi
tf_import "aws_cloudfront_distribution.frontend[0]" "$CF_ID"

# CloudFront OAC
OAC_ID=$(aws cloudfront list-origin-access-controls \
  --query "OriginAccessControlList.Items[?Name=='${PREFIX}-frontend-oac'].Id | [0]" \
  --output text 2>/dev/null || echo "")
tf_import "aws_cloudfront_origin_access_control.frontend[0]" "$OAC_ID"

# CloudFront Function
CF_FUNC_ARN=$(aws cloudfront list-functions \
  --query "FunctionList.Items[?Name=='${PREFIX}-aac-spa-rewrite'].FunctionMetadata.FunctionARN | [0]" \
  --output text 2>/dev/null || echo "")
if [ -n "$CF_FUNC_ARN" ] && [ "$CF_FUNC_ARN" != "None" ]; then
  tf_import "aws_cloudfront_function.aac_spa_rewrite[0]" "${PREFIX}-aac-spa-rewrite"
fi

# CloudFront S3 bucket policy (import by bucket name)
if [ -n "$CF_ID" ] && [ "$CF_ID" != "None" ]; then
  tf_import "aws_s3_bucket_policy.frontend[0]" "$FRONTEND_BUCKET"
fi

# =============================================================================
# ACM Certificates (us-east-1 for CloudFront)
# =============================================================================
echo "--- ACM Certificates ---"
# Note: Old cliniaacian.com cert will NOT match new aivota.ai domain.
# Terraform will create a new cert. We skip importing the old one.

# =============================================================================
# Route53 — domain records
# =============================================================================
echo "--- Route53 ---"
# The hosted zone for aivota.ai should exist (user created it).
# Old cliniaacian.com records won't match — Terraform will create new ones.
# Skip Route53 record imports since the domain is changing.

# =============================================================================
# CloudWatch Log Groups
# =============================================================================
echo "--- CloudWatch Log Groups ---"
for lg in "/ecs/${PREFIX}" "/aws/ecs/${PREFIX}/exec" "/aws/lambda/${PREFIX}-api"; do
  LG_EXISTS=$(aws logs describe-log-groups --log-group-name-prefix "$lg" --region "$REGION" \
    --query "logGroups[?logGroupName=='${lg}'].logGroupName | [0]" --output text 2>/dev/null || echo "")
  if [ -n "$LG_EXISTS" ] && [ "$LG_EXISTS" != "None" ]; then
    case "$lg" in
      "/ecs/${PREFIX}") tf_import "aws_cloudwatch_log_group.app" "$lg" ;;
      "/aws/ecs/${PREFIX}/exec") tf_import "aws_cloudwatch_log_group.ecs_exec" "$lg" ;;
      "/aws/lambda/${PREFIX}-api") tf_import "aws_cloudwatch_log_group.lambda[0]" "$lg" ;;
    esac
  fi
done

# =============================================================================
# CloudWatch Alarms
# =============================================================================
echo "--- CloudWatch Alarms ---"
tf_import "aws_cloudwatch_metric_alarm.db_cpu" "${PREFIX}-db-high-cpu"
tf_import "aws_cloudwatch_metric_alarm.db_storage" "${PREFIX}-db-low-storage"
tf_import "aws_cloudwatch_metric_alarm.db_connections" "${PREFIX}-db-high-connections"
tf_import "aws_cloudwatch_metric_alarm.failed_logins" "${PREFIX}-failed-logins"
tf_import "aws_cloudwatch_metric_alarm.lambda_errors[0]" "${PREFIX}-lambda-errors"
tf_import "aws_cloudwatch_metric_alarm.lambda_duration[0]" "${PREFIX}-lambda-duration"

# =============================================================================
# CloudWatch Dashboard
# =============================================================================
echo "--- CloudWatch Dashboards ---"
tf_import "aws_cloudwatch_dashboard.lambda[0]" "${PREFIX}-lambda-dashboard"

# =============================================================================
# SNS
# =============================================================================
echo "--- SNS ---"
SNS_ARN=$(aws sns list-topics --region "$REGION" \
  --query "Topics[?contains(TopicArn, '${PREFIX}-alerts')].TopicArn | [0]" --output text 2>/dev/null || echo "")
tf_import "aws_sns_topic.alerts" "$SNS_ARN"

# =============================================================================
# random_password — cannot import, Terraform will want to recreate.
# The secret version import above preserves the actual DB credentials.
# After import, run: terraform apply -target=random_password.db_password
# =============================================================================

# =============================================================================
# time_sleep — cannot meaningfully import, will be recreated on next apply.
# =============================================================================

echo ""
echo "=== Import complete ==="
echo "Run 'terraform plan' to see remaining drift."
echo "Note: random_password.db_password and time_sleep resources cannot be imported."
echo "Note: ACM certs and Route53 records will be created fresh for the new domain."
