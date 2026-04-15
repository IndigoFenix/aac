CREATE TABLE "custom_app_assignments" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app_id" varchar NOT NULL,
	"student_id" varchar NOT NULL,
	"assigned_by_user_id" varchar,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "custom_apps" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar NOT NULL,
	"institute_id" varchar,
	"type" text DEFAULT 'game' NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"image_url" text,
	"definition" jsonb NOT NULL,
	"language" text DEFAULT 'en',
	"is_generated" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"loaded_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "custom_app_assignments" ADD CONSTRAINT "custom_app_assignments_app_id_custom_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."custom_apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_app_assignments" ADD CONSTRAINT "custom_app_assignments_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_app_assignments" ADD CONSTRAINT "custom_app_assignments_assigned_by_user_id_users_id_fk" FOREIGN KEY ("assigned_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_apps" ADD CONSTRAINT "custom_apps_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_custom_app_assignments_app_student" ON "custom_app_assignments" USING btree ("app_id","student_id");--> statement-breakpoint
CREATE INDEX "idx_custom_app_assignments_student_id" ON "custom_app_assignments" USING btree ("student_id");--> statement-breakpoint
CREATE INDEX "idx_custom_apps_user_id" ON "custom_apps" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_custom_apps_institute_id" ON "custom_apps" USING btree ("institute_id");