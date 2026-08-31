# =============================================================================
# IAM Roles - Least Privilege Principle
# =============================================================================

# NOTE: The GitHub OIDC Provider is created manually during bootstrap
# to avoid chicken-and-egg problem. See SETUP_GUIDE.md

# =============================================================================
# GitHub Actions Role (for CI/CD deployments)
# =============================================================================
data "aws_iam_openid_connect_provider" "github" {
  url = "https://token.actions.githubusercontent.com"
}

# -----------------------------------------------------------------------------
# THE DEPLOY ROLE. Assumed by the `infrastructure`, `build-image`,
# `deploy-frontend` and `deploy-ecs` jobs of .github/workflows/deploy.yml, all
# of which run only on `main`.
#
# History worth keeping: this role existed since 2026-03 and had NEVER been
# assumed — `secrets.AWS_ROLE_ARN` pointed at `cliniaccian-github-actions-bootstrap`,
# an out-of-band role with AdministratorAccess, because the scoped policy here
# could not perform the apply (it had no VPC/RDS/KMS/IAM permissions at all).
# The 2026-08-30 audit found the gap. Rather than create a fourth role, this one
# is repurposed IN PLACE as the real deploy role: trust narrowed to main, policy
# widened to what an apply genuinely needs and no further.
#
# TRUST: `ref:refs/heads/main` only, exact match — not the previous
# `repo:IndigoFenix/aac:*`, which trusted every branch, every PR and every tag in
# the repo. A `workflow_dispatch` run started against main produces the SAME
# subject (`repo:<owner>/<repo>:ref:refs/heads/main` — the manual-dispatch path
# is still a ref-scoped token), so the "Deploy profile: hipaa" manual run keeps
# working. Pull requests get `repo:IndigoFenix/aac:pull_request` and are handled
# by aws_iam_role.github_actions_plan below.
resource "aws_iam_role" "github_actions" {
  name = "${local.name_prefix}-github-actions-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Principal = {
          Federated = data.aws_iam_openid_connect_provider.github.arn
        }
        Action = "sts:AssumeRoleWithWebIdentity"
        Condition = {
          StringEquals = {
            "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
            # GitHub repository: IndigoFenix/aac, main branch only.
            "token.actions.githubusercontent.com:sub" = "repo:IndigoFenix/aac:ref:refs/heads/main"
          }
        }
      }
    ]
  })

  tags = {
    Name = "${local.name_prefix}-github-actions-role"
  }
}

# -----------------------------------------------------------------------------
# What the CI principals may touch.
#
# ONE list of service namespaces, two policies derived from it: the deploy role
# gets `<ns>:*`, the plan role gets `<ns>:Describe*|Get*|List*`. Deriving both
# from one list is the whole point — the previous hand-written policy drifted
# until it could not perform the apply it existed for, and nobody noticed for
# five months because a broader out-of-band role was silently doing the work.
#
# The list is every AWS service reachable from terraform/*.tf across ALL THREE
# profiles (`hipaa` is what adds wafv2, cloudtrail, elasticache, flow logs and
# the VPC interface endpoints) plus every service the `aws` CLI calls in
# .github/workflows/deploy.yml touch. S3, DynamoDB and IAM are deliberately NOT
# in here — they get resource-scoped statements below.
locals {
  github_service_namespaces = [
    "acm",                     # ALB certificate + DNS validation
    "apigateway",              # legacy Lambda path (HTTP API)
    "application-autoscaling", # ECS service scaling target + policies
    "cloudfront",              # frontend + AAC-update distributions, OAC, functions
    "cloudtrail",              # hipaa profile
    "cloudwatch",              # alarms + dashboard
    # ec2 covers the widest surface: VPC, subnets, SGs, NAT, IGW, route tables,
    # EIPs, the bastion + coturn instances, AMI lookup, flow logs, VPC endpoints.
    "ec2",
    "ecr",                  # image repo, lifecycle policy, digest lookup, push
    "ecs",                  # cluster, task definition, service
    "elasticache",          # hipaa profile (Redis fanout bus)
    "elasticloadbalancing", # ALB, target group, listeners
    "events",               # EventBridge rules / connections / API destinations
    "guardduty",            # hipaa profile
    "kms",                  # the CMK + alias everything encrypts with
    "lambda",               # legacy rollback path
    "logs",                 # every log group, metric filter, retention
    "rds",                  # Postgres instance, parameter + subnet groups
    "route53",              # hosted-zone records
    "scheduler",            # EventBridge Scheduler cron
    "secretsmanager",       # database / app-secrets / turn / redis secrets
    "ses",                  # sesv2 identity + MAIL FROM attributes
    "sns",                  # alerts topic, policy, email subscription
    "ssm",                  # session document, patch baseline/group, association
    "wafv2",                # hipaa profile
  ]

  github_deploy_actions = concat(
    [for ns in local.github_service_namespaces : "${ns}:*"],
    # Needs no grant in practice, but data.aws_caller_identity is load-bearing
    # for half the ARNs in this config, so name it.
    ["sts:GetCallerIdentity"],
  )

  github_plan_actions = concat(
    flatten([
      for ns in local.github_service_namespaces : [
        "${ns}:Describe*",
        "${ns}:Get*",
        "${ns}:List*",
      ]
    ]),
    [
      # API Gateway does NOT follow the Describe/Get/List convention — reading an
      # HTTP API is `apigateway:GET`. Without this the plan fails on the legacy
      # Lambda path's aws_apigatewayv2_* resources.
      "apigateway:GET",
      "sts:GetCallerIdentity",
      "ecr:GetAuthorizationToken",
    ],
  )

  # Every bucket this project owns is `${local.name_prefix}-...` = `aivota-*`,
  # INCLUDING the Terraform state bucket. One prefix bounds S3 to this project
  # without enumerating buckets that only exist under some profiles.
  github_bucket_arns = [
    "arn:aws:s3:::aivota-*",
    "arn:aws:s3:::aivota-*/*",
  ]

  github_lock_table_arn = "arn:aws:dynamodb:${var.aws_region}:${data.aws_caller_identity.current.account_id}:table/terraform-state-lock"

  # IAM is scoped by NAME PREFIX. Terraform owns every role, policy and instance
  # profile in this config and they are all `aivota-*`, so the prefix is a real
  # bound: this principal cannot touch an identity belonging to anything else in
  # the account.
  github_iam_arns = [
    "arn:aws:iam::${data.aws_caller_identity.current.account_id}:role/aivota-*",
    "arn:aws:iam::${data.aws_caller_identity.current.account_id}:policy/aivota-*",
    "arn:aws:iam::${data.aws_caller_identity.current.account_id}:instance-profile/aivota-*",
  ]
}

# GitHub Actions Policy — the DEPLOY role (main only).
#
# Honest about what this is: broad WITHIN the project, hard-bounded outside it.
# A `terraform apply` that creates VPCs, RDS, KMS keys and IAM roles cannot be
# expressed as a short least-privilege action list without breaking on the next
# resource anyone adds — and a policy that breaks gets replaced by
# AdministratorAccess, which is precisely this repo's history. So: full access to
# the services the config uses, resource-scoped access to S3, the lock table and
# IAM, and an explicit Deny fence around the account-level controls that would
# let this principal escape the project.
#
# KNOWN RESIDUAL: this role can rewrite its own policy (it is an `aivota-*` role
# and Terraform must be able to manage it). That is inherent to letting Terraform
# own its own CI identity; the control on it is that every change has to land on
# `main` through a pull request. A permissions boundary would close it properly
# and is the next step if this is ever audited harder.
resource "aws_iam_role_policy" "github_actions" {
  name = "${local.name_prefix}-github-actions-policy"
  role = aws_iam_role.github_actions.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "ProjectServices"
        Effect   = "Allow"
        Action   = local.github_deploy_actions
        Resource = "*"
      },
      {
        # Terraform-managed buckets (uploads, logs, frontend, aac-updates), the
        # frontend `aws s3 sync`, the AAC installer upload and the Terraform
        # state object all live under this prefix.
        Sid      = "ProjectBuckets"
        Effect   = "Allow"
        Action   = "s3:*"
        Resource = local.github_bucket_arns
      },
      {
        # Bucket-level discovery has no resource to scope to.
        Sid      = "BucketDiscovery"
        Effect   = "Allow"
        Action   = ["s3:ListAllMyBuckets", "s3:GetBucketLocation"]
        Resource = "*"
      },
      {
        # State locking, the workflow's first-run table bootstrap, and its
        # stale-digest repair step (get-item / delete-item).
        Sid    = "TerraformStateLock"
        Effect = "Allow"
        Action = [
          "dynamodb:CreateTable",
          "dynamodb:DescribeTable",
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:DeleteItem",
          "dynamodb:TagResource",
          "dynamodb:ListTagsOfResource",
        ]
        Resource = local.github_lock_table_arn
      },
      {
        Sid      = "ScopedIamManagement"
        Effect   = "Allow"
        Action   = "iam:*"
        Resource = local.github_iam_arns
      },
      {
        # Subsumed by ScopedIamManagement, stated separately on purpose: these
        # are the passes that make a deploy work (ECS registering a task
        # definition, EC2 attaching an instance profile). If the statement above
        # is ever narrowed away from `iam:*`, this must survive.
        Sid    = "PassRoleToAwsServices"
        Effect = "Allow"
        Action = "iam:PassRole"
        Resource = concat(
          [
            aws_iam_role.ecs_task_execution.arn,
            aws_iam_role.ecs_task.arn,
            aws_iam_role.bastion.arn,
          ],
          var.enable_coturn ? [aws_iam_role.coturn[0].arn] : [],
        )
      },
      {
        # data.aws_iam_openid_connect_provider.github — the provider ARN is not
        # `aivota-*`, so it needs its own read grant.
        Sid    = "ReadOidcProvider"
        Effect = "Allow"
        Action = [
          "iam:GetOpenIDConnectProvider",
          "iam:ListOpenIDConnectProviders",
        ]
        Resource = "*"
      },
      {
        # Service-linked roles live under `role/aws-service-role/*`, NOT under
        # `aivota-*`, so ScopedIamManagement does not reach them. Application
        # Auto Scaling already has its SLR in this account (the ECS scaling
        # target is live), but switching to the `hipaa` profile creates
        # ElastiCache, GuardDuty and WAF resources for the first time, and each
        # of those services mints its SLR on first use. Without this the profile
        # switch fails with AccessDenied on iam:CreateServiceLinkedRole — a
        # failure that would look like a Terraform bug rather than a policy gap.
        #
        # Bounded by construction: the caller cannot choose the policy attached
        # to a service-linked role, only which AWS service gets one.
        Sid      = "CreateServiceLinkedRoles"
        Effect   = "Allow"
        Action   = "iam:CreateServiceLinkedRole"
        Resource = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:role/aws-service-role/*"
      },
      {
        # The fence. Nothing in this repo manages the organization, account
        # settings, billing, or IAM humans/keys — so a compromised workflow
        # cannot mint itself a user, an access key or a console login, and cannot
        # reach the payer account. An explicit Deny beats every Allow above.
        Sid    = "DenyAccountAndIdentityEscalation"
        Effect = "Deny"
        Action = [
          "organizations:*",
          "account:*",
          "aws-portal:*",
          "billing:*",
          "ce:*",
          "iam:*User*",
          "iam:*AccessKey*",
          "iam:*LoginProfile*",
          "iam:*SAMLProvider*",
          "iam:*MFADevice*",
        ]
        Resource = "*"
      },
    ]
  })
}

# =============================================================================
# GitHub Actions PLAN role (pull requests) — read-only
# =============================================================================
# A `terraform plan` reads everything and writes nothing except the state LOCK,
# so a pull request never needs the deploy role's write access. A separate role
# rather than a condition on the existing one, because the TRUST POLICY is what
# distinguishes them: this trusts `pull_request`, the deploy role does not.
#
# Fork PRs are not an exposure: GitHub issues no secrets — and therefore no role
# ARN — to a workflow triggered from a fork, so the job cannot even attempt the
# assume.
#
# NOTE (2026-08-31): the `infrastructure` job is gated
# `if: github.ref == 'refs/heads/main'`, and a pull_request event's ref is
# `refs/pull/<n>/merge` — so NO job runs on PRs today and this role has no live
# consumer yet. It is created so the capability exists the moment that gate is
# relaxed. See docs/INFRASTRUCTURE.md → Access & hardening.
resource "aws_iam_role" "github_actions_plan" {
  name = "${local.name_prefix}-github-actions-plan"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Principal = {
          Federated = data.aws_iam_openid_connect_provider.github.arn
        }
        Action = "sts:AssumeRoleWithWebIdentity"
        Condition = {
          StringEquals = {
            "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
            "token.actions.githubusercontent.com:sub" = "repo:IndigoFenix/aac:pull_request"
          }
        }
      }
    ]
  })

  tags = {
    Name = "${local.name_prefix}-github-actions-plan"
  }
}

resource "aws_iam_role_policy" "github_actions_plan" {
  name = "${local.name_prefix}-github-actions-plan-policy"
  role = aws_iam_role.github_actions_plan.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "ReadProjectServices"
        Effect   = "Allow"
        Action   = local.github_plan_actions
        Resource = "*"
      },
      {
        # Read the state file and the objects Terraform refreshes against.
        Sid      = "ReadState"
        Effect   = "Allow"
        Action   = ["s3:Get*", "s3:List*"]
        Resource = local.github_bucket_arns
      },
      {
        Sid      = "BucketDiscovery"
        Effect   = "Allow"
        Action   = ["s3:ListAllMyBuckets", "s3:GetBucketLocation"]
        Resource = "*"
      },
      {
        # A plan TAKES THE LOCK — the one write a read-only CI principal
        # legitimately makes. DeleteItem is both the lock release and the
        # workflow's stale-digest repair.
        Sid    = "TerraformStateLock"
        Effect = "Allow"
        Action = [
          "dynamodb:DescribeTable",
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:DeleteItem",
        ]
        Resource = local.github_lock_table_arn
      },
      {
        Sid      = "ReadIamAndOidc"
        Effect   = "Allow"
        Action   = ["iam:Get*", "iam:List*"]
        Resource = "*"
      },
      {
        Sid    = "DenyAccountAndIdentityEscalation"
        Effect = "Deny"
        Action = [
          "organizations:*",
          "account:*",
          "aws-portal:*",
          "billing:*",
          "ce:*",
          "iam:*User*",
          "iam:*AccessKey*",
          "iam:*LoginProfile*",
          "iam:*SAMLProvider*",
          "iam:*MFADevice*",
        ]
        Resource = "*"
      },
      {
        # A plan must never mutate the state itself, so the write half is denied
        # outright rather than merely not granted. The LOCK lives in DynamoDB,
        # not S3, so this does not block a legitimate plan.
        Sid      = "DenyStateWrites"
        Effect   = "Deny"
        Action   = ["s3:PutObject", "s3:DeleteObject", "s3:DeleteObjectVersion"]
        Resource = local.github_bucket_arns
      },
    ]
  })
}

# =============================================================================
# ECS Task Execution Role (for pulling images, accessing secrets)
# =============================================================================
resource "aws_iam_role" "ecs_task_execution" {
  name = "${local.name_prefix}-ecs-task-execution-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "ecs-tasks.amazonaws.com"
        }
      }
    ]
  })

  tags = {
    Name = "${local.name_prefix}-ecs-task-execution-role"
  }
}

resource "aws_iam_role_policy_attachment" "ecs_task_execution" {
  role       = aws_iam_role.ecs_task_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# Additional permissions for Secrets Manager
resource "aws_iam_role_policy" "ecs_task_execution_secrets" {
  name = "${local.name_prefix}-ecs-secrets-policy"
  role = aws_iam_role.ecs_task_execution.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "secretsmanager:GetSecretValue"
        ]
        Resource = concat(
          [
            aws_secretsmanager_secret.app_secrets.arn,
            aws_secretsmanager_secret.database.arn,
          ],
          var.enable_redis ? [aws_secretsmanager_secret.redis_auth[0].arn] : [],
          var.enable_coturn ? [aws_secretsmanager_secret.turn[0].arn] : [],
        )
      },
      {
        Effect = "Allow"
        Action = [
          "kms:Decrypt"
        ]
        Resource = aws_kms_key.main.arn
      }
    ]
  })
}

# =============================================================================
# ECS Task Role (for application runtime permissions)
# =============================================================================
resource "aws_iam_role" "ecs_task" {
  name = "${local.name_prefix}-ecs-task-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "ecs-tasks.amazonaws.com"
        }
      }
    ]
  })

  tags = {
    Name = "${local.name_prefix}-ecs-task-role"
  }
}

resource "aws_iam_role_policy" "ecs_task" {
  name = "${local.name_prefix}-ecs-task-policy"
  role = aws_iam_role.ecs_task.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      # S3 access for file uploads (if needed)
      {
        Effect = "Allow"
        Action = [
          "s3:GetObject",
          "s3:PutObject",
          "s3:DeleteObject",
          "s3:ListBucket"
        ]
        Resource = [
          aws_s3_bucket.uploads.arn,
          "${aws_s3_bucket.uploads.arn}/*"
        ]
      },
      # Secrets Manager (runtime access — the app loads both at boot)
      {
        Effect = "Allow"
        Action = [
          "secretsmanager:GetSecretValue"
        ]
        Resource = [
          aws_secretsmanager_secret.app_secrets.arn,
          aws_secretsmanager_secret.database.arn
        ]
      },
      # CloudWatch Logs
      {
        Effect = "Allow"
        Action = [
          "logs:CreateLogStream",
          "logs:PutLogEvents"
        ]
        Resource = "${aws_cloudwatch_log_group.app.arn}:*"
      },
      # KMS for decryption
      {
        Effect = "Allow"
        Action = [
          "kms:Decrypt",
          "kms:GenerateDataKey"
        ]
        Resource = aws_kms_key.main.arn
      }
    ]
  })
}

# =============================================================================
# Engineer database access via IAM (per-person, no shared password)
# =============================================================================
# Today every human DB session goes through the SSM tunnel as `aivota_admin`
# with the password out of Secrets Manager — one credential, no attribution
# (§5.11.2). RDS IAM authentication (iam_database_authentication_enabled in
# rds.tf) replaces that: the engineer mints a 15-minute token with
# `aws rds generate-db-auth-token`, connects as their own DB role, and
# CloudTrail records the caller.
#
# This policy is created but attached to NOBODY. Attaching it is a deliberate
# per-engineer act (or a group), and it is inert until the one-time SQL in
# docs/INFRASTRUCTURE.md creates the `aivota_engineer` role and grants it
# `rds_iam`. Scripts and the application keep using the password path — the two
# coexist, so nothing has to migrate on a schedule.
#
# The resource ARN uses the instance's RESOURCE ID (db-XXXX...), not its
# identifier: an ARN built from the name would keep authorizing a different
# instance restored under the same name.
#
# Free: an unattached managed policy has no cost.
resource "aws_iam_policy" "rds_iam_connect" {
  name        = "${local.name_prefix}-rds-iam-connect"
  description = "Connect to the AiVota Postgres instance as the aivota_engineer DB user via an IAM auth token"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = "rds-db:connect"
        Resource = "arn:aws:rds-db:${var.aws_region}:${data.aws_caller_identity.current.account_id}:dbuser:${aws_db_instance.main.resource_id}/aivota_engineer"
      }
    ]
  })

  tags = {
    Name = "${local.name_prefix}-rds-iam-connect"
  }
}
