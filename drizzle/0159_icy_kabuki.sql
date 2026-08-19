CREATE TABLE "photo_assignments" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"photo_id" varchar NOT NULL,
	"student_id" varchar,
	"institute_id" varchar,
	"caption" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"hidden_from_student" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "photo_assignments_exactly_one_scope" CHECK (("photo_assignments"."student_id" IS NULL) <> ("photo_assignments"."institute_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "photos" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"content_hash" text NOT NULL,
	"s3_key" text NOT NULL,
	"thumb_s3_key" text NOT NULL,
	"mime_type" text DEFAULT 'image/webp' NOT NULL,
	"width" integer,
	"height" integer,
	"byte_size" integer,
	"ai_description" text,
	"ai_described_at" timestamp,
	"source" text DEFAULT 'upload' NOT NULL,
	"source_media_item_id" text,
	"taken_at" timestamp,
	"created_by_user_id" varchar,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "photo_assignments" ADD CONSTRAINT "photo_assignments_photo_id_photos_id_fk" FOREIGN KEY ("photo_id") REFERENCES "public"."photos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "photo_assignments" ADD CONSTRAINT "photo_assignments_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "photos" ADD CONSTRAINT "photos_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_photo_assignments_photo_student" ON "photo_assignments" USING btree ("photo_id","student_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_photo_assignments_photo_institute" ON "photo_assignments" USING btree ("photo_id","institute_id");--> statement-breakpoint
CREATE INDEX "idx_photo_assignments_student_id" ON "photo_assignments" USING btree ("student_id");--> statement-breakpoint
CREATE INDEX "idx_photo_assignments_institute_id" ON "photo_assignments" USING btree ("institute_id");--> statement-breakpoint
CREATE INDEX "idx_photo_assignments_photo_id" ON "photo_assignments" USING btree ("photo_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_photos_content_hash" ON "photos" USING btree ("content_hash");--> statement-breakpoint
CREATE INDEX "idx_photos_source_media_item" ON "photos" USING btree ("source_media_item_id");