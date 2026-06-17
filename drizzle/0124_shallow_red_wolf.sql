CREATE TABLE "calendar_event_locations" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" varchar NOT NULL,
	"location_id" varchar NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "locations" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institute_id" varchar NOT NULL,
	"title" text NOT NULL,
	"address" text,
	"latitude" double precision NOT NULL,
	"longitude" double precision NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by_user_id" varchar NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "calendar_event_locations" ADD CONSTRAINT "calendar_event_locations_event_id_calendar_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."calendar_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_event_locations" ADD CONSTRAINT "calendar_event_locations_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "locations" ADD CONSTRAINT "locations_institute_id_institutes_id_fk" FOREIGN KEY ("institute_id") REFERENCES "public"."institutes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "locations" ADD CONSTRAINT "locations_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_event_locations_event_location" ON "calendar_event_locations" USING btree ("event_id","location_id");--> statement-breakpoint
CREATE INDEX "idx_event_locations_event_id" ON "calendar_event_locations" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "idx_event_locations_location_id" ON "calendar_event_locations" USING btree ("location_id");--> statement-breakpoint
CREATE INDEX "idx_locations_institute_id" ON "locations" USING btree ("institute_id");--> statement-breakpoint
CREATE INDEX "idx_locations_lat_lng" ON "locations" USING btree ("latitude","longitude");