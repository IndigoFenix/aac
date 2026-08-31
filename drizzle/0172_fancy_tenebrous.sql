CREATE TYPE "public"."data_subject_request_kind" AS ENUM('produce', 'correct');--> statement-breakpoint
CREATE TYPE "public"."data_subject_request_status" AS ENUM('open', 'forwarded', 'fulfilled', 'denied', 'withdrawn');--> statement-breakpoint
ALTER TYPE "public"."activity_subject_type" ADD VALUE 'data_subject_request';--> statement-breakpoint
CREATE TABLE "data_subject_requests" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"student_id" varchar NOT NULL,
	"institute_id" varchar,
	"kind" "data_subject_request_kind" NOT NULL,
	"status" "data_subject_request_status" DEFAULT 'open' NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"forward_deadline_at" timestamp with time zone NOT NULL,
	"forwarded_at" timestamp with time zone,
	"requester_description" text,
	"target_table" text,
	"target_record_id" varchar,
	"target_field" text,
	"proposed_value" text,
	"current_value_snapshot" text,
	"decision" text,
	"decision_reason" text,
	"statement_of_disagreement" text,
	"decided_by_user_id" varchar,
	"decided_at" timestamp with time zone,
	"fulfilled_at" timestamp with time zone,
	"notes" text,
	"last_alert_kind" text,
	"last_alert_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "data_subject_requests" ADD CONSTRAINT "data_subject_requests_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_subject_requests" ADD CONSTRAINT "data_subject_requests_decided_by_user_id_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_data_subject_requests_student" ON "data_subject_requests" USING btree ("student_id");--> statement-breakpoint
CREATE INDEX "idx_data_subject_requests_status" ON "data_subject_requests" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_data_subject_requests_forward_deadline" ON "data_subject_requests" USING btree ("forward_deadline_at");