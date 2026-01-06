CREATE TYPE "public"."institute_invite_status" AS ENUM('pending', 'accepted', 'declined', 'expired', 'cancelled');--> statement-breakpoint
CREATE TABLE "institute_invites" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institute_id" varchar NOT NULL,
	"invitee_email" text NOT NULL,
	"invitee_user_id" varchar,
	"invited_by_user_id" varchar NOT NULL,
	"role" text DEFAULT 'staff' NOT NULL,
	"grant_admin" boolean DEFAULT false NOT NULL,
	"token" text NOT NULL,
	"status" "institute_invite_status" DEFAULT 'pending' NOT NULL,
	"message" text,
	"expires_at" timestamp NOT NULL,
	"responded_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "institute_invites_token_unique" UNIQUE("token")
);
--> statement-breakpoint
ALTER TABLE "students" ADD COLUMN "first_name" text;--> statement-breakpoint
ALTER TABLE "students" ADD COLUMN "last_name" text;--> statement-breakpoint
ALTER TABLE "institute_invites" ADD CONSTRAINT "institute_invites_institute_id_institutes_id_fk" FOREIGN KEY ("institute_id") REFERENCES "public"."institutes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "institute_invites" ADD CONSTRAINT "institute_invites_invitee_user_id_users_id_fk" FOREIGN KEY ("invitee_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "institute_invites" ADD CONSTRAINT "institute_invites_invited_by_user_id_users_id_fk" FOREIGN KEY ("invited_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_institute_invites_institute_id" ON "institute_invites" USING btree ("institute_id");--> statement-breakpoint
CREATE INDEX "idx_institute_invites_invitee_email" ON "institute_invites" USING btree ("invitee_email");--> statement-breakpoint
CREATE INDEX "idx_institute_invites_invitee_user_id" ON "institute_invites" USING btree ("invitee_user_id");--> statement-breakpoint
CREATE INDEX "idx_institute_invites_token" ON "institute_invites" USING btree ("token");--> statement-breakpoint
CREATE INDEX "idx_institute_invites_status" ON "institute_invites" USING btree ("status");