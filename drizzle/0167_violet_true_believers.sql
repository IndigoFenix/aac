CREATE TABLE "student_caretaker_pins" (
	"student_id" varchar PRIMARY KEY NOT NULL,
	"pin_hash" text NOT NULL,
	"updated_by_user_id" varchar,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "student_caretaker_pins" ADD CONSTRAINT "student_caretaker_pins_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE cascade ON UPDATE no action;