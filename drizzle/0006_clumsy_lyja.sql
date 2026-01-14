CREATE TABLE "user_goals" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar NOT NULL,
	"goal_id" varchar NOT NULL,
	"role" text DEFAULT 'assigned',
	"can_edit" boolean DEFAULT true NOT NULL,
	"can_record_data" boolean DEFAULT true NOT NULL,
	"notify_on_progress" boolean DEFAULT true NOT NULL,
	"notify_on_data_point" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_objectives" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar NOT NULL,
	"objective_id" varchar NOT NULL,
	"role" text DEFAULT 'assigned',
	"can_edit" boolean DEFAULT true NOT NULL,
	"can_record_data" boolean DEFAULT true NOT NULL,
	"notify_on_progress" boolean DEFAULT true NOT NULL,
	"notify_on_data_point" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "goals" DROP CONSTRAINT "goals_profile_domain_id_profile_domains_id_fk";
--> statement-breakpoint
DROP INDEX "idx_goals_domain_id";--> statement-breakpoint
ALTER TABLE "goals" ADD COLUMN "methods" text;--> statement-breakpoint
ALTER TABLE "goals" ADD COLUMN "achieved_date" date;--> statement-breakpoint
ALTER TABLE "objectives" ADD COLUMN "profile_domain_id" varchar;--> statement-breakpoint
ALTER TABLE "objectives" ADD COLUMN "target_behavior" text;--> statement-breakpoint
ALTER TABLE "objectives" ADD COLUMN "methods" text;--> statement-breakpoint
ALTER TABLE "objectives" ADD COLUMN "criteria" text;--> statement-breakpoint
ALTER TABLE "objectives" ADD COLUMN "measurement_method" text;--> statement-breakpoint
ALTER TABLE "objectives" ADD COLUMN "relevance" text;--> statement-breakpoint
ALTER TABLE "objectives" ADD COLUMN "progress" integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE "user_goals" ADD CONSTRAINT "user_goals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_goals" ADD CONSTRAINT "user_goals_goal_id_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."goals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_objectives" ADD CONSTRAINT "user_objectives_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_objectives" ADD CONSTRAINT "user_objectives_objective_id_objectives_id_fk" FOREIGN KEY ("objective_id") REFERENCES "public"."objectives"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_user_goals_user_id" ON "user_goals" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_user_goals_goal_id" ON "user_goals" USING btree ("goal_id");--> statement-breakpoint
CREATE INDEX "idx_user_objectives_user_id" ON "user_objectives" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_user_objectives_objective_id" ON "user_objectives" USING btree ("objective_id");--> statement-breakpoint
ALTER TABLE "objectives" ADD CONSTRAINT "objectives_profile_domain_id_profile_domains_id_fk" FOREIGN KEY ("profile_domain_id") REFERENCES "public"."profile_domains"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_objectives_domain_id" ON "objectives" USING btree ("profile_domain_id");--> statement-breakpoint
ALTER TABLE "goals" DROP COLUMN "profile_domain_id";--> statement-breakpoint
ALTER TABLE "goals" DROP COLUMN "smart_specific";--> statement-breakpoint
ALTER TABLE "goals" DROP COLUMN "smart_measurable";--> statement-breakpoint
ALTER TABLE "goals" DROP COLUMN "smart_achievable";--> statement-breakpoint
ALTER TABLE "goals" DROP COLUMN "smart_relevant";--> statement-breakpoint
ALTER TABLE "goals" DROP COLUMN "smart_time_bound";--> statement-breakpoint
ALTER TABLE "goals" DROP COLUMN "criteria_percentage";--> statement-breakpoint
ALTER TABLE "goals" DROP COLUMN "conditions";--> statement-breakpoint
ALTER TABLE "objectives" DROP COLUMN "criterion";--> statement-breakpoint
ALTER TABLE "objectives" DROP COLUMN "context";