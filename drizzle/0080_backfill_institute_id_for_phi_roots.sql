-- Backfill institute_id on root PHI tables from instituteStudents.
-- Priority: school > clinic > family (active memberships only, earliest as tiebreaker).
-- Only fills NULLs — preserves any existing institute_id assignments.
-- See planning-docs/cross-institute-sharing-plan.md.

WITH ranked_membership AS (
  SELECT
    ins.student_id,
    ins.institute_id,
    ROW_NUMBER() OVER (
      PARTITION BY ins.student_id
      ORDER BY
        CASE i.type
          WHEN 'school' THEN 1
          WHEN 'clinic' THEN 2
          WHEN 'family' THEN 3
          ELSE 4
        END,
        ins.created_at
    ) AS rn
  FROM institute_students ins
  JOIN institutes i ON i.id = ins.institute_id
  WHERE ins.is_active
)
UPDATE programs p
SET institute_id = r.institute_id
FROM ranked_membership r
WHERE r.student_id = p.student_id
  AND r.rn = 1
  AND p.institute_id IS NULL;
--> statement-breakpoint

WITH ranked_membership AS (
  SELECT
    ins.student_id,
    ins.institute_id,
    ROW_NUMBER() OVER (
      PARTITION BY ins.student_id
      ORDER BY
        CASE i.type
          WHEN 'school' THEN 1
          WHEN 'clinic' THEN 2
          WHEN 'family' THEN 3
          ELSE 4
        END,
        ins.created_at
    ) AS rn
  FROM institute_students ins
  JOIN institutes i ON i.id = ins.institute_id
  WHERE ins.is_active
)
UPDATE medical_records m
SET institute_id = r.institute_id
FROM ranked_membership r
WHERE r.student_id = m.student_id
  AND r.rn = 1
  AND m.institute_id IS NULL;
--> statement-breakpoint

WITH ranked_membership AS (
  SELECT
    ins.student_id,
    ins.institute_id,
    ROW_NUMBER() OVER (
      PARTITION BY ins.student_id
      ORDER BY
        CASE i.type
          WHEN 'school' THEN 1
          WHEN 'clinic' THEN 2
          WHEN 'family' THEN 3
          ELSE 4
        END,
        ins.created_at
    ) AS rn
  FROM institute_students ins
  JOIN institutes i ON i.id = ins.institute_id
  WHERE ins.is_active
)
UPDATE functional_reports f
SET institute_id = r.institute_id
FROM ranked_membership r
WHERE r.student_id = f.student_id
  AND r.rn = 1
  AND f.institute_id IS NULL;
--> statement-breakpoint

WITH ranked_membership AS (
  SELECT
    ins.student_id,
    ins.institute_id,
    ROW_NUMBER() OVER (
      PARTITION BY ins.student_id
      ORDER BY
        CASE i.type
          WHEN 'school' THEN 1
          WHEN 'clinic' THEN 2
          WHEN 'family' THEN 3
          ELSE 4
        END,
        ins.created_at
    ) AS rn
  FROM institute_students ins
  JOIN institutes i ON i.id = ins.institute_id
  WHERE ins.is_active
)
UPDATE educational_reports e
SET institute_id = r.institute_id
FROM ranked_membership r
WHERE r.student_id = e.student_id
  AND r.rn = 1
  AND e.institute_id IS NULL;
