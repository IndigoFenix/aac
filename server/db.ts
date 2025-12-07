import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "@shared/schema";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL must be set for Postgres RDS.");
}

const { Pool } = pg;

const rdsCa = fs.readFileSync(
  path.join(process.cwd(), "rds-ca-bundle.pem"),
  "utf8"
);

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    ca: rdsCa,
    rejectUnauthorized: true
  },
});

export const db = drizzle(pool, { schema });
