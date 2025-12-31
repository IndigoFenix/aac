// server/db.ts
// Database connection that works in both ECS and Lambda environments

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "@shared/schema";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL must be set for Postgres RDS.");
}

const { Pool } = pg;

// Try to find and load RDS CA bundle
function loadCaBundle(): string | null {
  const possiblePaths = [
    path.join(process.cwd(), 'rds-ca-bundle.pem'),
    '/app/rds-ca-bundle.pem',
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'rds-ca-bundle.pem'),
    path.join(path.dirname(fileURLToPath(import.meta.url)), 'rds-ca-bundle.pem'),
  ];

  for (const certPath of possiblePaths) {
    try {
      if (fs.existsSync(certPath)) {
        console.log(`Loaded RDS CA bundle from: ${certPath}`);
        return fs.readFileSync(certPath, 'utf8');
      }
    } catch {
      continue;
    }
  }
  
  console.log('RDS CA bundle not found, using SSL without certificate verification');
  return null;
}

const rdsCa = loadCaBundle();

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: rdsCa 
    ? { ca: rdsCa, rejectUnauthorized: true }
    : { rejectUnauthorized: false }  // Still encrypted, just no cert verification
});

export const db = drizzle(pool, { schema });
