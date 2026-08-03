CREATE TABLE "package_boards" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"package_id" varchar NOT NULL,
	"board_id" varchar NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"auto_load" boolean DEFAULT true NOT NULL,
	"added_by_user_id" varchar,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "package_grants" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"package_id" varchar NOT NULL,
	"grantee_user_id" varchar NOT NULL,
	"permission" text DEFAULT 'use' NOT NULL,
	"granted_by_user_id" varchar,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "packages" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institute_id" varchar,
	"type" text DEFAULT 'board' NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"image_url" text,
	"language" text DEFAULT 'en',
	"visibility" text DEFAULT 'institute' NOT NULL,
	"default_member_permission" text DEFAULT 'use' NOT NULL,
	"approval_status" text DEFAULT 'none' NOT NULL,
	"published_at" timestamp,
	"published_by_user_id" varchar,
	"publish_attestation" jsonb,
	"link_count" integer DEFAULT 0 NOT NULL,
	"deleted_at" timestamp,
	"created_by_user_id" varchar,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "packages_live_has_owner" CHECK ("packages"."deleted_at" IS NOT NULL OR "packages"."institute_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "package_assignments" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"package_id" varchar NOT NULL,
	"student_id" varchar NOT NULL,
	"institute_id" varchar,
	"assigned_by_user_id" varchar,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "boards" ADD COLUMN "scope" text DEFAULT 'student' NOT NULL;--> statement-breakpoint
ALTER TABLE "boards" ADD COLUMN "institute_id" varchar;--> statement-breakpoint
ALTER TABLE "package_boards" ADD CONSTRAINT "package_boards_package_id_packages_id_fk" FOREIGN KEY ("package_id") REFERENCES "public"."packages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_boards" ADD CONSTRAINT "package_boards_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_boards" ADD CONSTRAINT "package_boards_added_by_user_id_users_id_fk" FOREIGN KEY ("added_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_grants" ADD CONSTRAINT "package_grants_package_id_packages_id_fk" FOREIGN KEY ("package_id") REFERENCES "public"."packages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_grants" ADD CONSTRAINT "package_grants_grantee_user_id_users_id_fk" FOREIGN KEY ("grantee_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_grants" ADD CONSTRAINT "package_grants_granted_by_user_id_users_id_fk" FOREIGN KEY ("granted_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packages" ADD CONSTRAINT "packages_institute_id_institutes_id_fk" FOREIGN KEY ("institute_id") REFERENCES "public"."institutes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packages" ADD CONSTRAINT "packages_published_by_user_id_users_id_fk" FOREIGN KEY ("published_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packages" ADD CONSTRAINT "packages_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_assignments" ADD CONSTRAINT "package_assignments_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_assignments" ADD CONSTRAINT "package_assignments_assigned_by_user_id_users_id_fk" FOREIGN KEY ("assigned_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_package_boards_package_board" ON "package_boards" USING btree ("package_id","board_id");--> statement-breakpoint
CREATE INDEX "idx_package_boards_board_id" ON "package_boards" USING btree ("board_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_package_grants_package_user" ON "package_grants" USING btree ("package_id","grantee_user_id");--> statement-breakpoint
CREATE INDEX "idx_package_grants_grantee" ON "package_grants" USING btree ("grantee_user_id");--> statement-breakpoint
CREATE INDEX "idx_packages_institute_id" ON "packages" USING btree ("institute_id");--> statement-breakpoint
CREATE INDEX "idx_packages_visibility_approval" ON "packages" USING btree ("visibility","approval_status");--> statement-breakpoint
CREATE INDEX "idx_packages_deleted_at" ON "packages" USING btree ("deleted_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_package_assignments_package_student" ON "package_assignments" USING btree ("package_id","student_id");--> statement-breakpoint
CREATE INDEX "idx_package_assignments_student_id" ON "package_assignments" USING btree ("student_id");--> statement-breakpoint
CREATE INDEX "idx_package_assignments_institute_id" ON "package_assignments" USING btree ("institute_id");--> statement-breakpoint
CREATE INDEX "idx_boards_scope_institute" ON "boards" USING btree ("scope","institute_id");--> statement-breakpoint
ALTER TABLE "boards" ADD CONSTRAINT "boards_package_scope_has_no_student" CHECK ("boards"."scope" <> 'package' OR ("boards"."student_id" IS NULL AND "boards"."institute_id" IS NOT NULL));