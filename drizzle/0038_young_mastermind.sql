ALTER TABLE "public"."institutes" ALTER COLUMN "type" SET DATA TYPE text;--> statement-breakpoint
UPDATE "public"."institutes" SET "type" = 'clinic' WHERE "type" = 'hospital';--> statement-breakpoint
DROP TYPE "public"."institute_type";--> statement-breakpoint
CREATE TYPE "public"."institute_type" AS ENUM('school', 'clinic');--> statement-breakpoint
ALTER TABLE "public"."institutes" ALTER COLUMN "type" SET DATA TYPE "public"."institute_type" USING "type"::"public"."institute_type";