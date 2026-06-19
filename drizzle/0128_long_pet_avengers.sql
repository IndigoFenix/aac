CREATE TABLE "caption_projects" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar NOT NULL,
	"video_hash" varchar NOT NULL,
	"video_name" text,
	"language" varchar,
	"segments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "caption_projects" ADD CONSTRAINT "caption_projects_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_caption_projects_user_hash" ON "caption_projects" USING btree ("user_id","video_hash");--> statement-breakpoint
CREATE INDEX "idx_caption_projects_user_id" ON "caption_projects" USING btree ("user_id");
