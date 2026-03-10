ALTER TABLE "personas" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "personas" ADD COLUMN "test_mode" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "personas" ADD COLUMN "institute_id" varchar;--> statement-breakpoint
ALTER TABLE "personas" ADD CONSTRAINT "personas_institute_id_institutes_id_fk" FOREIGN KEY ("institute_id") REFERENCES "public"."institutes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_personas_institute_id" ON "personas" USING btree ("institute_id");