ALTER TABLE "boards" ADD COLUMN "automatic_selection" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "boards" ADD COLUMN "automatic_selection_hint" text;