CREATE TABLE "venue_menus" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"venue_id" varchar NOT NULL,
	"language" text DEFAULT 'en' NOT NULL,
	"currency" text,
	"items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"provenance" text NOT NULL,
	"source_url" text,
	"binding_basis" text NOT NULL,
	"binding_country" text,
	"binding_branch_match" text DEFAULT 'unknown' NOT NULL,
	"status" text DEFAULT 'pending_review' NOT NULL,
	"extracted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reviewed_by_user_id" varchar,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "venues" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" text NOT NULL,
	"source_id" text NOT NULL,
	"name" text NOT NULL,
	"latitude" double precision NOT NULL,
	"longitude" double precision NOT NULL,
	"address" text,
	"venue_type" text,
	"cuisine" text,
	"website_uri" text,
	"country_code" text,
	"brand_key" text,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "student_venues" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"student_id" varchar NOT NULL,
	"venue_id" varchar NOT NULL,
	"board_id" varchar,
	"label" text,
	"is_favorite" boolean DEFAULT false NOT NULL,
	"last_visited_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "aac_settings" ADD COLUMN "venue_menus" jsonb DEFAULT '{}'::jsonb;--> statement-breakpoint
ALTER TABLE "venue_menus" ADD CONSTRAINT "venue_menus_venue_id_venues_id_fk" FOREIGN KEY ("venue_id") REFERENCES "public"."venues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_venues" ADD CONSTRAINT "student_venues_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_venues" ADD CONSTRAINT "student_venues_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_venue_menus_venue_id" ON "venue_menus" USING btree ("venue_id");--> statement-breakpoint
CREATE INDEX "idx_venue_menus_venue_status" ON "venue_menus" USING btree ("venue_id","status");--> statement-breakpoint
CREATE INDEX "idx_venue_menus_provenance" ON "venue_menus" USING btree ("provenance");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_venues_source_source_id" ON "venues" USING btree ("source","source_id");--> statement-breakpoint
CREATE INDEX "idx_venues_lat_lng" ON "venues" USING btree ("latitude","longitude");--> statement-breakpoint
CREATE INDEX "idx_venues_brand_key" ON "venues" USING btree ("brand_key");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_student_venues_student_venue" ON "student_venues" USING btree ("student_id","venue_id");--> statement-breakpoint
CREATE INDEX "idx_student_venues_student_id" ON "student_venues" USING btree ("student_id");--> statement-breakpoint
CREATE INDEX "idx_student_venues_venue_id" ON "student_venues" USING btree ("venue_id");