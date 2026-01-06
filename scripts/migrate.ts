import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ca = fs.readFileSync(
  path.resolve(__dirname, '../rds-ca-bundle.pem'),
  'utf8',
);

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is not set');
}

const url = new URL(process.env.DATABASE_URL);

const pool = new pg.Pool({
  host: url.hostname,
  port: Number(url.port || '5432'),
  user: decodeURIComponent(url.username),
  password: decodeURIComponent(url.password),
  database: url.pathname.slice(1),
  ssl: { ca },
});

const db = drizzle(pool);

async function runMigrations() {
  console.log('🔍 Checking migration status...\n');
  
  const client = await pool.connect();
  
  try {
    // Ensure migrations table exists
    await client.query(`
      CREATE SCHEMA IF NOT EXISTS drizzle;
      CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
        id SERIAL PRIMARY KEY,
        hash text NOT NULL,
        created_at bigint
      );
    `);

    // Get current migration count
    const result = await client.query('SELECT COUNT(*) as count FROM drizzle.__drizzle_migrations');
    const appliedCount = parseInt(result.rows[0].count);
    
    // Read journal to see what migrations exist
    const journalPath = './drizzle/meta/_journal.json';
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
    const totalMigrations = journal.entries.length;
    
    console.log(`📊 Migrations applied: ${appliedCount}/${totalMigrations}`);
    
    if (appliedCount >= totalMigrations) {
      console.log('✅ All migrations are up to date!\n');
      return;
    }
    
    // Apply pending migrations
    const pendingMigrations = journal.entries.slice(appliedCount);
    console.log(`\n🚀 Applying ${pendingMigrations.length} pending migration(s)...\n`);
    
    for (const migration of pendingMigrations) {
      const migrationFile = `./drizzle/${migration.tag}.sql`;
      console.log(`📝 Applying: ${migration.tag}`);
      
      const sql = fs.readFileSync(migrationFile, 'utf8');
      const statements = sql
        .split('--> statement-breakpoint')
        .map(s => s.trim())
        .filter(s => s.length > 0);
      
      console.log(`   Found ${statements.length} statement(s)`);
      
      // Begin transaction
      await client.query('BEGIN');
      
      try {
        // Execute each statement
        for (let i = 0; i < statements.length; i++) {
          const statement = statements[i];
          try {
            await client.query(statement);
            console.log(`   ✓ Statement ${i + 1}/${statements.length}`);
          } catch (error: any) {
            console.error(`   ✗ Statement ${i + 1} failed:`);
            console.error(`     SQL: ${statement.substring(0, 100)}...`);
            console.error(`     Error: ${error.message}`);
            throw error;
          }
        }
        
        // Update migrations table
        const hash = String(appliedCount + pendingMigrations.indexOf(migration) + 1);
        const createdAt = Date.now();
        await client.query(
          'INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)',
          [hash, createdAt]
        );
        
        await client.query('COMMIT');
        console.log(`   ✅ Migration ${migration.tag} applied successfully\n`);
        
      } catch (error) {
        await client.query('ROLLBACK');
        console.error(`   ❌ Migration ${migration.tag} failed and was rolled back\n`);
        throw error;
      }
    }
    
    console.log('🎉 All migrations completed successfully!\n');
    
  } catch (error) {
    console.error('\n❌ Migration process failed:', error);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

runMigrations();