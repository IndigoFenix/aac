CREATE TYPE "public"."gas_level" AS ENUM('much_less_than_expected', 'less_than_expected', 'expected', 'better_than_expected', 'much_better_than_expected');--> statement-breakpoint
CREATE TYPE "public"."gas_varying_variable" AS ENUM('achievement', 'mediation', 'time', 'frequency');--> statement-breakpoint
ALTER TABLE "data_points" ADD COLUMN "achieved_level" "gas_level";--> statement-breakpoint
ALTER TABLE "goals" ADD COLUMN "use_gas" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "goals" ADD COLUMN "gas_varying_variable" "gas_varying_variable";--> statement-breakpoint
ALTER TABLE "goals" ADD COLUMN "gas_baseline_level" "gas_level";--> statement-breakpoint
ALTER TABLE "goals" ADD COLUMN "gas_levels" jsonb DEFAULT '{}'::jsonb;--> statement-breakpoint
ALTER TABLE "goals" ADD COLUMN "client_importance_rating" integer;--> statement-breakpoint
ALTER TABLE "goals" ADD COLUMN "set_jointly_with_family" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "goals" ADD COLUMN "family_input" text;--> statement-breakpoint
ALTER TABLE "programs" ADD COLUMN "personal_factors" jsonb DEFAULT '{}'::jsonb;--> statement-breakpoint
ALTER TABLE "programs" ADD COLUMN "environmental_factors" jsonb DEFAULT '{}'::jsonb;