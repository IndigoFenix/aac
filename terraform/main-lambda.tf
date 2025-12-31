# =============================================================================
# Provider for us-east-1 (Required for CloudFront certificates)
# Add this to your existing main.tf
# =============================================================================

provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"
  
  default_tags {
    tags = {
      Project     = "CliniAACian"
      Environment = var.environment
      ManagedBy   = "Terraform"
      Compliance  = "HIPAA-FERPA"
    }
  }
}
