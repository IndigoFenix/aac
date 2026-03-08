CREATE TYPE "public"."contact_role" AS ENUM('district_administrator', 'special_education_director', 'speech_language_pathologist', 'educator', 'other');--> statement-breakpoint
CREATE TABLE "contact_inquiries" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"first_name" text NOT NULL,
	"last_name" text NOT NULL,
	"email" text NOT NULL,
	"organization" text NOT NULL,
	"role" "contact_role" NOT NULL,
	"message" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_contact_inquiries_email" ON "contact_inquiries" USING btree ("email");--> statement-breakpoint
CREATE INDEX "idx_contact_inquiries_created_at" ON "contact_inquiries" USING btree ("created_at");