/**
 * Memory Field Index Validator
 *
 * Scans server/services/memory-schema/*.ts for memory fields that declare
 * `searchable: { fields: [...] }` and verifies the matching table has a GIN
 * trigram index on each listed column.
 *
 * The contract is: declaring `searchable` on a memory field is a promise that
 * list() performs efficient string search. Without a trigram (or equivalent)
 * index, that promise degrades silently as the table grows. This validator
 * fails CI if the index is missing.
 *
 * Usage: npx tsx scripts/validate-memory-indexes.ts
 *
 * The script must be run with DATABASE_URL set in the environment (same as
 * regular migrations). It connects read-only and inspects pg_indexes.
 *
 * Exit code 0 on success, 1 on any missing index.
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import pg from "pg";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const SCHEMA_DIR = path.join(ROOT, "server", "services", "memory-schema");

interface SearchableDecl {
  file: string;
  fieldId: string;
  searchableFields: string[];
  table?: string;
}

/**
 * Parse a schema file for `searchable: { fields: [...] }` declarations,
 * pairing each with its nearest enclosing `id: "..."`. Also extracts an
 * optional co-located `searchTable: "..."` marker that schemas should set
 * when the underlying table is not obvious from the id.
 *
 * This is a regex scan, not a full TS parse — schemas must use plain literals
 * for these fields (no computed values).
 */
function parseSchemaFile(filePath: string): SearchableDecl[] {
  const src = fs.readFileSync(filePath, "utf-8");
  const decls: SearchableDecl[] = [];

  const searchableRe = /searchable\s*:\s*\{\s*fields\s*:\s*\[([^\]]*)\]\s*\}/g;
  let m: RegExpExecArray | null;
  while ((m = searchableRe.exec(src)) !== null) {
    const fieldsRaw = m[1];
    const searchableFields = [...fieldsRaw.matchAll(/"([^"]+)"|'([^']+)'/g)].map(
      x => x[1] || x[2]
    );

    // Walk backwards from the match to find the nearest `id: "..."`.
    const before = src.slice(0, m.index);
    const idMatch = [...before.matchAll(/id\s*:\s*["']([^"']+)["']/g)].pop();
    const tableMatch = [...before.matchAll(/searchTable\s*:\s*["']([^"']+)["']/g)].pop();

    decls.push({
      file: path.relative(ROOT, filePath),
      fieldId: idMatch?.[1] ?? "(unknown)",
      searchableFields,
      table: tableMatch?.[1],
    });
  }
  return decls;
}

function scanAll(): SearchableDecl[] {
  if (!fs.existsSync(SCHEMA_DIR)) return [];
  const files = fs.readdirSync(SCHEMA_DIR).filter(f => f.endsWith(".ts"));
  const all: SearchableDecl[] = [];
  for (const f of files) {
    all.push(...parseSchemaFile(path.join(SCHEMA_DIR, f)));
  }
  return all;
}

async function checkIndexes(decls: SearchableDecl[]): Promise<string[]> {
  const errors: string[] = [];
  if (decls.length === 0) return errors;

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    errors.push("DATABASE_URL not set — cannot verify indexes.");
    return errors;
  }

  const { Client } = pg;
  // Strip sslmode from URL — pg treats URL sslmode as overriding ssl opts.
  const connectionString = databaseUrl.replace(/[?&]sslmode=[^&]*/g, "");
  const client = new Client({
    connectionString,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    for (const d of decls) {
      if (!d.table) {
        errors.push(
          `[${d.file}] Field '${d.fieldId}' declares 'searchable' without a co-located 'searchTable' marker — the validator cannot verify its index. Add:  searchTable: "<table_name>"  next to the searchable declaration.`
        );
        continue;
      }
      const res = await client.query<{ indexdef: string }>(
        `SELECT indexdef FROM pg_indexes WHERE tablename = $1`,
        [d.table]
      );
      const defs = res.rows.map(r => r.indexdef.toLowerCase());
      for (const col of d.searchableFields) {
        const hasIndex = defs.some(
          def =>
            def.includes("gin") &&
            def.includes(col.toLowerCase()) &&
            (def.includes("gin_trgm_ops") || def.includes("to_tsvector"))
        );
        if (!hasIndex) {
          errors.push(
            `[${d.file}] Field '${d.fieldId}' → table '${d.table}' column '${col}' has no GIN trigram / tsvector index. Add a migration.`
          );
        }
      }
    }
  } finally {
    await client.end();
  }
  return errors;
}

async function main() {
  const decls = scanAll();
  if (decls.length === 0) {
    console.log("No 'searchable' fields declared. OK.");
    process.exit(0);
  }

  console.log(`Found ${decls.length} searchable field declaration(s):`);
  for (const d of decls) {
    console.log(
      `  - ${d.file}: ${d.fieldId} [${d.searchableFields.join(", ")}]${d.table ? ` @ ${d.table}` : ""}`
    );
  }

  const errors = await checkIndexes(decls);
  if (errors.length) {
    console.error("\nIndex validation failed:");
    for (const e of errors) console.error("  " + e);
    process.exit(1);
  }
  console.log("\nAll searchable fields are backed by GIN trigram / tsvector indexes. OK.");
  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
