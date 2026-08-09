CREATE TABLE "account_link_credentials" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"grant_id" varchar NOT NULL,
	"kind" text NOT NULL,
	"token_hash" text NOT NULL,
	"redirect_uri" text,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "account_link_grants" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"student_id" varchar NOT NULL,
	"provider" text NOT NULL,
	"granted_by_user_id" varchar NOT NULL,
	"client_id" text NOT NULL,
	"redirect_uri" text NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account_link_credentials" ADD CONSTRAINT "account_link_credentials_grant_id_account_link_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."account_link_grants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_link_grants" ADD CONSTRAINT "account_link_grants_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_link_grants" ADD CONSTRAINT "account_link_grants_granted_by_user_id_users_id_fk" FOREIGN KEY ("granted_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_account_link_credentials_hash" ON "account_link_credentials" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "idx_account_link_credentials_grant_id" ON "account_link_credentials" USING btree ("grant_id");--> statement-breakpoint
CREATE INDEX "idx_account_link_credentials_expires_at" ON "account_link_credentials" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_account_link_grants_live" ON "account_link_grants" USING btree ("student_id","provider") WHERE revoked_at IS NULL;--> statement-breakpoint
CREATE INDEX "idx_account_link_grants_student_id" ON "account_link_grants" USING btree ("student_id");