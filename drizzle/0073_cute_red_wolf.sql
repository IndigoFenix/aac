CREATE TABLE "service_users" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"service_id" varchar NOT NULL,
	"user_id" varchar NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "calendar_events" ADD COLUMN "service_id" varchar;--> statement-breakpoint
ALTER TABLE "service_users" ADD CONSTRAINT "service_users_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_users" ADD CONSTRAINT "service_users_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_service_users_service_id" ON "service_users" USING btree ("service_id");--> statement-breakpoint
CREATE INDEX "idx_service_users_user_id" ON "service_users" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_calendar_events_service_id" ON "calendar_events" USING btree ("service_id");--> statement-breakpoint
ALTER TABLE "services" DROP COLUMN "frequency_count";--> statement-breakpoint
ALTER TABLE "services" DROP COLUMN "frequency_period";--> statement-breakpoint
ALTER TABLE "services" DROP COLUMN "session_duration";--> statement-breakpoint
DROP TYPE "public"."service_frequency_period";