# =============================================================================
# coturn - Self-hosted WebRTC TURN relay for live video calls
# =============================================================================
# A single EC2 host running coturn in a container, with a stable Elastic IP.
# WebRTC peers fall back to this relay when a direct peer-to-peer path can't be
# established (symmetric NAT, restrictive firewalls).
#
# Auth uses coturn's time-limited shared-secret ("REST API") mode: the app and
# coturn share TURN_SECRET; the app mints `username=<expiry>:<label>` /
# `credential=base64(HMAC-SHA1(secret, username))` per client. No per-user TURN
# passwords are stored. See server/services/call/turnCredentials.ts.
#
# Media relayed through coturn remains DTLS-SRTP encrypted end-to-end (the relay
# only forwards opaque packets), so the relay is outside the PHI plaintext
# boundary. TLS on the TURN control channel (turns:5349) is a HIPAA-path
# enhancement tracked in planning-docs/live-video-chat.md; today the relay
# listens on plain UDP/TCP 3478.
#
# Reuses data.aws_ami.amazon_linux_arm (defined in bastion.tf).
# Everything here is gated on var.enable_coturn.

locals {
  coturn_count = var.enable_coturn ? 1 : 0

  # Patch Manager group membership. The instance carries this as its
  # `Patch Group` tag; aws_ssm_patch_group (ssm.tf) binds the AL2023 security
  # baseline to the same string.
  coturn_patch_group = "${local.name_prefix}-coturn"

  # Public host clients dial. Prefer the DNS name (needed for future TLS); fall
  # back to the raw EIP when no domain is configured.
  coturn_host = var.enable_coturn ? (
    var.domain_name != "" ? "${var.coturn_subdomain}.${var.domain_name}" : aws_eip.coturn[0].public_ip
  ) : ""

  # ICE url list handed to clients (consumed as TURN_URLS env var by the app).
  coturn_turn_urls = var.enable_coturn ? join(",", [
    "turn:${local.coturn_host}:3478?transport=udp",
    "turn:${local.coturn_host}:3478?transport=tcp",
  ]) : ""
}

# ----------------------------------------------------------------------------
# Shared secret (app <-> coturn). Random, stored in Secrets Manager for ECS.
# ----------------------------------------------------------------------------
resource "random_password" "turn_secret" {
  count   = local.coturn_count
  length  = 48
  special = false # coturn static-auth-secret: keep it shell/arg-safe
}

resource "aws_secretsmanager_secret" "turn" {
  count       = local.coturn_count
  name        = "${local.name_prefix}/turn"
  description = "Shared static-auth-secret for the coturn TURN relay"
  kms_key_id  = aws_kms_key.main.arn

  recovery_window_in_days = var.environment == "prod" ? 30 : 7

  tags = {
    Name = "${local.name_prefix}-turn-secret"
  }
}

resource "aws_secretsmanager_secret_version" "turn" {
  count         = local.coturn_count
  secret_id     = aws_secretsmanager_secret.turn[0].id
  secret_string = jsonencode({ TURN_SECRET = random_password.turn_secret[0].result })
}

# ----------------------------------------------------------------------------
# Networking - public IP + security group
# ----------------------------------------------------------------------------
resource "aws_eip" "coturn" {
  count  = local.coturn_count
  domain = "vpc"

  tags = {
    Name = "${local.name_prefix}-coturn-eip"
  }
}

resource "aws_security_group" "coturn" {
  count       = local.coturn_count
  name        = "${local.name_prefix}-coturn-sg"
  description = "coturn TURN relay - STUN/TURN signaling + media relay"
  vpc_id      = aws_vpc.main.id

  # TURN/STUN control channel (UDP + TCP).
  ingress {
    description = "TURN/STUN UDP"
    from_port   = 3478
    to_port     = 3478
    protocol    = "udp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  ingress {
    description = "TURN/STUN TCP"
    from_port   = 3478
    to_port     = 3478
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  # TLS control channel (reserved for the HIPAA-path TURNS upgrade; coturn is
  # not yet listening here, but opening it now avoids a later SG churn).
  ingress {
    description = "TURNS (TLS) TCP"
    from_port   = 5349
    to_port     = 5349
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  # Relayed media port range (UDP). Bounded by coturn min/max-port.
  ingress {
    description = "TURN relay media (UDP)"
    from_port   = var.coturn_relay_port_min
    to_port     = var.coturn_relay_port_max
    protocol    = "udp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    description = "All outbound"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "${local.name_prefix}-coturn-sg"
  }
}

# ----------------------------------------------------------------------------
# IAM - SSM access for management (no SSH key / no inbound 22).
# ----------------------------------------------------------------------------
resource "aws_iam_role" "coturn" {
  count = local.coturn_count
  name  = "${local.name_prefix}-coturn-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action    = "sts:AssumeRole"
        Effect    = "Allow"
        Principal = { Service = "ec2.amazonaws.com" }
      }
    ]
  })

  tags = {
    Name = "${local.name_prefix}-coturn-role"
  }
}

resource "aws_iam_role_policy_attachment" "coturn_ssm" {
  count      = local.coturn_count
  role       = aws_iam_role.coturn[0].name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_instance_profile" "coturn" {
  count = local.coturn_count
  name  = "${local.name_prefix}-coturn-profile"
  role  = aws_iam_role.coturn[0].name
}

# ----------------------------------------------------------------------------
# Instance - Amazon Linux 2023 (ARM) running coturn in Docker, host networking.
# ----------------------------------------------------------------------------
resource "aws_instance" "coturn" {
  count                  = local.coturn_count
  ami                    = data.aws_ami.amazon_linux_arm.id
  instance_type          = var.coturn_instance_type
  subnet_id              = aws_subnet.public[0].id
  vpc_security_group_ids = [aws_security_group.coturn[0].id]
  iam_instance_profile   = aws_iam_instance_profile.coturn[0].name

  # Auto-assign a public IP so user_data can reach the internet (dnf, docker
  # pull) at first boot — the public subnet routes via the IGW, which needs an
  # instance public IP. The stable Elastic IP replaces it via the association
  # below; coturn already advertises the EIP via --external-ip regardless.
  associate_public_ip_address = true

  user_data_replace_on_change = true
  user_data = <<-EOF
    #!/bin/bash
    set -euxo pipefail
    dnf install -y docker
    systemctl enable --now docker
    # host networking so the relay's UDP port range is reachable directly.
    # Image is PINNED (var.coturn_image_tag): an untagged `coturn/coturn` meant
    # the relay's version was whatever :latest happened to be on the day the
    # host last booted.
    docker run -d --name coturn --restart always --network host coturn/coturn:${var.coturn_image_tag} \
      -n \
      --use-auth-secret \
      --static-auth-secret=${random_password.turn_secret[0].result} \
      --realm=${local.coturn_host} \
      --listening-port=3478 \
      --min-port=${var.coturn_relay_port_min} \
      --max-port=${var.coturn_relay_port_max} \
      --external-ip=${aws_eip.coturn[0].public_ip} \
      --no-cli \
      --no-tls \
      --no-dtls \
      --fingerprint \
      --log-file=stdout
  EOF

  tags = {
    Name = "${local.name_prefix}-coturn"

    # Binds the host to the AL2023 security patch baseline (ssm.tf). The key is
    # literally "Patch Group" (with the space) — that is the name Patch Manager
    # looks for; anything else is silently ignored. Tags update in place, so
    # adding this does NOT replace the instance.
    "Patch Group" = local.coturn_patch_group
  }

  lifecycle {
    replace_triggered_by = [null_resource.coturn_version]

    # user_data is ignored on UPDATE, not on create. Combined with
    # user_data_replace_on_change above, editing the script would otherwise
    # replace the relay on the very next apply and drop every live call — an
    # unacceptable side effect of, say, pinning the container image. So:
    # changes to the boot script land in the config now and take effect the
    # next time the host is deliberately replaced by bumping
    # null_resource.coturn_version below (which re-runs the CURRENT user_data,
    # ignore_changes affecting only diff detection). Do that during a quiet
    # window, not as a drive-by.
    ignore_changes = [user_data]
  }
}

# Bump to force coturn host replacement (re-runs user_data).
resource "null_resource" "coturn_version" {
  count = local.coturn_count
  triggers = {
    version = "1"
  }
}

resource "aws_eip_association" "coturn" {
  count         = local.coturn_count
  instance_id   = aws_instance.coturn[0].id
  allocation_id = aws_eip.coturn[0].id
}

# ----------------------------------------------------------------------------
# DNS - turn.<domain> -> EIP (when a domain is configured).
# ----------------------------------------------------------------------------
resource "aws_route53_record" "coturn" {
  count   = var.enable_coturn && var.domain_name != "" ? 1 : 0
  zone_id = data.aws_route53_zone.main[0].zone_id
  name    = "${var.coturn_subdomain}.${var.domain_name}"
  type    = "A"
  ttl     = 300
  records = [aws_eip.coturn[0].public_ip]
}

# ----------------------------------------------------------------------------
# Outputs
# ----------------------------------------------------------------------------
output "coturn_public_ip" {
  description = "Elastic IP of the coturn TURN relay (empty when disabled)"
  value       = var.enable_coturn ? aws_eip.coturn[0].public_ip : ""
}

output "coturn_turn_urls" {
  description = "TURN_URLS value wired into the app"
  value       = local.coturn_turn_urls
}
