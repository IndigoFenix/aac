CREATE TABLE "custom_symbols" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"s3_key" text NOT NULL,
	"key" text,
	"description" text,
	"is_public" boolean DEFAULT false NOT NULL,
	"is_approved" boolean DEFAULT true NOT NULL,
	"created_by_user_id" varchar,
	"width" integer,
	"height" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "institute_symbol_associations" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"symbol_id" varchar NOT NULL,
	"institute_id" varchar NOT NULL,
	"key" text,
	"description" text,
	"is_approved" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "student_symbol_associations" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"symbol_id" varchar NOT NULL,
	"student_id" varchar NOT NULL,
	"key" text,
	"description" text,
	"is_approved" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_symbol_associations" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"symbol_id" varchar NOT NULL,
	"user_id" varchar NOT NULL,
	"key" text,
	"description" text,
	"is_approved" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "custom_symbols" ADD CONSTRAINT "custom_symbols_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "institute_symbol_associations" ADD CONSTRAINT "institute_symbol_associations_symbol_id_custom_symbols_id_fk" FOREIGN KEY ("symbol_id") REFERENCES "public"."custom_symbols"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "institute_symbol_associations" ADD CONSTRAINT "institute_symbol_associations_institute_id_institutes_id_fk" FOREIGN KEY ("institute_id") REFERENCES "public"."institutes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_symbol_associations" ADD CONSTRAINT "student_symbol_associations_symbol_id_custom_symbols_id_fk" FOREIGN KEY ("symbol_id") REFERENCES "public"."custom_symbols"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_symbol_associations" ADD CONSTRAINT "student_symbol_associations_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_symbol_associations" ADD CONSTRAINT "user_symbol_associations_symbol_id_custom_symbols_id_fk" FOREIGN KEY ("symbol_id") REFERENCES "public"."custom_symbols"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_symbol_associations" ADD CONSTRAINT "user_symbol_associations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_custom_symbols_is_public" ON "custom_symbols" USING btree ("is_public");--> statement-breakpoint
CREATE INDEX "idx_custom_symbols_key" ON "custom_symbols" USING btree ("key");--> statement-breakpoint
CREATE INDEX "idx_custom_symbols_created_by" ON "custom_symbols" USING btree ("created_by_user_id");--> statement-breakpoint
CREATE INDEX "idx_institute_symbol_assoc_symbol_id" ON "institute_symbol_associations" USING btree ("symbol_id");--> statement-breakpoint
CREATE INDEX "idx_institute_symbol_assoc_institute_id" ON "institute_symbol_associations" USING btree ("institute_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_institute_symbol_assoc_unique" ON "institute_symbol_associations" USING btree ("symbol_id","institute_id");--> statement-breakpoint
CREATE INDEX "idx_student_symbol_assoc_symbol_id" ON "student_symbol_associations" USING btree ("symbol_id");--> statement-breakpoint
CREATE INDEX "idx_student_symbol_assoc_student_id" ON "student_symbol_associations" USING btree ("student_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_student_symbol_assoc_unique" ON "student_symbol_associations" USING btree ("symbol_id","student_id");--> statement-breakpoint
CREATE INDEX "idx_user_symbol_assoc_symbol_id" ON "user_symbol_associations" USING btree ("symbol_id");--> statement-breakpoint
CREATE INDEX "idx_user_symbol_assoc_user_id" ON "user_symbol_associations" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_user_symbol_assoc_unique" ON "user_symbol_associations" USING btree ("symbol_id","user_id");