-- Drop old tables (existed before schema removal; may have different columns)
DROP TABLE IF EXISTS "dropbox_backups" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "dropbox_connections" CASCADE;
--> statement-breakpoint
CREATE TABLE "dropbox_backups" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar NOT NULL,
	"board_id" varchar,
	"board_name" text NOT NULL,
	"file_type" text NOT NULL,
	"file_name" text NOT NULL,
	"dropbox_path" text,
	"dropbox_file_id" text,
	"file_size_bytes" integer,
	"status" text DEFAULT 'pending' NOT NULL,
	"shareable_url" text,
	"error_message" text,
	"upload_duration_ms" integer,
	"completed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dropbox_connections" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar NOT NULL,
	"dropbox_account_id" text,
	"dropbox_email" text,
	"encrypted_access_token" text,
	"encrypted_refresh_token" text,
	"token_expires_at" timestamp,
	"backup_folder_path" text DEFAULT '/Apps/CliniAACian/Boards',
	"auto_backup_enabled" boolean DEFAULT false,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "dropbox_connections_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
ALTER TABLE "dropbox_backups" ADD CONSTRAINT "dropbox_backups_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dropbox_backups" ADD CONSTRAINT "dropbox_backups_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dropbox_connections" ADD CONSTRAINT "dropbox_connections_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_dropbox_backups_user_id" ON "dropbox_backups" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_dropbox_backups_board_id" ON "dropbox_backups" USING btree ("board_id");--> statement-breakpoint
CREATE INDEX "idx_dropbox_connections_user_id" ON "dropbox_connections" USING btree ("user_id");
