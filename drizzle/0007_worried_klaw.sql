CREATE TABLE "personas" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"icon" text NOT NULL,
	"prompt" text NOT NULL,
	"manual_selection" boolean DEFAULT true NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "topics" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"parent_id" varchar,
	"content" text DEFAULT '' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "is_system_admin" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "topics" ADD CONSTRAINT "topics_parent_id_topics_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."topics"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_personas_active" ON "personas" USING btree ("active");--> statement-breakpoint
CREATE INDEX "idx_personas_manual_selection" ON "personas" USING btree ("manual_selection");--> statement-breakpoint
CREATE INDEX "idx_topics_parent_id" ON "topics" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "idx_topics_active" ON "topics" USING btree ("active");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_topics_title_parent" ON "topics" USING btree ("title","parent_id");