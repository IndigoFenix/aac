CREATE TABLE "aac_session_plans" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"student_id" varchar NOT NULL,
	"identity" jsonb,
	"situations" jsonb DEFAULT '[]'::jsonb,
	"goals" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "aac_session_plans_student_id_unique" UNIQUE("student_id")
);
--> statement-breakpoint
ALTER TABLE "aac_session_plans" ADD CONSTRAINT "aac_session_plans_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_aac_session_plans_student_id" ON "aac_session_plans" USING btree ("student_id");