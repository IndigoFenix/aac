# =============================================================================
# AWS Systems Manager - session logging + OS patch automation
# =============================================================================
# Two unrelated-looking things live here because both are "SSM as the
# management plane" and both are free:
#   1. Session Manager shell-session logging to the EXISTING logs bucket.
#   2. A Patch Manager baseline + State Manager association that keeps the
#      coturn EC2 host's security packages current (coturn.tf builds the host).
#
# Nothing in this file creates a billable resource: SSM documents, patch
# baselines, patch groups and State Manager associations are free for EC2
# instances on the standard instance tier, and the only bytes written are shell
# transcripts into aws_s3_bucket.logs, which already carries the 6-year
# lifecycle. Deliberately NO CloudWatch log group — ingestion is the expensive
# half of session logging and S3 satisfies the audit requirement.

# =============================================================================
# Session Manager preferences (SSM-SessionManagerRunShell)
# =============================================================================
# `SSM-SessionManagerRunShell` is the account/region-wide DEFAULT document for
# standard shell sessions, which is why the name is fixed and not prefixed with
# local.name_prefix: creating it under any other name would leave plain
# `aws ssm start-session` unlogged. The console writes this same document when
# you edit session preferences by hand; as of this commit no self-owned SSM
# document exists in the account, so Terraform can create it cleanly. If one is
# ever created out of band, `terraform apply` fails with DocumentAlreadyExists
# and the fix is to import it, not to rename ours.
#
# SCOPE — be precise about what this does and does not capture:
#   * Standard shell sessions (`aws ssm start-session --target <id>`) write a
#     full keystroke/output transcript to s3://<logs bucket>/ssm-sessions/.
#   * PORT FORWARDING sessions produce NO transcript. There is no shell and no
#     stream to record, so `npm run db-tunnel` (scripts/db-tunnel.sh, which
#     names AWS-StartPortForwardingSessionToRemoteHost explicitly and therefore
#     never resolves this document) is completely unaffected — same command,
#     same behaviour, no new IAM requirement on the engineer. DB-tunnel
#     evidence comes from CloudTrail `StartSession` / `TerminateSession`
#     events, which record who, when, which target and which document — those
#     are only retained with enable_cloudtrail (the `hipaa` profile).
#
# Only the S3 fields are set. Every other preference (idle timeout, run-as,
# shell profile, KMS session encryption) is deliberately left unspecified so it
# keeps its AWS default. In particular session-level KMS encryption is NOT
# enabled: it applies to ALL session types including port forwarding, and would
# make the DB tunnel fail for any engineer whose IAM lacks kms:GenerateDataKey.
resource "aws_ssm_document" "session_manager_run_shell" {
  count = var.enable_ssm_session_logging ? 1 : 0

  name            = "SSM-SessionManagerRunShell"
  document_type   = "Session"
  document_format = "JSON"

  content = jsonencode({
    schemaVersion = "1.0"
    description   = "Session Manager preferences: log interactive shell sessions to S3 (no CloudWatch)."
    sessionType   = "Standard_Stream"
    inputs = {
      s3BucketName = aws_s3_bucket.logs.bucket
      s3KeyPrefix  = local.ssm_session_log_prefix
      # The logs bucket's default encryption is SSE-S3 (AES256, storage.tf) —
      # deliberately not the CMK, because ALB and CloudTrail also deliver here.
      # s3EncryptionEnabled only requires that objects land encrypted, which the
      # bucket default satisfies, so no KMS grant is needed on the instance
      # roles below. If the bucket is ever moved to SSE-KMS, add kms:Decrypt +
      # kms:GenerateDataKey on that key to both roles or sessions start failing.
      s3EncryptionEnabled = true
      # Explicitly off: a CloudWatch destination would bill ingestion per
      # keystroke-batch for every session.
      cloudWatchStreamingEnabled  = false
      cloudWatchEncryptionEnabled = false
      cloudWatchLogGroupName      = ""
    }
  })

  tags = {
    Name = "${local.name_prefix}-ssm-session-prefs"
  }
}

locals {
  ssm_session_log_prefix = "ssm-sessions"
}

# -----------------------------------------------------------------------------
# Instance-side permission to write the transcript.
# -----------------------------------------------------------------------------
# THIS IS NOT OPTIONAL. Once a session document names an S3 destination, the
# SSM agent tries to write there at session start, and a session whose target
# instance cannot write the transcript REFUSES TO START ("Encountered error
# while initiating handshake ... AccessDenied"). Both SSM-managed instances —
# the bastion (break-glass shell + the DB tunnel) and the coturn relay — get
# the grant, or configuring logging would lock us out of the very hosts it is
# meant to audit.
#
# s3:GetEncryptionConfiguration is required in addition to PutObject: with
# s3EncryptionEnabled the agent reads the bucket's default encryption before
# uploading.
data "aws_iam_policy_document" "ssm_session_logs_write" {
  count = var.enable_ssm_session_logging ? 1 : 0

  statement {
    sid       = "WriteSessionTranscripts"
    effect    = "Allow"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.logs.arn}/${local.ssm_session_log_prefix}/*"]
  }

  statement {
    sid       = "ReadBucketEncryptionSettings"
    effect    = "Allow"
    actions   = ["s3:GetEncryptionConfiguration"]
    resources = [aws_s3_bucket.logs.arn]
  }
}

resource "aws_iam_role_policy" "bastion_ssm_session_logs" {
  count = var.enable_ssm_session_logging ? 1 : 0

  name   = "${local.name_prefix}-bastion-session-logs"
  role   = aws_iam_role.bastion.id
  policy = data.aws_iam_policy_document.ssm_session_logs_write[0].json
}

resource "aws_iam_role_policy" "coturn_ssm_session_logs" {
  count = var.enable_ssm_session_logging && var.enable_coturn ? 1 : 0

  name   = "${local.name_prefix}-coturn-session-logs"
  role   = aws_iam_role.coturn[0].id
  policy = data.aws_iam_policy_document.ssm_session_logs_write[0].json
}

# =============================================================================
# Patch Manager - coturn EC2 host
# =============================================================================
# The coturn relay is the only EC2 host we run that is reachable from the
# internet (public subnet + EIP, UDP/TCP 3478 and the relay port range open to
# 0.0.0.0/0), and until now nothing patched it: the AMI is only re-resolved
# when the host is replaced, and the container image was untagged. §5.11.4 of
# the AKIM appendix wants ongoing security updates on the OS, and this is that.
#
# The bastion is deliberately NOT in the patch group: it has no ingress rules,
# no public IP, and rebooting it would kill an in-flight DB tunnel. It is
# replaced (fresh AMI) whenever null_resource.bastion_version is bumped.
#
# Free: Patch Manager, patch baselines, patch groups and State Manager
# associations carry no charge for EC2 instances, and no S3/CloudWatch output
# location is configured for the association (Run Command output stays in the
# SSM invocation record).

resource "aws_ssm_patch_baseline" "coturn" {
  count = var.enable_coturn ? 1 : 0

  name             = "${local.name_prefix}-al2023-security"
  description      = "Amazon Linux 2023 security patches for the coturn relay host"
  operating_system = "AMAZON_LINUX_2023"

  # Auto-approve security updates a week after release. The delay is the point:
  # it lets a bad vendor package be pulled before it reaches the relay, and the
  # host is not in the PHI plaintext path (media through coturn stays DTLS-SRTP
  # encrypted end to end), so a 7-day exposure window is the right trade.
  approval_rule {
    approve_after_days = 7
    compliance_level   = "CRITICAL"

    patch_filter {
      key    = "CLASSIFICATION"
      values = ["Security"]
    }

    patch_filter {
      key    = "SEVERITY"
      values = ["Critical", "Important"]
    }
  }

  tags = {
    Name = "${local.name_prefix}-coturn-patch-baseline"
  }
}

# Binds the baseline to instances tagged `Patch Group = <this value>`. The tag
# is set on aws_instance.coturn (coturn.tf) — tags update in place, so adding
# it does not replace the host.
resource "aws_ssm_patch_group" "coturn" {
  count = var.enable_coturn ? 1 : 0

  baseline_id = aws_ssm_patch_baseline.coturn[0].id
  patch_group = local.coturn_patch_group
}

# Weekly scan+install. Cron is UTC (SSM has no timezone field here):
#   cron(0 0 ? * SAT *) = Saturday 00:00 UTC
#                       = Saturday 03:00 Israel summer time (IDT, UTC+3)
#                       = Saturday 02:00 Israel winter time (IST, UTC+2)
# Saturday pre-dawn Israel time is the quietest window for a service whose
# users are Israeli schools and clinics; a reboot there costs at worst a
# reconnect on a call that is unlikely to be in progress.
#
# apply_only_at_cron_interval = true is load-bearing: without it State Manager
# runs the association ONCE IMMEDIATELY on creation, which with
# RebootOption=RebootIfNeeded would reboot the relay during the apply that
# creates it and drop any live call.
resource "aws_ssm_association" "coturn_patch" {
  count = var.enable_coturn ? 1 : 0

  name             = "AWS-RunPatchBaseline"
  association_name = "${local.name_prefix}-coturn-patch"

  schedule_expression         = "cron(0 0 ? * SAT *)"
  apply_only_at_cron_interval = true

  parameters = {
    Operation    = "Install"
    RebootOption = "RebootIfNeeded"
  }

  targets {
    key    = "InstanceIds"
    values = [aws_instance.coturn[0].id]
  }

  # One host, so concurrency/error caps are formalities — set anyway so the
  # association stays sane if the relay is ever scaled out behind a target tag.
  max_concurrency = "1"
  max_errors      = "1"
}
