-- Backfill a persons row for every existing user and student that lacks one.
-- Persons are the canonical chat/call membership identity above users/students.
-- Idempotent + re-runnable (NOT EXISTS guard + ON CONFLICT on the unique facet
-- indexes). New rows are provisioned at creation time in the repositories.

INSERT INTO "persons" ("user_id")
SELECT u."id" FROM "users" u
WHERE NOT EXISTS (SELECT 1 FROM "persons" p WHERE p."user_id" = u."id")
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "persons" ("student_id")
SELECT s."id" FROM "students" s
WHERE NOT EXISTS (SELECT 1 FROM "persons" p WHERE p."student_id" = s."id")
ON CONFLICT DO NOTHING;
