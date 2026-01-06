ALTER TABLE "medical_records" DROP COLUMN "medical_equipment";--> statement-breakpoint
ALTER TABLE "medical_records" ADD COLUMN "medical_equipment" jsonb DEFAULT '[]'::jsonb;--> statement-breakpoint
ALTER TABLE "educational_reports" ADD COLUMN "user_id" varchar;--> statement-breakpoint
ALTER TABLE "educational_reports" ADD COLUMN "communication_mode" jsonb DEFAULT '[]'::jsonb;--> statement-breakpoint
ALTER TABLE "educational_reports" ADD COLUMN "receptive_language" jsonb DEFAULT '[]'::jsonb;--> statement-breakpoint
ALTER TABLE "educational_reports" ADD COLUMN "assistive_technology_used" jsonb DEFAULT '[]'::jsonb;--> statement-breakpoint
ALTER TABLE "educational_reports" ADD COLUMN "reinforcers" jsonb DEFAULT '[]'::jsonb;--> statement-breakpoint
ALTER TABLE "educational_reports" ADD COLUMN "preferred_activities" jsonb DEFAULT '[]'::jsonb;--> statement-breakpoint
ALTER TABLE "educational_reports" ADD COLUMN "behavioral_strategies" jsonb DEFAULT '[]'::jsonb;--> statement-breakpoint
ALTER TABLE "functional_reports" ADD COLUMN "user_id" varchar;--> statement-breakpoint
ALTER TABLE "functional_reports" ADD COLUMN "mobility_status" jsonb DEFAULT '[]'::jsonb;--> statement-breakpoint
ALTER TABLE "functional_reports" ADD COLUMN "adl_status" jsonb DEFAULT '[]'::jsonb;--> statement-breakpoint
ALTER TABLE "functional_reports" ADD COLUMN "sensory_profile" jsonb DEFAULT '[]'::jsonb;--> statement-breakpoint
ALTER TABLE "functional_reports" ADD COLUMN "safety_risks" jsonb DEFAULT '[]'::jsonb;--> statement-breakpoint
ALTER TABLE "medical_records" ADD COLUMN "user_id" varchar;--> statement-breakpoint
ALTER TABLE "medical_records" ADD COLUMN "birth_date" date;--> statement-breakpoint
ALTER TABLE "medical_records" ADD COLUMN "co_morbidities" jsonb DEFAULT '[]'::jsonb;--> statement-breakpoint
ALTER TABLE "medical_records" ADD COLUMN "alerts_allergies" jsonb DEFAULT '[]'::jsonb;--> statement-breakpoint
ALTER TABLE "medical_records" ADD COLUMN "alerts_seizures" jsonb DEFAULT '[]'::jsonb;--> statement-breakpoint
ALTER TABLE "medical_records" ADD COLUMN "alerts_cardiac" jsonb DEFAULT '[]'::jsonb;--> statement-breakpoint
ALTER TABLE "medical_records" ADD COLUMN "status" "report_status" DEFAULT 'draft' NOT NULL;--> statement-breakpoint
ALTER TABLE "medical_records" ADD COLUMN "finalized_at" timestamp;--> statement-breakpoint
ALTER TABLE "password_reset_tokens" ADD COLUMN "token_hash" text NOT NULL;--> statement-breakpoint
ALTER TABLE "password_reset_tokens" ADD COLUMN "used_at" timestamp;--> statement-breakpoint
CREATE INDEX "idx_educational_reports_user_id" ON "educational_reports" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_functional_reports_user_id" ON "functional_reports" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_medical_records_user_id" ON "medical_records" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_medical_records_status" ON "medical_records" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_password_reset_tokens_user_id" ON "password_reset_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_password_reset_tokens_expires_at" ON "password_reset_tokens" USING btree ("expires_at");--> statement-breakpoint
ALTER TABLE "educational_reports" DROP COLUMN "report_type";--> statement-breakpoint
ALTER TABLE "educational_reports" DROP COLUMN "report_title";--> statement-breakpoint
ALTER TABLE "educational_reports" DROP COLUMN "report_date";--> statement-breakpoint
ALTER TABLE "educational_reports" DROP COLUMN "grading_period";--> statement-breakpoint
ALTER TABLE "educational_reports" DROP COLUMN "academic_year";--> statement-breakpoint
ALTER TABLE "educational_reports" DROP COLUMN "author_user_id";--> statement-breakpoint
ALTER TABLE "educational_reports" DROP COLUMN "author_name";--> statement-breakpoint
ALTER TABLE "educational_reports" DROP COLUMN "academic_performance";--> statement-breakpoint
ALTER TABLE "educational_reports" DROP COLUMN "standards_progress";--> statement-breakpoint
ALTER TABLE "educational_reports" DROP COLUMN "test_scores";--> statement-breakpoint
ALTER TABLE "educational_reports" DROP COLUMN "classroom_behavior";--> statement-breakpoint
ALTER TABLE "educational_reports" DROP COLUMN "participation_level";--> statement-breakpoint
ALTER TABLE "educational_reports" DROP COLUMN "social_interactions";--> statement-breakpoint
ALTER TABLE "educational_reports" DROP COLUMN "attendance_summary";--> statement-breakpoint
ALTER TABLE "educational_reports" DROP COLUMN "teacher_notes";--> statement-breakpoint
ALTER TABLE "educational_reports" DROP COLUMN "areas_of_strength";--> statement-breakpoint
ALTER TABLE "educational_reports" DROP COLUMN "areas_for_growth";--> statement-breakpoint
ALTER TABLE "educational_reports" DROP COLUMN "recommended_supports";--> statement-breakpoint
ALTER TABLE "educational_reports" DROP COLUMN "shared_with_guardians";--> statement-breakpoint
ALTER TABLE "educational_reports" DROP COLUMN "shared_at";--> statement-breakpoint
ALTER TABLE "educational_reports" DROP COLUMN "guardian_acknowledged_at";--> statement-breakpoint
ALTER TABLE "educational_reports" DROP COLUMN "document_url";--> statement-breakpoint
ALTER TABLE "functional_reports" DROP COLUMN "report_type";--> statement-breakpoint
ALTER TABLE "functional_reports" DROP COLUMN "report_title";--> statement-breakpoint
ALTER TABLE "functional_reports" DROP COLUMN "report_date";--> statement-breakpoint
ALTER TABLE "functional_reports" DROP COLUMN "evaluation_period_start";--> statement-breakpoint
ALTER TABLE "functional_reports" DROP COLUMN "evaluation_period_end";--> statement-breakpoint
ALTER TABLE "functional_reports" DROP COLUMN "author_user_id";--> statement-breakpoint
ALTER TABLE "functional_reports" DROP COLUMN "author_name";--> statement-breakpoint
ALTER TABLE "functional_reports" DROP COLUMN "author_credentials";--> statement-breakpoint
ALTER TABLE "functional_reports" DROP COLUMN "referral_reason";--> statement-breakpoint
ALTER TABLE "functional_reports" DROP COLUMN "referral_source";--> statement-breakpoint
ALTER TABLE "functional_reports" DROP COLUMN "background_context";--> statement-breakpoint
ALTER TABLE "functional_reports" DROP COLUMN "relevant_history";--> statement-breakpoint
ALTER TABLE "functional_reports" DROP COLUMN "assessment_methods";--> statement-breakpoint
ALTER TABLE "functional_reports" DROP COLUMN "instruments_used";--> statement-breakpoint
ALTER TABLE "functional_reports" DROP COLUMN "assessment_scores";--> statement-breakpoint
ALTER TABLE "functional_reports" DROP COLUMN "observation_data";--> statement-breakpoint
ALTER TABLE "functional_reports" DROP COLUMN "findings";--> statement-breakpoint
ALTER TABLE "functional_reports" DROP COLUMN "strengths";--> statement-breakpoint
ALTER TABLE "functional_reports" DROP COLUMN "areas_of_concern";--> statement-breakpoint
ALTER TABLE "functional_reports" DROP COLUMN "functional_limitations";--> statement-breakpoint
ALTER TABLE "functional_reports" DROP COLUMN "recommendations";--> statement-breakpoint
ALTER TABLE "functional_reports" DROP COLUMN "recommended_services";--> statement-breakpoint
ALTER TABLE "functional_reports" DROP COLUMN "recommended_goals";--> statement-breakpoint
ALTER TABLE "functional_reports" DROP COLUMN "submitted_at";--> statement-breakpoint
ALTER TABLE "functional_reports" DROP COLUMN "reviewed_by";--> statement-breakpoint
ALTER TABLE "functional_reports" DROP COLUMN "reviewed_at";--> statement-breakpoint
ALTER TABLE "functional_reports" DROP COLUMN "finalized_by";--> statement-breakpoint
ALTER TABLE "functional_reports" DROP COLUMN "document_url";--> statement-breakpoint
ALTER TABLE "institute_students" DROP COLUMN "educational_setting";--> statement-breakpoint
ALTER TABLE "institute_students" DROP COLUMN "school";--> statement-breakpoint
ALTER TABLE "institute_students" DROP COLUMN "grade";--> statement-breakpoint
ALTER TABLE "institute_students" DROP COLUMN "classroom";--> statement-breakpoint
ALTER TABLE "medical_records" DROP COLUMN "diagnosis_date";--> statement-breakpoint
ALTER TABLE "medical_records" DROP COLUMN "diagnostician";--> statement-breakpoint
ALTER TABLE "medical_records" DROP COLUMN "idea_classification";--> statement-breakpoint
ALTER TABLE "medical_records" DROP COLUMN "classification_date";--> statement-breakpoint
ALTER TABLE "medical_records" DROP COLUMN "allergies";--> statement-breakpoint
ALTER TABLE "medical_records" DROP COLUMN "dietary_restrictions";--> statement-breakpoint
ALTER TABLE "medical_records" DROP COLUMN "emergency_plan";--> statement-breakpoint
ALTER TABLE "medical_records" DROP COLUMN "seizure_protocol";--> statement-breakpoint
ALTER TABLE "medical_records" DROP COLUMN "hospital_preference";--> statement-breakpoint
ALTER TABLE "medical_records" DROP COLUMN "primary_physician";--> statement-breakpoint
ALTER TABLE "medical_records" DROP COLUMN "specialists";--> statement-breakpoint
ALTER TABLE "medical_records" DROP COLUMN "last_accessed_by";--> statement-breakpoint
ALTER TABLE "medical_records" DROP COLUMN "last_accessed_at";--> statement-breakpoint
ALTER TABLE "medical_records" DROP COLUMN "created_by";--> statement-breakpoint
ALTER TABLE "password_reset_tokens" DROP COLUMN "token";--> statement-breakpoint
ALTER TABLE "password_reset_tokens" DROP COLUMN "is_used";