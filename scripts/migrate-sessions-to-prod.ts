/**
 * Staging → Production chat-session migration (targeted, by student).
 *
 * Why this exists separately from `migrate-staging-to-prod.ts`: that script
 * deliberately EXCLUDES session and log tables, so students were copied to
 * production while their conversation history stayed behind on staging (AWS
 * `aac-test`, us-east-2). That leaves real clinical transcripts in the United
 * States with no counterpart in the Israeli production database — the AKIM
 * information-security appendix §5 problem, and a live privacy exposure
 * independent of AKIM. See docs/AKIM_REMEDIATION_PLAN.md.
 *
 * Scope: `chat_sessions` for the named students, plus their
 * `session_cost_events` (the expenditure record). `session_debug_logs` are
 * NOT copied — they are debugging output, pruned periodically anyway.
 *
 * Prerequisites: the students, their users and their `user_students` links
 * must ALREADY exist in production (they do, via the main migration). The
 * script verifies this and refuses rather than inserting dangling rows.
 *
 * Rows are moved by `row_to_json` + `json_populate_record`, so every value is
 * coerced by Postgres itself from a single text parameter. This is deliberate:
 * passing jsonb through node-pg as a JS object mangles it on re-insert, which
 * is what went wrong during the Shahaf/Hadar session migration. Timestamps and
 * the `chat_session_status` enum ride along correctly for the same reason.
 *
 * `students.chat_credits_used` is an ACCUMULATOR and is deliberately NOT
 * touched: it already reflects historic spend on both sides, and adding the
 * copied sessions' credits would double-count.
 *
 * Usage
 *   npm run db-tunnel                                          # terminal 1
 *   npx tsx scripts/migrate-sessions-to-prod.ts --students="Noah Auerhahn,Ellie Auerhahn"
 *   npx tsx scripts/migrate-sessions-to-prod.ts --students="..." --apply
 *   npx tsx scripts/migrate-sessions-to-prod.ts --students="..." --delete-from-staging
 *
 * Flags
 *   --students=A,B            student NAMES on staging (required)
 *   --apply                   perform the copy (otherwise dry run)
 *   --delete-from-staging     after a verified copy, remove the rows from
 *                             staging. Refuses unless every row is confirmed
 *                             present in production first.
 *
 * Env: DATABASE_URL = staging (.env). Production via PROD_DATABASE_URL or
 * Secrets Manager through the SSM tunnel, same discovery as the sibling scripts.
 */

import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import pg from "pg";
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(ROOT, ".env") });

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const DELETE_STAGING = args.includes("--delete-from-staging");
const studentsArg = args.find((a) => a.startsWith("--students="));

if (!studentsArg) {
  console.error('Required: --students="Name One,Name Two"');
  process.exit(2);
}
const STUDENT_NAMES = studentsArg
  .slice("--students=".length)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const CA = fs.readFileSync(path.join(ROOT, "rds-ca-bundle.pem"), "utf8");

async function prodConnectionString(): Promise<string> {
  if (process.env.PROD_DATABASE_URL) return process.env.PROD_DATABASE_URL;
  process.env.AWS_PROFILE = process.env.AWS_PROFILE || "aac";
  const sm = new SecretsManagerClient({ region: "il-central-1" });
  for (const id of ["aivota-prod/database", "aivota-prod-database-credentials", "aivota-prod-db"]) {
    try {
      const r = await sm.send(new GetSecretValueCommand({ SecretId: id }));
      const j = JSON.parse(r.SecretString!);
      if (j.DATABASE_URL) {
        const u = new URL(j.DATABASE_URL);
        // Through the SSM tunnel the host is local; the cert is still the RDS one.
        u.hostname = "localhost";
        u.searchParams.delete("sslmode");
        return u.toString();
      }
    } catch {
      /* try next */
    }
  }
  throw new Error("Could not resolve production credentials — set PROD_DATABASE_URL.");
}

async function main() {
  const staging = new pg.Client({
    connectionString: process.env.DATABASE_URL!.replace(/[?&]sslmode=[^&]*/g, ""),
    ssl: { ca: CA },
  });
  const prod = new pg.Client({
    connectionString: await prodConnectionString(),
    // Chain verified against the AWS CA; hostname check relaxed because the
    // tunnel presents the RDS certificate on localhost.
    ssl: { ca: CA, checkServerIdentity: () => undefined },
  });
  await staging.connect();
  await prod.connect();

  try {
    const students = (
      await staging.query(`select id, name from students where name = any($1)`, [STUDENT_NAMES])
    ).rows;
    if (students.length !== STUDENT_NAMES.length) {
      const found = students.map((s) => s.name);
      throw new Error(
        `Expected ${STUDENT_NAMES.length} students, found ${students.length}: ` +
          `missing ${STUDENT_NAMES.filter((n) => !found.includes(n)).join(", ")}`,
      );
    }
    const studentIds = students.map((s) => s.id);
    console.log(`Students: ${students.map((s) => `${s.name} (${s.id.slice(0, 8)})`).join(", ")}`);

    // --- gather -----------------------------------------------------------
    const sessions = (
      await staging.query(
        `select row_to_json(cs)::text as j, cs.id
         from chat_sessions cs where cs.student_id = any($1) order by cs.created_at`,
        [studentIds],
      )
    ).rows;
    const sessionIds = sessions.map((r) => r.id);
    const costs = sessionIds.length
      ? (
          await staging.query(
            `select row_to_json(e)::text as j, e.id
             from session_cost_events e where e.session_id = any($1)`,
            [sessionIds],
          )
        ).rows
      : [];

    console.log(`chat_sessions:       ${sessions.length}`);
    console.log(`session_cost_events: ${costs.length}`);
    if (sessions.length === 0) {
      console.log("Nothing to move.");
      return;
    }

    // --- verify prerequisites in prod -------------------------------------
    const parentCheck = async (table: string, ids: string[]) => {
      const unique = [...new Set(ids.filter(Boolean))];
      if (!unique.length) return true;
      const n = (
        await prod.query(`select count(*)::int n from ${table} where id = any($1)`, [unique])
      ).rows[0].n;
      const ok = n === unique.length;
      console.log(`  ${table.padEnd(16)} ${n}/${unique.length} in prod ${ok ? "OK" : "MISSING"}`);
      return ok;
    };
    const parsed = sessions.map((r) => JSON.parse(r.j));
    console.log("Prerequisites in production:");
    const ok = (
      await Promise.all([
        parentCheck("users", parsed.map((s) => s.user_id)),
        parentCheck("students", parsed.map((s) => s.student_id)),
        parentCheck("user_students", parsed.map((s) => s.user_student_id)),
        parentCheck("institutes", parsed.map((s) => s.institute_id)),
        parentCheck("institute_users", parsed.map((s) => s.institute_user_id)),
        parentCheck("classrooms", parsed.map((s) => s.classroom_id)),
      ])
    ).every(Boolean);
    if (!ok) throw new Error("Missing parent rows in production — refusing to insert dangling rows.");

    const collisions = (
      await prod.query(`select count(*)::int n from chat_sessions where id = any($1)`, [sessionIds])
    ).rows[0].n;
    console.log(`Existing ids already in prod: ${collisions}`);

    if (!APPLY && !DELETE_STAGING) {
      console.log("\n[dry run] Nothing written. Re-run with --apply to copy.");
      return;
    }

    // --- copy -------------------------------------------------------------
    if (APPLY) {
      await prod.query("BEGIN");
      try {
        for (const row of sessions) {
          await prod.query(
            `insert into chat_sessions
             select * from json_populate_record(null::chat_sessions, $1::json)
             on conflict (id) do nothing`,
            [row.j],
          );
        }
        for (const row of costs) {
          await prod.query(
            `insert into session_cost_events
             select * from json_populate_record(null::session_cost_events, $1::json)
             on conflict (id) do nothing`,
            [row.j],
          );
        }
        await prod.query("COMMIT");
        console.log("Copy committed.");
      } catch (err) {
        await prod.query("ROLLBACK");
        throw err;
      }
    }

    // --- verify -----------------------------------------------------------
    const nowInProd = (
      await prod.query(`select count(*)::int n from chat_sessions where id = any($1)`, [sessionIds])
    ).rows[0].n;
    const costsInProd = costs.length
      ? (
          await prod.query(`select count(*)::int n from session_cost_events where id = any($1)`, [
            costs.map((c) => c.id),
          ])
        ).rows[0].n
      : 0;
    console.log(`Verified in prod: ${nowInProd}/${sessions.length} sessions, ${costsInProd}/${costs.length} cost events`);

    // --- delete from staging (only on a fully verified copy) --------------
    if (DELETE_STAGING) {
      if (nowInProd !== sessions.length || costsInProd !== costs.length) {
        throw new Error(
          "Refusing to delete from staging: production does not hold every row yet.",
        );
      }
      await staging.query("BEGIN");
      try {
        // session_cost_events / session_debug_logs cascade from chat_sessions.
        const del = await staging.query(`delete from chat_sessions where id = any($1)`, [sessionIds]);
        await staging.query("COMMIT");
        console.log(`Deleted ${del.rowCount} sessions from staging (cost events and debug logs cascaded).`);
      } catch (err) {
        await staging.query("ROLLBACK");
        throw err;
      }
    }
  } finally {
    await staging.end();
    await prod.end();
  }
}

main().catch((err) => {
  // Print the whole error, not just `.message`: a pg error carries its detail
  // in `detail`/`code` and can have an empty message, which reads as a silent
  // failure at exactly the moment you need to know what went wrong.
  console.error("\nFAILED:", err?.message || "(no message)");
  if (err?.code) console.error("  code:", err.code, err.detail ?? "");
  if (err?.stack) console.error(err.stack);
  process.exit(1);
});
