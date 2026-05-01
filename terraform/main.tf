# =============================================================================
# AiVota - HIPAA/FERPA Compliant AWS Infrastructure
# =============================================================================

terraform {
  # Floor at 1.10 so the CLI ships the GPG trust root that accepts HashiCorp's
  # current provider signing keys. 1.6.x and earlier reject re-signed providers
  # with "openpgp: key expired".
  required_version = ">= 1.10.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.5"
    }
    time = {
      source  = "hashicorp/time"
      version = "~> 0.9"
    }
    null = {
      source  = "hashicorp/null"
      version = "~> 3.2"
    }
  }

  # Remote state in S3 with encryption
  backend "s3" {
    encrypt        = true
    dynamodb_table = "terraform-state-lock"
  }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project     = "AiVota"
      Environment = var.environment
      ManagedBy   = "Terraform"
      Compliance  = "HIPAA-FERPA"
    }
  }
}

# Data source for current AWS account
data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

# =============================================================================
# Local Variables
# =============================================================================
locals {
  name_prefix = "aivota-${var.environment}"

  common_tags = {
    Project     = "AiVota"
    Environment = var.environment
  }

  # CIDR blocks
  vpc_cidr = var.environment == "prod" ? "10.0.0.0/16" : "10.1.0.0/16"
  
  azs = slice(data.aws_availability_zones.available.names, 0, 2)
}

data "aws_availability_zones" "available" {
  state = "available"
}
