-- Change objectives.status default from 'not_started' to 'draft' so new rows
-- pick up the canonical pre-work value. Existing data is untouched.

ALTER TABLE "objectives" ALTER COLUMN "status" SET DEFAULT 'draft';
