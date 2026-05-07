CREATE TABLE "clinician_activity_intervals" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar NOT NULL,
	"student_id" varchar,
	"institute_id" varchar,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"tab_closed" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_clinician_activity_user" ON "clinician_activity_intervals" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_clinician_activity_student" ON "clinician_activity_intervals" USING btree ("student_id");--> statement-breakpoint
CREATE INDEX "idx_clinician_activity_institute" ON "clinician_activity_intervals" USING btree ("institute_id");--> statement-breakpoint
CREATE INDEX "idx_clinician_activity_started_at" ON "clinician_activity_intervals" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "idx_clinician_activity_open" ON "clinician_activity_intervals" USING btree ("user_id","ended_at");