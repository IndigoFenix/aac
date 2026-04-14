CREATE TABLE "user_chat_push_tokens" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar NOT NULL,
	"token" text NOT NULL,
	"platform" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_chat_room_participants" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"room_id" varchar NOT NULL,
	"user_id" varchar NOT NULL,
	"joined_at" timestamp DEFAULT now() NOT NULL,
	"last_read_at" timestamp,
	"left_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "user_chat_rooms" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institute_id" varchar NOT NULL,
	"name" text,
	"is_direct" boolean DEFAULT false NOT NULL,
	"created_by" varchar NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"last_message_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_chats" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"room_id" varchar NOT NULL,
	"sender_id" varchar NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"edited_at" timestamp,
	"deleted_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "user_chat_push_tokens" ADD CONSTRAINT "user_chat_push_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_chat_room_participants" ADD CONSTRAINT "user_chat_room_participants_room_id_user_chat_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."user_chat_rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_chat_room_participants" ADD CONSTRAINT "user_chat_room_participants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_chat_rooms" ADD CONSTRAINT "user_chat_rooms_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_chats" ADD CONSTRAINT "user_chats_room_id_user_chat_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."user_chat_rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_chats" ADD CONSTRAINT "user_chats_sender_id_users_id_fk" FOREIGN KEY ("sender_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_user_chat_push_tokens_user_token" ON "user_chat_push_tokens" USING btree ("user_id","token");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_user_chat_room_participants_room_user" ON "user_chat_room_participants" USING btree ("room_id","user_id");--> statement-breakpoint
CREATE INDEX "idx_user_chat_room_participants_user_id" ON "user_chat_room_participants" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_user_chat_rooms_institute_id" ON "user_chat_rooms" USING btree ("institute_id");--> statement-breakpoint
CREATE INDEX "idx_user_chat_rooms_last_message_at" ON "user_chat_rooms" USING btree ("last_message_at");--> statement-breakpoint
CREATE INDEX "idx_user_chats_room_created" ON "user_chats" USING btree ("room_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_user_chats_sender_id" ON "user_chats" USING btree ("sender_id");