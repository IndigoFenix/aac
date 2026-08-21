/**
 * Staging → Production data migration (filtered copy).
 *
 * Plan: planning-docs/staging-to-prod-data-migration.md
 *
 * What it does
 *   • Tier 0 "global" tables: every row, overwrite on prod (personas: insert-only).
 *   • Tier 1/2 tenant data: closure of the confirmed LICENSES — their institutes,
 *     those institutes' users and students, and every row reachable from them
 *     through foreign keys (real constraints read from pg_catalog PLUS the
 *     project's soft-FK naming convention, e.g. `student_id` without a constraint).
 *   • Excluded: admins, indigofenix0* test accounts, `[SIM] …` students, and all
 *     session/log/token tables (see SKIP below).
 *   • Integrity: an included row whose FK points outside the copied set gets that
 *     column NULLed when nullable (e.g. a board authored by an admin keeps the
 *     board, loses the author); a NOT NULL dangling FK drops the row — and the
 *     drop cascades. Every fix-up is reported in the dry run.
 *
 * Usage
 *   npm run db-tunnel                                  # terminal 1 (prod via SSM)
 *   npx tsx scripts/migrate-staging-to-prod.ts         # dry run (default), staging is read-only
 *   npx tsx scripts/migrate-staging-to-prod.ts --apply # writes prod in ONE transaction
 *
 * Flags
 *   --apply              perform the write (otherwise dry-run)
 *   --overwrite-tenant   tenant rows also ON CONFLICT DO UPDATE (default: DO NOTHING)
 *   --skip-snapshot-check  don't require a prod RDS snapshot from the last 2h
 *   --licenses=id,id     override the confirmed license ids
 *   --out=path           where to write the dry-run report JSON
 *
 * Env: DATABASE_URL = staging (from .env). PROD_DATABASE_URL, or Secrets Manager
 * via AWS_PROFILE=aac through the tunnel (same discovery as copy-tables-to-prod.ts).
 */

import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import pg from "pg";
import * as readline from "readline";
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { execFileSync } from "child_process";
import {
  type FkEdge,
  type TableClass,
  classifyTables,
  computeClosure,
  topoOrderTables,
  orderRowsBySelfFk,
  SOFT_FK_CONVENTION,
} from "./lib/migration-closure";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });
const { Client } = pg;

// ---------------------------------------------------------------------------
// Configuration — confirmed by the user 2026-08-21
// ---------------------------------------------------------------------------

/** Licenses to copy (planning-docs table, rows 1–4). */
const DEFAULT_LICENSE_IDS = [
  "13a53b3e-921d-4fbd-a9a2-af431d9ee0a5", // redacted-user-1@example.invalid — My Clinic
  "1bd16acb-de03-460c-9bc9-f999da027b9e", // redacted-user-3@example.invalid — קלינקה רז טננבאום
  "9f730fec-42d0-422f-b7f5-93aae62a1d98", // Redacted_Family_A
  "f5156d8a-9475-4db4-b5b7-7156381ed303", // Redacted_Family_B
];

/** Users never copied, regardless of institute membership. */
const EXCLUDED_USER_EMAIL_PATTERNS = [/^indigofenix0\d@gmail\.com$/i, /@aivota\.ai$/i];
const SIM_NAME_PREFIX = "[SIM] ";

/** Every table in public schema must appear in exactly one list (preflight enforces it). */
export const TABLE_CLASSES: Record<Exclude<TableClass, "tenant">, string[]> = {
  seed: ["licenses", "institutes", "users", "students"],
  global: [
    "system_settings", "api_providers", "api_provider_pricing", "topics", "voices",
    "credit_packages", "subscription_plans", "revenuecat_products", "venues", "venue_menus",
    "custom_symbols",
  ],
  globalInsertOnly: ["personas"],
  pull: ["biometric_data", "photos"],
  skip: [
    // auth / admin / tokens
    "sessions", "admin_users", "admin_password_reset_tokens", "admin_mfa_recovery_tokens",
    "identity_providers", "user_external_identities", "password_reset_tokens",
    "mfa_recovery_tokens", "phone_otp_codes", "account_link_credentials",
    // session / telemetry / logs
    "chat_sessions", "session_debug_logs", "session_cost_events", "aac_utterance_events",
    "clinician_activity_intervals", "activity_logs", "api_calls", "audit_logs", "person_chats", "person_chat_push_tokens",
    "call_sessions", "call_participants",
    // integrations / misc
    "dropbox_connections", "dropbox_backups", "caption_projects", "revenuecat_webhook_events",
    "contact_inquiries", "crm_potential_customers",
    // dropped by migrations but still present on staging (stale leftovers, not in Drizzle).
    // Any OTHER staging-only tenant table is auto-skipped with a warning in preflight.
    "aac_sessions", "interpretations", "saved_locations",
  ],
};
// Everything else in the schema is "tenant": included when reachable from the seed sets.

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const args = new Map<string, string>();
for (const a of process.argv.slice(2)) {
  const [k, v] = a.replace(/^--/, "").split("=");
  args.set(k, v ?? "true");
}
const APPLY = args.get("apply") === "true";
const OVERWRITE_TENANT = args.get("overwrite-tenant") === "true";
const SKIP_SNAPSHOT = args.get("skip-snapshot-check") === "true";
/** Plan from staging alone (no tunnel): skips the prod-side preflight checks. Never applies. */
const STAGING_ONLY = args.get("staging-only") === "true";
const LICENSE_IDS = args.get("licenses")?.split(",").map((s) => s.trim()).filter(Boolean) ?? DEFAULT_LICENSE_IDS;
const OUT = args.get("out") ?? path.resolve(__dirname, "../planning-docs/migration-dry-run.json");

const LOG_FILE = path.resolve(__dirname, "../logs/migrate-staging-to-prod.log");
fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
function log(msg: string) {
  const line = `${new Date().toISOString()} ${msg}`;
  console.log(msg);
  fs.appendFileSync(LOG_FILE, line + "\n");
}

function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); resolve(a.trim()); }));
}

async function getProdConnectionString(): Promise<string> {
  if (process.env.PROD_DATABASE_URL) return process.env.PROD_DATABASE_URL;
  process.env.AWS_PROFILE = process.env.AWS_PROFILE || "aac";
  const sm = new SecretsManagerClient({ region: "il-central-1" });
  for (const name of ["aivota-prod-database-credentials", "aivota-prod/database", "aivota-prod-db"]) {
    try {
      const resp = await sm.send(new GetSecretValueCommand({ SecretId: name }));
      const json = resp.SecretString ? JSON.parse(resp.SecretString) : null;
      if (json?.DATABASE_URL) {
        const url = new URL(json.DATABASE_URL);
        url.hostname = "localhost"; // through the SSM tunnel
        url.searchParams.delete("sslmode");
        return url.toString();
      }
    } catch { /* try next */ }
  }
  throw new Error("Could not discover prod credentials; set PROD_DATABASE_URL (via npm run db-tunnel).");
}

async function requireRecentSnapshot() {
  if (SKIP_SNAPSHOT) { log("Snapshot check skipped by flag."); return; }
  const profile = process.env.AWS_PROFILE || "aac";
  const out = execFileSync("aws", [
    "rds", "describe-db-snapshots", "--profile", profile, "--region", "il-central-1",
    "--db-instance-identifier", "aivota-prod-postgres", "--output", "json",
  ], { encoding: "utf8", shell: process.platform === "win32" });
  const snaps: { DBSnapshotIdentifier: string; Status: string; SnapshotCreateTime?: string }[] = JSON.parse(out).DBSnapshots ?? [];
  const recent = snaps
    .filter((s) => s.Status === "available" && s.SnapshotCreateTime && Date.now() - Date.parse(s.SnapshotCreateTime) < 2 * 3600_000)
    .sort((a, b) => Date.parse(b.SnapshotCreateTime!) - Date.parse(a.SnapshotCreateTime!));
  if (!recent.length) {
    throw new Error(
      "No available prod snapshot from the last 2 hours. Take one first:\n" +
      "  aws rds create-db-snapshot --profile aac --region il-central-1 --db-instance-identifier aivota-prod-postgres --db-snapshot-identifier pre-staging-import-$(date +%Y%m%d%H%M)\n" +
      "or pass --skip-snapshot-check.",
    );
  }
  log(`Prod snapshot found: ${recent[0].DBSnapshotIdentifier} (${recent[0].SnapshotCreateTime})`);
}

// ---------------------------------------------------------------------------
// Catalog introspection
// ---------------------------------------------------------------------------

interface ColumnInfo { name: string; nullable: boolean; dataType: string; }
interface TableInfo { name: string; columns: ColumnInfo[]; pk: string[]; }

async function introspect(c: pg.Client): Promise<{ tables: Map<string, TableInfo>; fks: FkEdge[] }> {
  const tables = new Map<string, TableInfo>();
  const cols = await c.query(`
    SELECT table_name, column_name, is_nullable, data_type
    FROM information_schema.columns WHERE table_schema = 'public' ORDER BY table_name, ordinal_position`);
  for (const r of cols.rows) {
    const t = tables.get(r.table_name) ?? { name: r.table_name, columns: [], pk: [] };
    t.columns.push({ name: r.column_name, nullable: r.is_nullable === "YES", dataType: r.data_type });
    tables.set(r.table_name, t);
  }
  const pks = await c.query(`
    SELECT tc.table_name, kcu.column_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
    WHERE tc.table_schema = 'public' AND tc.constraint_type = 'PRIMARY KEY' ORDER BY kcu.ordinal_position`);
  for (const r of pks.rows) tables.get(r.table_name)?.pk.push(r.column_name);

  const fkRows = await c.query(`
    SELECT con.conname, src.relname AS src, dst.relname AS dst,
           (SELECT attname FROM pg_attribute WHERE attrelid = con.conrelid AND attnum = con.conkey[1]) AS src_col,
           (SELECT attname FROM pg_attribute WHERE attrelid = con.confrelid AND attnum = con.confkey[1]) AS dst_col,
           array_length(con.conkey, 1) AS ncols
    FROM pg_constraint con
    JOIN pg_class src ON src.oid = con.conrelid
    JOIN pg_class dst ON dst.oid = con.confrelid
    JOIN pg_namespace ns ON ns.oid = src.relnamespace
    WHERE con.contype = 'f' AND ns.nspname = 'public'`);
  const fks: FkEdge[] = [];
  for (const r of fkRows.rows) {
    if (r.ncols !== 1) throw new Error(`Composite FK ${r.conname} on ${r.src} is not supported by this script`);
    const col = tables.get(r.src)!.columns.find((x) => x.name === r.src_col)!;
    fks.push({ table: r.src, column: r.src_col, refTable: r.dst, refColumn: r.dst_col, nullable: col.nullable, soft: false });
  }
  // Soft FKs by naming convention, only where no real constraint exists on that column.
  for (const t of tables.values()) {
    for (const col of t.columns) {
      if (fks.some((f) => f.table === t.name && f.column === col.name)) continue;
      const ref = SOFT_FK_CONVENTION(col.name);
      if (!ref || !tables.has(ref) || ref === t.name) continue;
      fks.push({ table: t.name, column: col.name, refTable: ref, refColumn: "id", nullable: col.nullable, soft: true });
    }
  }
  return { tables, fks };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const stagingUrl = process.env.DATABASE_URL;
  if (!stagingUrl) throw new Error("DATABASE_URL (staging) not set");
  if (STAGING_ONLY && APPLY) throw new Error("--staging-only cannot be combined with --apply");
  const prodUrl = STAGING_ONLY ? null : await getProdConnectionString();
  if (prodUrl && new URL(stagingUrl).hostname === new URL(prodUrl).hostname && new URL(stagingUrl).port === new URL(prodUrl).port) {
    throw new Error("Staging and prod resolve to the same host — refusing.");
  }

  const staging = new Client({ connectionString: stagingUrl, ssl: { rejectUnauthorized: false } });
  const prod = prodUrl ? new Client({ connectionString: prodUrl, ssl: { rejectUnauthorized: false } }) : null;
  await staging.connect();
  await staging.query("SET default_transaction_read_only = on");
  await prod?.connect();
  log(`Mode: ${APPLY ? "APPLY" : STAGING_ONLY ? "DRY RUN (staging only)" : "DRY RUN"}  staging=${new URL(stagingUrl).hostname}  prod=${prodUrl ? new URL(prodUrl).hostname : "-"}`);

  try {
    // ---- Preflight -------------------------------------------------------
    const sMig = await staging.query(`SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY created_at DESC LIMIT 1`);
    if (prod) {
      const pMig = await prod.query(`SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY created_at DESC LIMIT 1`);
      if (sMig.rows[0]?.hash !== pMig.rows[0]?.hash) {
        throw new Error(`Migration heads differ: staging=${sMig.rows[0]?.hash} prod=${pMig.rows[0]?.hash}. Migrate first.`);
      }
      log(`Migration head matches (${String(sMig.rows[0]?.hash).slice(0, 12)}…)`);
    }

    const { tables, fks } = await introspect(staging);
    const classes = classifyTables([...tables.keys()], TABLE_CLASSES);
    if (prod) {
      const prodTables = (await introspect(prod)).tables;
      for (const [t, cls] of classes) {
        if (cls === "skip") continue;
        if (!prodTables.has(t)) {
          // Staging accumulates tables that migrations have since dropped. A tenant table
          // nobody classified is assumed to be one of those: skip it, loudly. A seed /
          // global / pull table missing on prod means a real schema gap → stop.
          if (cls === "tenant") {
            const n = (await staging.query(`SELECT count(*) FROM "${t}"`)).rows[0].count;
            log(`WARN  ${t} exists on staging but not on prod (${n} rows) — skipping as a dropped-table leftover`);
            classes.set(t, "skip");
            continue;
          }
          throw new Error(`Table ${t} (${cls}) missing on prod`);
        }
        const missingCols = tables.get(t)!.columns.map((c) => c.name).filter((c) => !prodTables.get(t)!.columns.some((p) => p.name === c));
        if (missingCols.length) throw new Error(`Table ${t}: columns missing on prod: ${missingCols.join(", ")}`);
      }
    }
    const softFks = fks.filter((f) => f.soft && classes.get(f.table) !== "skip");
    log(`Tables: ${tables.size}  real FKs: ${fks.filter((f) => !f.soft).length}  soft FKs (by convention): ${softFks.length}`);
    for (const f of softFks) log(`  soft  ${f.table}.${f.column} → ${f.refTable}${f.nullable ? "" : "  (NOT NULL)"}`);

    // ---- Load every non-skipped table from staging (all are small) -------
    const rows = new Map<string, Record<string, unknown>[]>();
    for (const [t, cls] of classes) {
      if (cls === "skip") continue;
      rows.set(t, (await staging.query(`SELECT * FROM "${t}"`)).rows);
    }

    // ---- Seeds -------------------------------------------------------------
    const licenses = rows.get("licenses")!.filter((l) => LICENSE_IDS.includes(String(l.id)));
    if (licenses.length !== LICENSE_IDS.length) {
      const found = new Set(licenses.map((l) => String(l.id)));
      throw new Error(`Licenses not found on staging: ${LICENSE_IDS.filter((id) => !found.has(id)).join(", ")}`);
    }
    const excludedUser = (u: Record<string, unknown>) =>
      u.is_admin === true || u.is_system_admin === true ||
      EXCLUDED_USER_EMAIL_PATTERNS.some((re) => re.test(String(u.email ?? "")));
    const excludedStudent = (s: Record<string, unknown>) => String(s.name ?? "").startsWith(SIM_NAME_PREFIX);

    const closure = computeClosure({
      tables: [...tables.values()].map((t) => ({ name: t.name, pk: t.pk, columns: t.columns })),
      classes,
      fks,
      rows,
      seedLicenseIds: new Set(LICENSE_IDS),
      excludeUser: excludedUser,
      excludeStudent: excludedStudent,
    });

    // ---- Report ------------------------------------------------------------
    const summary: Record<string, { rows: number; nulled: number; dropped: number; mode: string }> = {};
    const order = topoOrderTables([...closure.included.keys()], fks.filter((f) => !f.soft));
    for (const t of order) {
      const cls = classes.get(t)!;
      summary[t] = {
        rows: closure.included.get(t)!.length,
        nulled: closure.fixups.filter((f) => f.table === t && f.action === "null").length,
        dropped: closure.fixups.filter((f) => f.table === t && f.action === "drop").length,
        mode: cls === "global" ? "overwrite" : cls === "globalInsertOnly" ? "insert-only" : OVERWRITE_TENANT ? "overwrite" : "insert-only",
      };
    }
    log("\n=== Plan (insert order) ===");
    log(`${"table".padEnd(34)} ${"rows".padStart(6)} ${"nulled".padStart(7)} ${"dropped".padStart(8)}  mode`);
    for (const [t, s] of Object.entries(summary)) {
      if (s.rows === 0 && s.dropped === 0) continue;
      log(`${t.padEnd(34)} ${String(s.rows).padStart(6)} ${String(s.nulled).padStart(7)} ${String(s.dropped).padStart(8)}  ${s.mode}`);
    }
    const users = closure.included.get("users")!;
    const students = closure.included.get("students")!;
    const institutes = closure.included.get("institutes")!;
    log(`\nInstitutes: ${institutes.map((i) => i.name).join(" | ")}`);
    log(`Users (${users.length}): ${users.map((u) => u.email).join(", ")}`);
    log(`Students (${students.length}): ${students.map((s) => s.name).join(", ")}`);
    log(`\nFix-ups (${closure.fixups.length}):`);
    for (const f of closure.fixups) {
      log(`  ${f.action.toUpperCase().padEnd(5)} ${f.table}.${f.column} row=${f.rowId} → ${f.refTable}#${f.refId} (${f.reason})`);
    }

    // prod-side collision check: same email/different id would violate users_email_unique
    if (prod) {
      const prodUsers = (await prod.query(`SELECT id, email FROM users`)).rows;
      const collisions = users.filter((u) => prodUsers.some((p) => p.email?.toLowerCase() === String(u.email).toLowerCase() && p.id !== u.id));
      if (collisions.length) {
        throw new Error(`Prod already has these emails under a different id: ${collisions.map((u) => u.email).join(", ")}. Resolve manually.`);
      }
    }

    fs.writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), licenses: LICENSE_IDS, summary, fixups: closure.fixups, order }, null, 2));
    log(`\nReport written to ${OUT}`);

    if (!APPLY || !prod) { log("Dry run complete — nothing written. Re-run with --apply to execute."); return; }

    // ---- Apply -------------------------------------------------------------
    await requireRecentSnapshot();
    const confirm = await ask(`\nType 'migrate' to write ${Object.values(summary).reduce((a, s) => a + s.rows, 0)} rows to PRODUCTION: `);
    if (confirm !== "migrate") { log("Aborted."); return; }

    await prod.query("BEGIN");
    try {
      const written: Record<string, number> = {};
      for (const t of order) {
        const list = closure.included.get(t)!;
        if (!list.length) continue;
        const info = tables.get(t)!;
        const selfFk = fks.find((f) => f.table === t && f.refTable === t && !f.soft);
        const ordered = selfFk ? orderRowsBySelfFk(list, info.pk[0], selfFk.column) : list;
        const columns = info.columns.map((c) => c.name);
        const colList = columns.map((c) => `"${c}"`).join(", ");
        const cls = classes.get(t)!;
        const overwrite = cls === "global" || (OVERWRITE_TENANT && cls !== "globalInsertOnly");
        const conflict = overwrite && info.pk.length
          ? `ON CONFLICT (${info.pk.map((c) => `"${c}"`).join(", ")}) DO UPDATE SET ${columns.filter((c) => !info.pk.includes(c)).map((c) => `"${c}" = EXCLUDED."${c}"`).join(", ")}`
          : `ON CONFLICT DO NOTHING`;
        // json/jsonb come back from pg already PARSED (a JSON string is a bare JS string,
        // a JSON array is a JS array that pg would re-encode as a Postgres array literal).
        // Decide by declared column type, never by value shape.
        const isJson = new Set(info.columns.filter((c) => c.dataType === "json" || c.dataType === "jsonb").map((c) => c.name));
        const placeholders = columns.map((_, i) => `$${i + 1}`).join(", ");
        let n = 0;
        for (const row of ordered) {
          const values = columns.map((c) => {
            const v = row[c];
            return v !== null && v !== undefined && isJson.has(c) ? JSON.stringify(v) : v;
          });
          try {
            const r = await prod.query(`INSERT INTO "${t}" (${colList}) VALUES (${placeholders}) ${conflict}`, values);
            n += r.rowCount ?? 0;
          } catch (err: any) {
            throw new Error(`${t} row ${row[info.pk[0]]}: ${err.message}`);
          }
        }
        written[t] = n;
        log(`  ${t.padEnd(34)} ${String(n).padStart(6)} / ${list.length}`);
      }
      // serial sequences: bump past max(id) for integer PKs
      for (const t of order) {
        const info = tables.get(t)!;
        if (info.pk.length !== 1) continue;
        const seq = await prod.query(`SELECT pg_get_serial_sequence($1, $2) AS seq`, [`"${t}"`, info.pk[0]]);
        if (seq.rows[0]?.seq) {
          await prod.query(`SELECT setval($1, GREATEST((SELECT COALESCE(MAX("${info.pk[0]}"), 0) FROM "${t}"), 1))`, [seq.rows[0].seq]);
        }
      }
      await prod.query("COMMIT");
      log("\nCOMMITTED.");
      // verify
      log("\n=== Verify (prod counts) ===");
      for (const t of order) {
        if (!closure.included.get(t)!.length) continue;
        const { rows: r } = await prod.query(`SELECT count(*) FROM "${t}"`);
        log(`  ${t.padEnd(34)} prod total=${r[0].count}  written=${written[t]}`);
      }
    } catch (err) {
      await prod.query("ROLLBACK").catch(() => {});
      throw err;
    }
  } finally {
    await staging.end().catch(() => {});
    await prod?.end().catch(() => {});
  }
}

main().catch((err) => {
  log(`ERROR: ${err?.stack || err}`);
  process.exit(1);
});
