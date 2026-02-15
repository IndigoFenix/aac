CREATE TABLE "student_contacts" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"student_id" varchar NOT NULL,
	"name" text NOT NULL,
	"relationship" text,
	"hair_color" text,
	"estimated_age" text,
	"estimated_sex" text,
	"description" text,
	"context_notes" text,
	"face_embedding" jsonb,
	"voice_embedding" jsonb,
	"last_seen_at" timestamp,
	"times_identified" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "student_contacts" ADD CONSTRAINT "student_contacts_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_student_contacts_student_id" ON "student_contacts" USING btree ("student_id");--> statement-breakpoint
CREATE INDEX "idx_student_contacts_is_active" ON "student_contacts" USING btree ("is_active");