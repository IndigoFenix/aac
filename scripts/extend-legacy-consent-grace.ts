/**
 * extend-legacy-consent-grace.ts
 *
 * One-time runway before flipping CONSENT_GATE_ENABLED=true.
 *
 * The consent gate (server/services/consent/consentGate.ts) blocks PHI ops —
 * AAC session start, program activate, report/incident finalize, cross-institute
 * share — for any student with no active student_consent_records row and no live
 * `students.legacy_consent_deadline`. Migration 0086 gave pre-existing students
 * now()+90d; that window has since expired everywhere, so flipping the flag today
 * is a hard cutover rather than a soft one.
 *
 * This script pushes `legacy_consent_deadline` out by an explicit number of days
 * for students that would otherwise be blocked, so the gate can go live and
 * enforce fully for every NEWLY created student (which is the point — everything
 * the bulk-intake pipeline creates gets `null` and is gated from birth) while
 * current users keep working during a consent-collection campaign.
 *
 * Two buckets, because they are ethically different:
 *   pre-feature  — legacy_consent_deadline IS NOT NULL (0086 backfilled them).
 *   post-feature — legacy_consent_deadline IS NULL: created after the consent
 *                  feature shipped and should have had consent collected. On
 *                  production this is the bucket with the ACTIVE AAC users, so
 *                  it is included by default; `--bucket pre-feature` excludes it.
 *
 * Students that already hold an active consent record are never touched.
 *
 * Usage:
 *   npx tsx scripts/extend-legacy-consent-grace.ts --target staging --days 90
 *   npx tsx scripts/extend-legacy-consent-grace.ts --target staging --days 90 --apply
 *   npx tsx scripts/extend-legacy-consent-grace.ts --target prod --days 90 --apply
 *
 * Flags:
 *   --target staging|prod|both   which database (default staging)
 *   --days N                     REQUIRED. Days from now for the new deadline.
 *   --bucket all|pre-feature     which blocked students to extend (default all)
 *   --apply                      perform the update (otherwise dry run)
 *
 * Production requires the SSM tunnel (`npm run db-tunnel`) and the `aac` AWS
 * profile — see ai-docs/db-access.md.
 *
 * Every run, dry or applied, appends a full record (ids, names, before/after
 * deadlines) to logs/consent-grace-extension-<timestamp>.json.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import pg from "pg";
import dotenv from "dotenv";
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(ROOT, ".env") });

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");

function argValue(name: string): string | undefined {
  const inline = args.find((a) => a.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 ? args[idx + 1] : undefined;
}

const TARGET = (argValue("target") ?? "staging").toLowerCase();
if (!["staging", "prod", "both"].includes(TARGET)) {
  console.error(`--target must be staging | prod | both (got "${TARGET}")`);
  process.exit(2);
}

const daysRaw = argValue("days");
const DAYS = Number(daysRaw);
if (!daysRaw || !Number.isInteger(DAYS) || DAYS <= 0 || DAYS > 730) {
  console.error("--days is required and must be a positive integer <= 730.");
  console.error("  Deliberately has no default: the runway length is a compliance decision.");
  process.exit(2);
}

const BUCKET = (argValue("bucket") ?? "all").toLowerCase();
if (!["all", "pre-feature"].includes(BUCKET)) {
  console.error(`--bucket must be all | pre-feature (got "${BUCKET}")`);
  process.exit(2);
}

const CA = fs.readFileSync(path.join(ROOT, "rds-ca-bundle.pem"), "utf8");

/** Students with no active (non-revoked) consent record. */
const NO_ACTIVE_CONSENT = `
  not exists (
    select 1 from student_consent_records r
     where r.student_id = s.id and r.revoked_at is null
  )`;

/** Blocked today: no active consent AND no live grace window. */
const BLOCKED = `${NO_ACTIVE_CONSENT}
  and (s.legacy_consent_deadline is null or s.legacy_consent_deadline <= now())`;

const BUCKET_FILTER =
  BUCKET === "pre-feature" ? "and s.legacy_consent_deadline is not null" : "";

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
      /* try next id */
    }
  }
  throw new Error("Could not resolve production credentials — set PROD_DATABASE_URL.");
}

async function clientFor(target: "staging" | "prod"): Promise<pg.Client> {
  if (target === "staging") {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL not set (.env is staging).");
    return new pg.Client({
      connectionString: process.env.DATABASE_URL.replace(/[?&]sslmode=[^&]*/g, ""),
      ssl: { ca: CA },
    });
  }
  return new pg.Client({
    connectionString: await prodConnectionString(),
    // Chain verified against the AWS CA; hostname check relaxed because the
    // tunnel presents the RDS certificate on localhost.
    ssl: { ca: CA, checkServerIdentity: () => undefined },
  });
}

interface Candidate {
  id: string;
  name: string;
  bucket: string;
  legacy_consent_deadline: string | null;
  last_session: string | null;
}

async function run(target: "staging" | "prod") {
  console.log(`\n${"#".repeat(64)}`);
  console.log(`# ${target.toUpperCase()}  —  ${APPLY ? "APPLY" : "DRY RUN"}`);
  console.log(`${"#".repeat(64)}`);

  const client = await clientFor(target);
  await client.connect();

  try {
    const candidates: Candidate[] = (
      await client.query(`
        select s.id,
               s.name,
               case when s.legacy_consent_deadline is not null
                    then 'pre-feature' else 'post-feature' end as bucket,
               s.legacy_consent_deadline,
               cs.last_session
          from students s
          left join (
            select student_id, max(created_at) as last_session
              from chat_sessions group by student_id
          ) cs on cs.student_id = s.id
         where ${BLOCKED} ${BUCKET_FILTER}
         order by cs.last_session desc nulls last, s.name
      `)
    ).rows;

    if (candidates.length === 0) {
      console.log("\nNo blocked students match. Nothing to do.");
      return { target, candidates: [], applied: false };
    }

    const pre = candidates.filter((c) => c.bucket === "pre-feature").length;
    const post = candidates.filter((c) => c.bucket === "post-feature").length;
    const recent = candidates.filter(
      (c) => c.last_session && Date.now() - new Date(c.last_session).getTime() < 30 * 864e5,
    );

    console.log(`\nBlocked students matching --bucket ${BUCKET}: ${candidates.length}`);
    console.log(`  pre-feature (expired deadline): ${pre}`);
    console.log(`  post-feature (deadline NULL):   ${post}`);
    console.log(`  used AAC in the last 30 days:   ${recent.length}`);

    if (recent.length) {
      console.log(`\nRecently active — these lose AAC access the moment the flag flips:`);
      for (const c of recent) {
        console.log(
          `  ${c.name.padEnd(28)} bucket=${c.bucket.padEnd(13)} last session ${new Date(c.last_session!).toISOString().slice(0, 10)}`,
        );
      }
    }

    const newDeadline = new Date(Date.now() + DAYS * 864e5);
    console.log(`\nNew legacy_consent_deadline would be: ${newDeadline.toISOString()} (now + ${DAYS}d)`);

    let applied = false;
    if (APPLY) {
      const ids = candidates.map((c) => c.id);
      const res = await client.query(
        `update students
            set legacy_consent_deadline = now() + ($1 || ' days')::interval
          where id = any($2::varchar[])
          returning id, legacy_consent_deadline`,
        [String(DAYS), ids],
      );
      applied = true;
      console.log(`\nUPDATED ${res.rowCount} rows.`);

      const stillBlocked = (
        await client.query(`select count(*)::int as n from students s where ${BLOCKED}`)
      ).rows[0].n;
      console.log(`Students still blocked after this run: ${stillBlocked}`);
      if (stillBlocked > 0) {
        console.log(`  (expected when --bucket pre-feature excluded the NULL-deadline students)`);
      }
    } else {
      console.log(`\n[dry run] Nothing written. Re-run with --apply to extend.`);
    }

    return { target, candidates, applied };
  } finally {
    await client.end().catch(() => {});
  }
}

async function main() {
  const targets: ("staging" | "prod")[] =
    TARGET === "both" ? ["staging", "prod"] : [TARGET as "staging" | "prod"];

  const results = [];
  for (const t of targets) results.push(await run(t));

  const logDir = path.join(ROOT, "logs");
  fs.mkdirSync(logDir, { recursive: true });
  const logFile = path.join(
    logDir,
    `consent-grace-extension-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
  );
  fs.writeFileSync(
    logFile,
    JSON.stringify(
      { ranAt: new Date().toISOString(), apply: APPLY, days: DAYS, bucket: BUCKET, results },
      null,
      2,
    ),
  );
  console.log(`\nRecord written to ${path.relative(ROOT, logFile)}`);
}

main().catch((e) => {
  // A pg error can have an empty .message — the substance is in .code / .detail.
  console.error(`FAILED code=${e?.code} detail=${e?.detail} msg=${e?.message}`);
  process.exit(1);
});
