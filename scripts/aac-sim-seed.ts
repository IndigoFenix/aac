// Create (or re-align) the AAC harness's simulated students.
//
//   npx tsx scripts/aac-sim-seed.ts --owner daniel@aivota.ai
//   npx tsx scripts/aac-sim-seed.ts --check          (report only, writes nothing)
//
// IDEMPOTENT. Re-running creates nothing that exists and re-applies every
// profile's settings, so it is also how a profile edit reaches the rows.
//
// These are ORDINARY students (harness design §9) — they appear in the clinician
// client, consume budget meters and accumulate whatever the Monitor learns.
// That is deliberate: the suite exercises the real machinery rather than
// tiptoeing around it, and the records are safe because they are FABRICATED.
// NOTE: an ADMIN account is not a valid owner — admin users are not designed to
// hold students. Pass a normal clinician/caretaker account.
//
// The script prints the database it is about to touch, and refuses to guess an
// owner, because both are things a person should see before rows appear.

import "dotenv/config";
import { eq } from "drizzle-orm";

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}
const checkOnly = process.argv.includes("--check");
const ownerEmail = arg("owner");

function describeDb(): string {
  try {
    const u = new URL(process.env.DATABASE_URL ?? "");
    return `${u.hostname}/${u.pathname.slice(1)}`;
  } catch {
    return "(DATABASE_URL unset or unparseable)";
  }
}

async function main() {
  console.log(`database  : ${describeDb()}`);
  console.log(`gate      : CONSENT_GATE_ENABLED=${process.env.CONSENT_GATE_ENABLED ?? "(unset → off)"}`);

  const { db } = await import("../server/db.js");
  const { users } = await import("../shared/schema-private.js");
  const { ensureSimStudents, inspectSimStudents } = await import(
    "../server/services/aac-sim/students.js"
  );

  if (checkOnly) {
    const found = await inspectSimStudents();
    report(found);
    return;
  }

  if (!ownerEmail) {
    console.error(
      "\nRefusing to guess an owner. Pass --owner <email>; the students are linked to that\n" +
        "account and will show up in its clinician client. Use --check to report only.",
    );
    process.exitCode = 2;
    return;
  }

  const [owner] = await db.select({ id: users.id, email: users.email }).from(users).where(eq(users.email, ownerEmail));
  if (!owner) {
    console.error(`\nNo user with email ${ownerEmail} in this database.`);
    process.exitCode = 2;
    return;
  }
  console.log(`owner     : ${owner.email}\n`);

  const found = await ensureSimStudents(owner.id);
  report(found);
}

function report(found: Awaited<ReturnType<typeof import("../server/services/aac-sim/students.js").inspectSimStudents>>) {
  if (found.length === 0) {
    console.log("\nNo sim students exist yet. Run without --check to create them.");
    return;
  }
  console.log(`\n${found.length} sim student(s):\n`);
  for (const r of found) {
    const s = r.profile.aacSettings;
    console.log(`  ${r.profile.id}`);
    console.log(`    id        ${r.studentId}`);
    console.log(`    reads     ${r.profile.perception.reading} · access ${r.profile.access} · verbal ${r.profile.verbalAbility}`);
    console.log(`    settings  lang ${s.languageLevel} · icon/text ${s.iconTextRatio} · rest ${s.restSpace} · gaze ${s.eyegazeEnabled}`);
    console.log(`    session   ${r.sessionAllowed ? "OK" : "BLOCKED"} — ${r.consentNote}`);
    console.log("");
  }
  const blocked = found.filter((r) => !r.sessionAllowed);
  if (blocked.length) {
    console.log(
      `⚠️  ${blocked.length} student(s) cannot open a session: the consent gate is on and no\n` +
        "    consent is on file. Collect it the normal way — this script will not mint one.",
    );
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
