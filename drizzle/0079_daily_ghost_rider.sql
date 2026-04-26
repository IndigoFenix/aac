CREATE TYPE "public"."share_invite_status" AS ENUM('pending_guardian', 'pending_target', 'pending_target_confirm', 'accepted', 'declined', 'revoked', 'expired');--> statement-breakpoint
CREATE TYPE "public"."share_permission" AS ENUM('read', 'write');--> statement-breakpoint
CREATE TYPE "public"."shareable_object_type" AS ENUM('program', 'medical_record', 'functional_report', 'educational_report', 'incident', 'deep_analysis', 'custom_app_assignment', 'monitor_note');--> statement-breakpoint
ALTER TYPE "public"."activity_event_type" ADD VALUE 'share_invite_created';--> statement-breakpoint
ALTER TYPE "public"."activity_event_type" ADD VALUE 'share_guardian_approved';--> statement-breakpoint
ALTER TYPE "public"."activity_event_type" ADD VALUE 'share_redeemed';--> statement-breakpoint
ALTER TYPE "public"."activity_event_type" ADD VALUE 'share_accepted';--> statement-breakpoint
ALTER TYPE "public"."activity_event_type" ADD VALUE 'share_declined';--> statement-breakpoint
ALTER TYPE "public"."activity_event_type" ADD VALUE 'share_revoked';--> statement-breakpoint
ALTER TYPE "public"."activity_event_type" ADD VALUE 'share_expired';--> statement-breakpoint
ALTER TYPE "public"."activity_event_type" ADD VALUE 'standing_share_granted';--> statement-breakpoint
ALTER TYPE "public"."activity_event_type" ADD VALUE 'standing_share_revoked';--> statement-breakpoint
ALTER TYPE "public"."activity_subject_type" ADD VALUE 'share_invite';--> statement-breakpoint
ALTER TYPE "public"."activity_subject_type" ADD VALUE 'object_share';--> statement-breakpoint
ALTER TYPE "public"."activity_subject_type" ADD VALUE 'standing_share';--> statement-breakpoint
CREATE TABLE "object_shares" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"object_type" "shareable_object_type" NOT NULL,
	"object_id" varchar NOT NULL,
	"student_id" varchar NOT NULL,
	"source_institute_id" varchar,
	"target_institute_id" varchar NOT NULL,
	"permission" "share_permission" DEFAULT 'read' NOT NULL,
	"share_invite_id" varchar NOT NULL,
	"share_expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_by_user_id" varchar,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "standing_shares" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"student_id" varchar NOT NULL,
	"target_institute_id" varchar NOT NULL,
	"object_types" "shareable_object_type"[] NOT NULL,
	"permission" "share_permission" DEFAULT 'read' NOT NULL,
	"share_invite_id" varchar NOT NULL,
	"share_expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by_user_id" varchar,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "student_share_invites" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"student_id" varchar NOT NULL,
	"source_institute_id" varchar,
	"target_institute_id" varchar,
	"code_hash" text NOT NULL,
	"created_by_user_id" varchar NOT NULL,
	"guardian_user_id" varchar NOT NULL,
	"guardian_approved_at" timestamp with time zone,
	"redeemed_at" timestamp with time zone,
	"redeemed_by_user_id" varchar,
	"accepted_at" timestamp with time zone,
	"accepted_by_user_id" varchar,
	"status" "share_invite_status" DEFAULT 'pending_guardian' NOT NULL,
	"message" text,
	"share_expires_at" timestamp with time zone,
	"code_expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "custom_app_assignments" ADD COLUMN "institute_id" varchar;--> statement-breakpoint
ALTER TABLE "deep_analyses" ADD COLUMN "institute_id" varchar;--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "institute_id" varchar;--> statement-breakpoint
ALTER TABLE "object_shares" ADD CONSTRAINT "object_shares_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "object_shares" ADD CONSTRAINT "object_shares_share_invite_id_student_share_invites_id_fk" FOREIGN KEY ("share_invite_id") REFERENCES "public"."student_share_invites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "object_shares" ADD CONSTRAINT "object_shares_revoked_by_user_id_users_id_fk" FOREIGN KEY ("revoked_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "standing_shares" ADD CONSTRAINT "standing_shares_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "standing_shares" ADD CONSTRAINT "standing_shares_share_invite_id_student_share_invites_id_fk" FOREIGN KEY ("share_invite_id") REFERENCES "public"."student_share_invites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "standing_shares" ADD CONSTRAINT "standing_shares_revoked_by_user_id_users_id_fk" FOREIGN KEY ("revoked_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_share_invites" ADD CONSTRAINT "student_share_invites_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_share_invites" ADD CONSTRAINT "student_share_invites_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_share_invites" ADD CONSTRAINT "student_share_invites_guardian_user_id_users_id_fk" FOREIGN KEY ("guardian_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_share_invites" ADD CONSTRAINT "student_share_invites_redeemed_by_user_id_users_id_fk" FOREIGN KEY ("redeemed_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_share_invites" ADD CONSTRAINT "student_share_invites_accepted_by_user_id_users_id_fk" FOREIGN KEY ("accepted_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_object_shares_target_lookup" ON "object_shares" USING btree ("target_institute_id","object_type","student_id");--> statement-breakpoint
CREATE INDEX "idx_object_shares_object" ON "object_shares" USING btree ("object_type","object_id");--> statement-breakpoint
CREATE INDEX "idx_object_shares_invite_id" ON "object_shares" USING btree ("share_invite_id");--> statement-breakpoint
CREATE INDEX "idx_standing_shares_target_student" ON "standing_shares" USING btree ("target_institute_id","student_id");--> statement-breakpoint
CREATE INDEX "idx_standing_shares_invite_id" ON "standing_shares" USING btree ("share_invite_id");--> statement-breakpoint
CREATE INDEX "idx_student_share_invites_student_id" ON "student_share_invites" USING btree ("student_id");--> statement-breakpoint
CREATE INDEX "idx_student_share_invites_source_institute_id" ON "student_share_invites" USING btree ("source_institute_id");--> statement-breakpoint
CREATE INDEX "idx_student_share_invites_target_institute_id" ON "student_share_invites" USING btree ("target_institute_id");--> statement-breakpoint
CREATE INDEX "idx_student_share_invites_status" ON "student_share_invites" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_student_share_invites_code_hash" ON "student_share_invites" USING btree ("code_hash");--> statement-breakpoint
CREATE INDEX "idx_custom_app_assignments_institute_id" ON "custom_app_assignments" USING btree ("institute_id");--> statement-breakpoint
CREATE INDEX "idx_deep_analyses_institute_id" ON "deep_analyses" USING btree ("institute_id");--> statement-breakpoint
CREATE INDEX "idx_incidents_institute_id" ON "incidents" USING btree ("institute_id");