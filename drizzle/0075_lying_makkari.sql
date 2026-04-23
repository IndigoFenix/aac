ALTER TABLE "calendar_events" ADD COLUMN "institute_id" varchar;--> statement-breakpoint
ALTER TABLE "calendar_events" ADD COLUMN "classroom_id" varchar;--> statement-breakpoint
ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_institute_id_institutes_id_fk" FOREIGN KEY ("institute_id") REFERENCES "public"."institutes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_classroom_id_classrooms_id_fk" FOREIGN KEY ("classroom_id") REFERENCES "public"."classrooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_calendar_events_institute_id" ON "calendar_events" USING btree ("institute_id");--> statement-breakpoint
CREATE INDEX "idx_calendar_events_classroom_id" ON "calendar_events" USING btree ("classroom_id");