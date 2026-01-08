CREATE TYPE "public"."classroom_role" AS ENUM('lead_teacher', 'co_teacher', 'therapist', 'aide', 'observer');--> statement-breakpoint
CREATE TYPE "public"."grade" AS ENUM('pre_k', 'k', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', 'special_ed', 'adult_ed');--> statement-breakpoint
CREATE TYPE "public"."institute_role" AS ENUM('admin', 'director', 'teacher', 'therapist', 'aide', 'staff', 'observer');--> statement-breakpoint
CREATE TABLE "classroom_users" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"classroom_id" varchar NOT NULL,
	"user_id" varchar NOT NULL,
	"role" text DEFAULT 'teacher' NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "classrooms" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institute_id" varchar NOT NULL,
	"name" text NOT NULL,
	"grade" "grade",
	"description" text,
	"capacity" integer,
	"room_number" text,
	"academic_year" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "student_classrooms" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"student_id" varchar NOT NULL,
	"classroom_id" varchar NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"enrollment_date" date,
	"exit_date" date,
	"notes" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "institute_students" ADD COLUMN "exit_date" date;--> statement-breakpoint
ALTER TABLE "institute_students" ADD COLUMN "exit_reason" text;--> statement-breakpoint
ALTER TABLE "institute_students" ADD COLUMN "grade" "grade";--> statement-breakpoint
ALTER TABLE "classroom_users" ADD CONSTRAINT "classroom_users_classroom_id_classrooms_id_fk" FOREIGN KEY ("classroom_id") REFERENCES "public"."classrooms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "classroom_users" ADD CONSTRAINT "classroom_users_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "classrooms" ADD CONSTRAINT "classrooms_institute_id_institutes_id_fk" FOREIGN KEY ("institute_id") REFERENCES "public"."institutes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_classrooms" ADD CONSTRAINT "student_classrooms_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_classrooms" ADD CONSTRAINT "student_classrooms_classroom_id_classrooms_id_fk" FOREIGN KEY ("classroom_id") REFERENCES "public"."classrooms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_classroom_users_classroom_id" ON "classroom_users" USING btree ("classroom_id");--> statement-breakpoint
CREATE INDEX "idx_classroom_users_user_id" ON "classroom_users" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_classroom_users_is_active" ON "classroom_users" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "idx_classrooms_institute_id" ON "classrooms" USING btree ("institute_id");--> statement-breakpoint
CREATE INDEX "idx_classrooms_is_active" ON "classrooms" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "idx_classrooms_grade" ON "classrooms" USING btree ("grade");--> statement-breakpoint
CREATE INDEX "idx_student_classrooms_student_id" ON "student_classrooms" USING btree ("student_id");--> statement-breakpoint
CREATE INDEX "idx_student_classrooms_classroom_id" ON "student_classrooms" USING btree ("classroom_id");--> statement-breakpoint
CREATE INDEX "idx_student_classrooms_is_active" ON "student_classrooms" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "idx_institute_students_is_active" ON "institute_students" USING btree ("is_active");