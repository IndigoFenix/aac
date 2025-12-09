/**
 * Migration: AAC Users Many-to-Many Relationship
 * 
 * This migration converts the AAC user system from a one-to-many relationship
 * (where each AAC user belongs to one user) to a many-to-many relationship
 * (where AAC users can be shared between multiple users).
 * 
 * Changes:
 * 1. Create new user_students junction table
 * 2. Remove userId from students (move to junction table)
 * 3. Remove studentId field (use id as primary key everywhere)
 * 4. Rename 'alias' to 'name'
 * 5. Replace 'age' (integer) with 'birth_date' (date)
 * 6. Update all referencing tables to use students.id instead of student_id
 * 
 * Run this migration with: npx tsx migrations/students-many-to-many.ts
 */

import { sql } from "drizzle-orm";
import { db } from "./db";

interface OldStudent {
  id: string;
  user_id: string;
  student_id: string;
  alias: string;
  gender: string | null;
  age: number | null;
  disability_or_syndrome: string | null;
  background_context: string | null;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

interface StudentIdMapping {
  oldStudentId: string;  // The text student_id field
  newId: string;         // The varchar id (primary key)
}

async function migrate() {
  console.log("Starting AAC Users Many-to-Many Migration...\n");

  try {
    // Step 1: Create backup tables
    console.log("Step 1: Creating backup tables...");
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS students_backup AS 
      SELECT * FROM students;
    `);
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS student_schedules_backup AS 
      SELECT * FROM student_schedules;
    `);
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS interpretations_backup AS 
      SELECT * FROM interpretations;
    `);
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS invite_codes_backup AS 
      SELECT * FROM invite_codes;
    `);
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS invite_code_redemptions_backup AS 
      SELECT * FROM invite_code_redemptions;
    `);
    console.log("✓ Backup tables created\n");

    // Step 2: Get all existing AAC users for mapping
    console.log("Step 2: Building studentId -> id mapping...");
    const existingStudents = await db.execute<OldStudent>(sql`
      SELECT id, user_id, student_id, alias, gender, age, 
             disability_or_syndrome, background_context, 
             is_active, created_at, updated_at
      FROM students
    `);
    
    const idMapping: StudentIdMapping[] = existingStudents.rows.map((row) => ({
      oldStudentId: row.student_id,
      newId: row.id,
    }));
    console.log(`✓ Found ${idMapping.length} AAC users to migrate\n`);

    // Step 3: Create the junction table
    console.log("Step 3: Creating user_students junction table...");
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS user_students (
        id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id VARCHAR NOT NULL REFERENCES users(id),
        student_id VARCHAR NOT NULL REFERENCES students(id),
        role TEXT DEFAULT 'caregiver',
        is_active BOOLEAN DEFAULT true NOT NULL,
        created_at TIMESTAMP DEFAULT now() NOT NULL,
        updated_at TIMESTAMP DEFAULT now() NOT NULL
      );
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS idx_user_students_user_id ON user_students(user_id);
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS idx_user_students_student_id ON user_students(student_id);
    `);
    console.log("✓ Junction table created\n");

    // Step 4: Populate junction table from existing relationships
    console.log("Step 4: Populating junction table with existing relationships...");
    const insertedLinks = await db.execute(sql`
      INSERT INTO user_students (user_id, student_id, role, is_active, created_at, updated_at)
      SELECT 
        user_id, 
        id as student_id, 
        'owner' as role,  -- Original creator becomes owner
        is_active,
        created_at,
        updated_at
      FROM students
      WHERE user_id IS NOT NULL
      RETURNING id;
    `);
    console.log(`✓ Created ${insertedLinks.rowCount} user-student links\n`);

    // Step 5: Add birth_date column and migrate age data
    console.log("Step 5: Adding birth_date column and migrating age data...");
    
    // Add birth_date column if it doesn't exist
    await db.execute(sql`
      ALTER TABLE students 
      ADD COLUMN IF NOT EXISTS birth_date DATE;
    `);

    // Convert age to approximate birth date (using current date - age years)
    // This is an approximation since we don't have the actual birth date
    await db.execute(sql`
      UPDATE students 
      SET birth_date = (CURRENT_DATE - (age * INTERVAL '1 year'))::DATE
      WHERE age IS NOT NULL AND birth_date IS NULL;
    `);
    console.log("✓ Birth date column added and populated\n");

    // Step 6: Rename alias to name
    console.log("Step 6: Renaming 'alias' column to 'name'...");
    await db.execute(sql`
      ALTER TABLE students 
      RENAME COLUMN alias TO name;
    `);
    console.log("✓ Column renamed\n");

    // Step 7: Update student_schedules foreign key
    console.log("Step 7: Updating student_schedules foreign key...");
    
    // First, add a new column for the varchar reference
    await db.execute(sql`
      ALTER TABLE student_schedules 
      ADD COLUMN IF NOT EXISTS student_id_new VARCHAR;
    `);

    // Update the new column with the correct id based on the old student_id
    await db.execute(sql`
      UPDATE student_schedules s
      SET student_id_new = a.id
      FROM students a
      WHERE s.student_id = a.student_id;
    `);

    // Drop the old foreign key constraint if it exists
    await db.execute(sql`
      ALTER TABLE student_schedules 
      DROP CONSTRAINT IF EXISTS student_schedules_student_id_students_student_id_fk;
    `);

    // Drop the old column and rename the new one
    await db.execute(sql`
      ALTER TABLE student_schedules DROP COLUMN IF EXISTS student_id;
    `);
    await db.execute(sql`
      ALTER TABLE student_schedules RENAME COLUMN student_id_new TO student_id;
    `);

    // Add the new foreign key constraint
    await db.execute(sql`
      ALTER TABLE student_schedules 
      ADD CONSTRAINT student_schedules_student_id_fk 
      FOREIGN KEY (student_id) REFERENCES students(id);
    `);

    // Add is_active column if it doesn't exist
    await db.execute(sql`
      ALTER TABLE student_schedules 
      ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true NOT NULL;
    `);
    console.log("✓ student_schedules updated\n");

    // Step 8: Update interpretations foreign key
    console.log("Step 8: Updating interpretations foreign key...");
    
    // Add new column
    await db.execute(sql`
      ALTER TABLE interpretations 
      ADD COLUMN IF NOT EXISTS student_id_new VARCHAR;
    `);

    // Update with correct id
    await db.execute(sql`
      UPDATE interpretations i
      SET student_id_new = a.id
      FROM students a
      WHERE i.student_id = a.student_id;
    `);

    // Drop old constraint
    await db.execute(sql`
      ALTER TABLE interpretations 
      DROP CONSTRAINT IF EXISTS interpretations_student_id_students_student_id_fk;
    `);

    // Replace column
    await db.execute(sql`
      ALTER TABLE interpretations DROP COLUMN IF EXISTS student_id;
    `);
    await db.execute(sql`
      ALTER TABLE interpretations RENAME COLUMN student_id_new TO student_id;
    `);

    // Add new constraint
    await db.execute(sql`
      ALTER TABLE interpretations 
      ADD CONSTRAINT interpretations_student_id_fk 
      FOREIGN KEY (student_id) REFERENCES students(id);
    `);

    // Rename student_alias to student_name
    await db.execute(sql`
      ALTER TABLE interpretations 
      RENAME COLUMN student_alias TO student_name;
    `);
    console.log("✓ interpretations updated\n");

    // Step 9: Update invite_codes foreign key
    console.log("Step 9: Updating invite_codes foreign key...");
    
    // Add new column
    await db.execute(sql`
      ALTER TABLE invite_codes 
      ADD COLUMN IF NOT EXISTS student_id_new VARCHAR;
    `);

    // Update with correct id
    await db.execute(sql`
      UPDATE invite_codes ic
      SET student_id_new = a.id
      FROM students a
      WHERE ic.student_id = a.student_id;
    `);

    // Drop old constraint
    await db.execute(sql`
      ALTER TABLE invite_codes 
      DROP CONSTRAINT IF EXISTS invite_codes_student_id_students_student_id_fk;
    `);

    // Replace column
    await db.execute(sql`
      ALTER TABLE invite_codes DROP COLUMN IF EXISTS student_id;
    `);
    await db.execute(sql`
      ALTER TABLE invite_codes RENAME COLUMN student_id_new TO student_id;
    `);

    // Add new constraint
    await db.execute(sql`
      ALTER TABLE invite_codes 
      ADD CONSTRAINT invite_codes_student_id_fk 
      FOREIGN KEY (student_id) REFERENCES students(id);
    `);
    console.log("✓ invite_codes updated\n");

    // Step 10: Update invite_code_redemptions foreign key
    console.log("Step 10: Updating invite_code_redemptions foreign key...");
    
    // Add new column
    await db.execute(sql`
      ALTER TABLE invite_code_redemptions 
      ADD COLUMN IF NOT EXISTS student_id_new VARCHAR;
    `);

    // Update with correct id
    await db.execute(sql`
      UPDATE invite_code_redemptions icr
      SET student_id_new = a.id
      FROM students a
      WHERE icr.student_id = a.student_id;
    `);

    // Drop old constraint
    await db.execute(sql`
      ALTER TABLE invite_code_redemptions 
      DROP CONSTRAINT IF EXISTS invite_code_redemptions_student_id_students_student_id_fk;
    `);

    // Replace column
    await db.execute(sql`
      ALTER TABLE invite_code_redemptions DROP COLUMN IF EXISTS student_id;
    `);
    await db.execute(sql`
      ALTER TABLE invite_code_redemptions RENAME COLUMN student_id_new TO student_id;
    `);

    // Add new constraint
    await db.execute(sql`
      ALTER TABLE invite_code_redemptions 
      ADD CONSTRAINT invite_code_redemptions_student_id_fk 
      FOREIGN KEY (student_id) REFERENCES students(id);
    `);
    console.log("✓ invite_code_redemptions updated\n");

    // Step 11: Remove old columns from students
    console.log("Step 11: Cleaning up students table...");
    
    // Drop the unique constraint on student_id
    await db.execute(sql`
      ALTER TABLE students 
      DROP CONSTRAINT IF EXISTS students_student_id_unique;
    `);

    // Drop the old columns
    await db.execute(sql`
      ALTER TABLE students DROP COLUMN IF EXISTS user_id;
    `);
    await db.execute(sql`
      ALTER TABLE students DROP COLUMN IF EXISTS student_id;
    `);
    await db.execute(sql`
      ALTER TABLE students DROP COLUMN IF EXISTS age;
    `);
    console.log("✓ Old columns removed from students\n");

    // Step 12: Verify migration
    console.log("Step 12: Verifying migration...");
    
    const junctionCount = await db.execute(sql`
      SELECT COUNT(*) as count FROM user_students;
    `);
    const studentCount = await db.execute(sql`
      SELECT COUNT(*) as count FROM students;
    `);
    const schedulesWithNullStudentId = await db.execute(sql`
      SELECT COUNT(*) as count FROM student_schedules WHERE student_id IS NULL;
    `);
    const interpretationsWithNullStudentId = await db.execute(sql`
      SELECT COUNT(*) as count FROM interpretations WHERE student_id IS NOT NULL AND student_id NOT IN (SELECT id FROM students);
    `);

    console.log(`  - Junction table entries: ${junctionCount.rows[0].count}`);
    console.log(`  - Total AAC users: ${studentCount.rows[0].count}`);
    console.log(`  - Schedules with null student_id: ${schedulesWithNullStudentId.rows[0].count}`);
    console.log(`  - Interpretations with invalid student_id: ${interpretationsWithNullStudentId.rows[0].count}`);
    console.log("✓ Verification complete\n");

    console.log("=".repeat(60));
    console.log("Migration completed successfully!");
    console.log("=".repeat(60));
    console.log("\nBackup tables created:");
    console.log("  - students_backup");
    console.log("  - student_schedules_backup");
    console.log("  - interpretations_backup");
    console.log("  - invite_codes_backup");
    console.log("  - invite_code_redemptions_backup");
    console.log("\nYou can drop these backup tables once you've verified everything is working.");

  } catch (error) {
    console.error("\n❌ Migration failed:", error);
    console.error("\nTo rollback, you can restore from the backup tables:");
    console.error("  DROP TABLE IF EXISTS students;");
    console.error("  ALTER TABLE students_backup RENAME TO students;");
    console.error("  (repeat for other tables)");
    throw error;
  }
}

// Rollback function (use with caution)
async function rollback() {
  console.log("Starting rollback...\n");

  try {
    // Drop the new junction table
    await db.execute(sql`DROP TABLE IF EXISTS user_students;`);

    // Restore from backups
    await db.execute(sql`DROP TABLE IF EXISTS students;`);
    await db.execute(sql`ALTER TABLE students_backup RENAME TO students;`);

    await db.execute(sql`DROP TABLE IF EXISTS student_schedules;`);
    await db.execute(sql`ALTER TABLE student_schedules_backup RENAME TO student_schedules;`);

    await db.execute(sql`DROP TABLE IF EXISTS interpretations;`);
    await db.execute(sql`ALTER TABLE interpretations_backup RENAME TO interpretations;`);

    await db.execute(sql`DROP TABLE IF EXISTS invite_codes;`);
    await db.execute(sql`ALTER TABLE invite_codes_backup RENAME TO invite_codes;`);

    await db.execute(sql`DROP TABLE IF EXISTS invite_code_redemptions;`);
    await db.execute(sql`ALTER TABLE invite_code_redemptions_backup RENAME TO invite_code_redemptions;`);

    console.log("✓ Rollback completed");
  } catch (error) {
    console.error("❌ Rollback failed:", error);
    throw error;
  }
}

// Export for use in other scripts
export { migrate, rollback };

// Run migration if executed directly
const args = process.argv.slice(2);
if (args.includes("--rollback")) {
  rollback()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
} else {
  migrate()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}