ALTER TABLE "aac_sessions" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "api_calls" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "audit_logs" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "dropbox_backups" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "dropbox_connections" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "interpretations" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "saved_locations" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE IF EXISTS "aac_sessions" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "api_calls" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "audit_logs" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "dropbox_backups" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "dropbox_connections" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "interpretations" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "saved_locations" CASCADE;--> statement-breakpoint
ALTER TABLE "institutes" ADD COLUMN IF NOT EXISTS "external_storage" varchar;--> statement-breakpoint
ALTER TABLE "students" ADD COLUMN IF NOT EXISTS "external_storage" varchar;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "external_storage" varchar;--> statement-breakpoint
DROP TYPE IF EXISTS "public"."aac_session_status";--> statement-breakpoint
DROP TYPE IF EXISTS "public"."audit_action";