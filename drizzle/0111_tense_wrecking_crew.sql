-- Migration 0111: classroom_id on chat_sessions
--
-- Adds classroom_id to chat_sessions to support classroom-mode AAC sessions
-- (multi-student boards on a shared classroom screen). When set, the session
-- belongs to a classroom; studentId may still be set within the session to
-- track the currently active student.
--
-- Cross-schema FK to classrooms.id is intentionally omitted, matching the
-- existing pattern for chat_sessions.institute_id (added in 0067).
--
-- Note: db:generate also picked up unsnapshotted-but-applied statements from
-- migrations 0107-0110 (admin auth, unified youtube items, consent id-verify).
-- Those were trimmed here because re-applying them would error out on
-- existing-column. The 0111 snapshot captures the now-correct cumulative
-- schema so future generates produce clean diffs.
ALTER TABLE "chat_sessions" ADD COLUMN "classroom_id" varchar;--> statement-breakpoint
CREATE INDEX "idx_chat_sessions_classroom_id" ON "chat_sessions" USING btree ("classroom_id");
