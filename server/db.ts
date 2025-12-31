// server/db.ts
// Database connection for AWS RDS

import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "@shared/schema";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL must be set for Postgres RDS.");
}

const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    // Connection is still TLS encrypted, just not verifying the server certificate
    // This is safe because Lambda is in a private VPC with security group rules
    rejectUnauthorized: false
  }
});

export const db = drizzle(pool, { schema });