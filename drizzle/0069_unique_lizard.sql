CREATE TABLE "biometric_data" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"face_embedding" jsonb,
	"voice_embedding" jsonb,
	"face_image_url" text,
	"face_image_quality" real,
	"hair_color" text,
	"eye_color" text,
	"estimated_age" text,
	"estimated_sex" text,
	"physical_description" text,
	"identifying_features" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "program_contacts" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"program_id" varchar NOT NULL,
	"contact_id" varchar NOT NULL,
	"program_role" "team_member_role",
	"responsibilities" text[],
	"is_coordinator" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "provider_contact_id" varchar;--> statement-breakpoint
ALTER TABLE "student_contacts" ADD COLUMN "linked_user_id" varchar;--> statement-breakpoint
ALTER TABLE "student_contacts" ADD COLUMN "linked_student_id" varchar;--> statement-breakpoint
ALTER TABLE "student_contacts" ADD COLUMN "biometric_data_id" varchar;--> statement-breakpoint
ALTER TABLE "student_contacts" ADD COLUMN "role" "team_member_role";--> statement-breakpoint
ALTER TABLE "student_contacts" ADD COLUMN "custom_role" text;--> statement-breakpoint
ALTER TABLE "student_contacts" ADD COLUMN "organization" text;--> statement-breakpoint
ALTER TABLE "student_contacts" ADD COLUMN "contact_email" text;--> statement-breakpoint
ALTER TABLE "student_contacts" ADD COLUMN "contact_phone" text;--> statement-breakpoint
ALTER TABLE "students" ADD COLUMN "biometric_data_id" varchar;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "biometric_data_id" varchar;--> statement-breakpoint
ALTER TABLE "program_contacts" ADD CONSTRAINT "program_contacts_program_id_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."programs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "program_contacts" ADD CONSTRAINT "program_contacts_contact_id_student_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."student_contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_program_contacts_program_id" ON "program_contacts" USING btree ("program_id");--> statement-breakpoint
CREATE INDEX "idx_program_contacts_contact_id" ON "program_contacts" USING btree ("contact_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_program_contacts_program_contact" ON "program_contacts" USING btree ("program_id","contact_id");--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_provider_contact_id_student_contacts_id_fk" FOREIGN KEY ("provider_contact_id") REFERENCES "public"."student_contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_contacts" ADD CONSTRAINT "student_contacts_linked_user_id_users_id_fk" FOREIGN KEY ("linked_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_contacts" ADD CONSTRAINT "student_contacts_linked_student_id_students_id_fk" FOREIGN KEY ("linked_student_id") REFERENCES "public"."students"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_contacts" ADD CONSTRAINT "student_contacts_biometric_data_id_biometric_data_id_fk" FOREIGN KEY ("biometric_data_id") REFERENCES "public"."biometric_data"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_student_contacts_linked_user_id" ON "student_contacts" USING btree ("linked_user_id");--> statement-breakpoint
CREATE INDEX "idx_student_contacts_linked_student_id" ON "student_contacts" USING btree ("linked_student_id");--> statement-breakpoint
CREATE INDEX "idx_student_contacts_biometric_data_id" ON "student_contacts" USING btree ("biometric_data_id");