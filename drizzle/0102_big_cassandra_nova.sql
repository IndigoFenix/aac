CREATE TYPE "public"."lmn_status" AS ENUM('draft', 'finalized');--> statement-breakpoint
CREATE TABLE "letters_of_medical_necessity" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"student_id" varchar NOT NULL,
	"user_id" varchar,
	"institute_id" varchar,
	"is_sensitive" boolean DEFAULT true NOT NULL,
	"sensitivity_category" "sensitivity_category" DEFAULT 'medical' NOT NULL,
	"sections" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"metrics_snapshot" jsonb DEFAULT '{}'::jsonb,
	"signature_name" text,
	"signature_license" text,
	"signature_credentials" text,
	"signed_at" timestamp,
	"status" "lmn_status" DEFAULT 'draft' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"finalized_at" timestamp
);
--> statement-breakpoint
CREATE INDEX "idx_lmn_student_id" ON "letters_of_medical_necessity" USING btree ("student_id");--> statement-breakpoint
CREATE INDEX "idx_lmn_institute_id" ON "letters_of_medical_necessity" USING btree ("institute_id");--> statement-breakpoint
CREATE INDEX "idx_lmn_status" ON "letters_of_medical_necessity" USING btree ("status");