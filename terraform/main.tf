# =============================================================================
# CliniAACian - HIPAA/FERPA Compliant AWS Infrastructure
# =============================================================================

terraform {
  required_version = ">= 1.5.0"
  
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
      Project     = "CliniAACian"
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
  name_prefix = "cliniaacian-${var.environment}"
  
  common_tags = {
    Project     = "CliniAACian"
    Environment = var.environment
  }

  # CIDR blocks
  vpc_cidr = var.environment == "prod" ? "10.0.0.0/16" : "10.1.0.0/16"
  
  azs = slice(data.aws_availability_zones.available.names, 0, 2)
}

data "aws_availability_zones" "available" {
  state = "available"
}
