import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';
import fs from 'fs';
import path from 'path';

// Read the RDS CA bundle
const ca = fs.readFileSync(
  path.resolve(__dirname, 'rds-ca-bundle.pem'),
  'utf8',
);

// Parse DATABASE_URL into host/port/user/password/db
if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is not set');
}

const url = new URL(process.env.DATABASE_URL);

export default defineConfig({
  dialect: 'postgresql',
  schema: './shared/schema.ts',
  out: './drizzle',
  dbCredentials: {
    host: url.hostname,
    port: Number(url.port || '5432'),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: url.pathname.slice(1),
    ssl: { ca },
  },
});