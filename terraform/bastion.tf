# =============================================================================
# Bastion Host - Minimal EC2 instance for SSM tunneling to RDS
# =============================================================================
# No SSH key needed for SSM, but key pair retained for emergency SSH access.
# No public IP — reaches SSM service via NAT gateway.
# Used for: npm run db-tunnel, database migrations, ad-hoc DB access.
# Cost: ~$1.50/month (t4g.nano)
# =============================================================================

# Find latest Amazon Linux 2023 AMI for ARM (Graviton)
data "aws_ami" "amazon_linux_arm" {
  most_recent = true
  owners      = ["amazon"]

  filter {
    name   = "name"
    values = ["al2023-ami-*-kernel-*-arm64"]
  }

  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}

# IAM role for SSM access
resource "aws_iam_role" "bastion" {
  name = "${local.name_prefix}-bastion-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "ec2.amazonaws.com"
        }
      }
    ]
  })

  tags = {
    Name = "${local.name_prefix}-bastion-role"
  }
}

resource "aws_iam_role_policy_attachment" "bastion_ssm" {
  role       = aws_iam_role.bastion.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_instance_profile" "bastion" {
  name = "${local.name_prefix}-bastion-profile"
  role = aws_iam_role.bastion.name
}

resource "aws_instance" "bastion" {
  ami                    = data.aws_ami.amazon_linux_arm.id
  instance_type          = "t4g.nano"
  subnet_id              = aws_subnet.private[1].id  # il-central-1b
  vpc_security_group_ids = [aws_security_group.bastion.id]
  iam_instance_profile   = aws_iam_instance_profile.bastion.name
  key_name               = "db-access-keypair"

  associate_public_ip_address = false

  user_data = <<-EOF
    #!/bin/bash
    dnf install -y amazon-ssm-agent
    systemctl enable amazon-ssm-agent
    systemctl start amazon-ssm-agent
  EOF

  tags = {
    Name = "${local.name_prefix}-bastion"
  }
}

output "bastion_instance_id" {
  description = "Bastion EC2 instance ID (for SSM tunneling)"
  value       = aws_instance.bastion.id
}
