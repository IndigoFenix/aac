-- Unify goal_status and objective_status into a single plan_item_status enum
-- so goals, objectives, and transition_goals all accept the same value set.
-- Preserves existing data (all prior values are valid in the unified enum).

CREATE TYPE "public"."plan_item_status" AS ENUM(
  'draft',
  'not_started',
  'active',
  'in_progress',
  'achieved',
  'modified',
  'discontinued'
);
--> statement-breakpoint

ALTER TABLE "goals" ALTER COLUMN "status" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "goals" ALTER COLUMN "status" TYPE "public"."plan_item_status" USING "status"::text::"public"."plan_item_status";
--> statement-breakpoint
ALTER TABLE "goals" ALTER COLUMN "status" SET DEFAULT 'draft';
--> statement-breakpoint

ALTER TABLE "objectives" ALTER COLUMN "status" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "objectives" ALTER COLUMN "status" TYPE "public"."plan_item_status" USING "status"::text::"public"."plan_item_status";
--> statement-breakpoint
ALTER TABLE "objectives" ALTER COLUMN "status" SET DEFAULT 'not_started';
--> statement-breakpoint

ALTER TABLE "transition_goals" ALTER COLUMN "status" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "transition_goals" ALTER COLUMN "status" TYPE "public"."plan_item_status" USING "status"::text::"public"."plan_item_status";
--> statement-breakpoint
ALTER TABLE "transition_goals" ALTER COLUMN "status" SET DEFAULT 'draft';
--> statement-breakpoint

DROP TYPE "public"."goal_status";
--> statement-breakpoint
DROP TYPE "public"."objective_status";
