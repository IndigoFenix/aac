ALTER TYPE "public"."activity_event_type" ADD VALUE 'package_published';--> statement-breakpoint
ALTER TYPE "public"."activity_event_type" ADD VALUE 'package_unpublished';--> statement-breakpoint
ALTER TYPE "public"."activity_event_type" ADD VALUE 'package_approved';--> statement-breakpoint
ALTER TYPE "public"."activity_event_type" ADD VALUE 'package_rejected';--> statement-breakpoint
ALTER TABLE "custom_symbols" ADD COLUMN "person_image" boolean DEFAULT false NOT NULL;