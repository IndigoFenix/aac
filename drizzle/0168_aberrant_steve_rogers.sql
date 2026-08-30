CREATE TYPE "public"."security_incident_event_kind" AS ENUM('opened', 'note', 'status_change', 'notification_sent', 'deadline_warning', 'deadline_missed', 'closed');--> statement-breakpoint
CREATE TYPE "public"."security_incident_kind" AS ENUM('phi_breach', 'security_breach', 'vendor_incident');--> statement-breakpoint
CREATE TYPE "public"."security_incident_severity" AS ENUM('low', 'medium', 'high', 'critical');--> statement-breakpoint
CREATE TYPE "public"."security_incident_status" AS ENUM('open', 'contained', 'notified', 'closed', 'dismissed');--> statement-breakpoint
ALTER TYPE "public"."activity_event_type" ADD VALUE 'security_incident_opened';--> statement-breakpoint
ALTER TYPE "public"."activity_event_type" ADD VALUE 'security_incident_updated';--> statement-breakpoint
ALTER TYPE "public"."activity_event_type" ADD VALUE 'security_incident_notification_sent';--> statement-breakpoint
ALTER TYPE "public"."activity_event_type" ADD VALUE 'security_incident_closed';--> statement-breakpoint
ALTER TYPE "public"."activity_subject_type" ADD VALUE 'security_incident';--> statement-breakpoint
CREATE TABLE "security_incident_events" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"incident_id" varchar NOT NULL,
	"kind" "security_incident_event_kind" NOT NULL,
	"body" text,
	"metadata" jsonb,
	"actor_admin_user_id" varchar,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "security_incidents" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seq" serial NOT NULL,
	"kind" "security_incident_kind" NOT NULL,
	"severity" "security_incident_severity" NOT NULL,
	"status" "security_incident_status" DEFAULT 'open' NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"discovered_at" timestamp with time zone NOT NULL,
	"occurred_at" timestamp with time zone,
	"contained_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"regimes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"regulator_notify_due_at" timestamp with time zone,
	"regulator_notified_at" timestamp with time zone,
	"customer_notify_due_at" timestamp with time zone,
	"customer_notified_at" timestamp with time zone,
	"investigation_report_due_at" timestamp with time zone,
	"investigation_report_sent_at" timestamp with time zone,
	"affected_institute_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"affected_subject_count" integer,
	"affected_scope" text,
	"opened_by_admin_user_id" varchar,
	"closed_at" timestamp with time zone,
	"closure_summary" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "security_incidents_seq_unique" UNIQUE("seq")
);
--> statement-breakpoint
ALTER TABLE "security_incident_events" ADD CONSTRAINT "security_incident_events_incident_id_security_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."security_incidents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_incident_events" ADD CONSTRAINT "security_incident_events_actor_admin_user_id_admin_users_id_fk" FOREIGN KEY ("actor_admin_user_id") REFERENCES "public"."admin_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_incidents" ADD CONSTRAINT "security_incidents_opened_by_admin_user_id_admin_users_id_fk" FOREIGN KEY ("opened_by_admin_user_id") REFERENCES "public"."admin_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_security_incident_events_incident" ON "security_incident_events" USING btree ("incident_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_security_incidents_status" ON "security_incidents" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_security_incidents_discovered_at" ON "security_incidents" USING btree ("discovered_at");--> statement-breakpoint
CREATE INDEX "idx_security_incidents_regulator_due" ON "security_incidents" USING btree ("regulator_notify_due_at");--> statement-breakpoint
CREATE INDEX "idx_security_incidents_customer_due" ON "security_incidents" USING btree ("customer_notify_due_at");--> statement-breakpoint
CREATE INDEX "idx_security_incidents_report_due" ON "security_incidents" USING btree ("investigation_report_due_at");