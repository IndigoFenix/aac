ALTER TABLE "students" ADD COLUMN "face_embedding" jsonb;--> statement-breakpoint
ALTER TABLE "students" ADD COLUMN "voice_embedding" jsonb;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "face_embedding" jsonb;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "voice_embedding" jsonb;