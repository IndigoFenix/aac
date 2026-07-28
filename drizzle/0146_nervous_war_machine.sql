CREATE TYPE "public"."verbal_ability" AS ENUM('none', 'vocalizations', 'single_words', 'fluent');--> statement-breakpoint
ALTER TABLE "students" ADD COLUMN "verbal_ability" "verbal_ability";