CREATE TABLE "person_chat_push_tokens" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar NOT NULL,
	"token" text NOT NULL,
	"platform" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "person_chat_room_participants" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"room_id" varchar NOT NULL,
	"person_id" varchar NOT NULL,
	"joined_at" timestamp DEFAULT now() NOT NULL,
	"last_read_at" timestamp,
	"left_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "person_chat_rooms" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institute_id" varchar NOT NULL,
	"name" text,
	"is_direct" boolean DEFAULT false NOT NULL,
	"created_by_person_id" varchar NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"last_message_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "person_chats" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"room_id" varchar NOT NULL,
	"sender_person_id" varchar NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"edited_at" timestamp,
	"deleted_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "persons" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar,
	"student_id" varchar,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP TABLE "user_chat_push_tokens" CASCADE;--> statement-breakpoint
DROP TABLE "user_chat_room_participants" CASCADE;--> statement-breakpoint
DROP TABLE "user_chat_rooms" CASCADE;--> statement-breakpoint
DROP TABLE "user_chats" CASCADE;--> statement-breakpoint
ALTER TABLE "person_chat_push_tokens" ADD CONSTRAINT "person_chat_push_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_chat_room_participants" ADD CONSTRAINT "person_chat_room_participants_room_id_person_chat_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."person_chat_rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_chat_room_participants" ADD CONSTRAINT "person_chat_room_participants_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_chat_rooms" ADD CONSTRAINT "person_chat_rooms_created_by_person_id_persons_id_fk" FOREIGN KEY ("created_by_person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_chats" ADD CONSTRAINT "person_chats_room_id_person_chat_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."person_chat_rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_chats" ADD CONSTRAINT "person_chats_sender_person_id_persons_id_fk" FOREIGN KEY ("sender_person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "persons" ADD CONSTRAINT "persons_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "persons" ADD CONSTRAINT "persons_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_person_chat_push_tokens_user_token" ON "person_chat_push_tokens" USING btree ("user_id","token");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_person_chat_room_participants_room_person" ON "person_chat_room_participants" USING btree ("room_id","person_id");--> statement-breakpoint
CREATE INDEX "idx_person_chat_room_participants_person_id" ON "person_chat_room_participants" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "idx_person_chat_rooms_institute_id" ON "person_chat_rooms" USING btree ("institute_id");--> statement-breakpoint
CREATE INDEX "idx_person_chat_rooms_last_message_at" ON "person_chat_rooms" USING btree ("last_message_at");--> statement-breakpoint
CREATE INDEX "idx_person_chats_room_created" ON "person_chats" USING btree ("room_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_person_chats_sender_person_id" ON "person_chats" USING btree ("sender_person_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_persons_user_id" ON "persons" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_persons_student_id" ON "persons" USING btree ("student_id");