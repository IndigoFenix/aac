// server/db.ts
// Database connection for AWS RDS

import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "@shared/schema";
import { resolveDbSsl } from "./db-ssl.js";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL must be set for Postgres RDS.");
}

const { Pool } = pg;

// Remove sslmode from URL — we configure SSL explicitly below.
// node-postgres URL params override Pool options, causing cert verification failures with RDS.
const connectionString = process.env.DATABASE_URL.replace(/[?&]sslmode=[^&]*/g, '');

export const pool = new Pool({
  connectionString,
  ssl: resolveDbSsl(process.env.DATABASE_URL),
  max: 3,
  idleTimeoutMillis: 30000,
});

export const db = drizzle(pool, { schema });

/** A drizzle transaction handle, or the root db when no transaction is open. */
export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
/** Anything a query can run on — lets a helper join a caller's transaction. */
export type Executor = typeof db | Tx;