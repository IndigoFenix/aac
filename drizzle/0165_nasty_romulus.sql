CREATE TABLE "ws_ticket_nonces" (
	"nonce" varchar(64) PRIMARY KEY NOT NULL,
	"expires_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE INDEX "IDX_ws_ticket_nonces_expires" ON "ws_ticket_nonces" USING btree ("expires_at");