ALTER TYPE "public"."activity_event_type" ADD VALUE 'auth_login_success';--> statement-breakpoint
ALTER TYPE "public"."activity_event_type" ADD VALUE 'auth_login_failure';--> statement-breakpoint
ALTER TYPE "public"."activity_event_type" ADD VALUE 'auth_logout';--> statement-breakpoint
ALTER TYPE "public"."activity_event_type" ADD VALUE 'auth_mfa_challenge';--> statement-breakpoint
ALTER TYPE "public"."activity_event_type" ADD VALUE 'auth_mfa_success';--> statement-breakpoint
ALTER TYPE "public"."activity_event_type" ADD VALUE 'auth_mfa_failure';--> statement-breakpoint
ALTER TYPE "public"."activity_event_type" ADD VALUE 'auth_password_reset_requested';--> statement-breakpoint
ALTER TYPE "public"."activity_event_type" ADD VALUE 'auth_password_reset_completed';