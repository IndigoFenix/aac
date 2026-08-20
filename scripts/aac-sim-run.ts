// Drive ONE real AAC session headlessly and print what the child would see.
//
//   npx tsx scripts/aac-sim-run.ts --profile fluent-reader
//   npx tsx scripts/aac-sim-run.ts --profile prereader-eyegaze --press 3
//
// ⚠️ THIS OPENS A REAL, BILLED SESSION. It boots the four agents against a real
// student row, writes session rows and drains that student's budget meters. It
// is the harness's smoke test, not a jest fixture.
//
// No child model yet — this is the hand-driven step: boot, project, look. The
// point is to find out whether the projection READS sensibly before wiring an
// AI to it, because a projection that reads badly would make every later finding
// suspect.

import "dotenv/config";
import { eq } from "drizzle-orm";
import { configureSimTeardown } from "../server/services/aac-sim/teardown.js";

// Before any dynamic import — see the note in aac-sim-play.ts.
configureSimTeardown();

function arg(name: string, fallback: string | null = null): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}

const profileId = arg("profile", "fluent-reader")!;
const pressN = arg("press");
/** Hard ceiling so a stuck agent cannot hold the process (or the bill) open. */
const BUDGET_MS = Number(arg("budget", "180000"));

async function main() {
  const { profileById } = await import("../shared/aac/sim-profiles.js");
  const profile = profileById(profileId);
  if (!profile) {
    console.error(`No profile "${profileId}".`);
    process.exitCode = 2;
    return;
  }

  const { db } = await import("../server/db.js");
  const { users, students, userStudents } = await import("../shared/schema-private.js");
  const { findSimStudent } = await import("../server/services/aac-sim/students.js");
  const { bootSimSession } = await import("../server/services/aac-sim/boot.js");
  const { SimClientModel } = await import("../server/services/aac-sim/client-model.js");
  const { projectView, renderView } = await import("../server/services/aac-sim/project.js");

  // The AAC's own translation table, so the quick row reads as the child sees
  // it. Imported RELATIVELY: `client-aac/src/i18n` is outside the server's
  // `@shared/*` path map, which is why the projection takes `t` rather than
  // reaching for it itself.
  const { en } = await import("../client-aac/src/i18n/en.js");
  const t = (key: string): string => {
    const hit = key.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], en);
    return typeof hit === "string" ? hit : key;
  };

  const studentId = await findSimStudent(profile);
  if (!studentId) {
    console.error(`No sim student for "${profileId}" — run scripts/aac-sim-seed.ts first.`);
    process.exitCode = 2;
    return;
  }

  // The session runs as the student's OWNER, exactly as a real connection does.
  const [link] = await db
    .select({ userId: userStudents.userId })
    .from(userStudents)
    .where(eq(userStudents.studentId, studentId));
  const [user] = await db.select().from(users).where(eq(users.id, link!.userId));
  const [student] = await db.select({ name: students.name }).from(students).where(eq(students.id, studentId));

  console.log(`profile   : ${profile.id} — ${profile.description}`);
  console.log(`student   : ${student?.name} (${studentId})`);
  console.log(`as user   : ${user?.email}`);
  console.log(`reading   : ${profile.perception.reading}\n`);

  const killer = setTimeout(() => {
    console.error(`\n⏱  budget of ${BUDGET_MS}ms exhausted — killing the run.`);
    process.exit(3);
  }, BUDGET_MS);
  killer.unref?.();

  const t0 = Date.now();
  console.log("booting…");
  const session = await bootSimSession({ studentId, user: user as never, timezone: "Asia/Jerusalem" });
  console.log(`initialized in ${Date.now() - t0}ms · session ${session.sessionId}\n`);

  const model = new SimClientModel();

  // Let the startup traffic land: the first board arrives after the session
  // plan runs, which is model work, not instant.
  try {
    await session.socket.waitFor((m) => m.type === "board" || m.type === "set_board", { timeoutMs: 90_000 });
  } catch {
    console.log("(no board arrived within 90s — showing whatever did)\n");
  }
  model.applyAll(session.socket.outbox);

  console.log("── what the child sees ".padEnd(70, "─"));
  for (const line of renderView(projectView(model, { profile: profile.perception, t }))) console.log(line);

  if (pressN) {
    const view = projectView(model, { profile: profile.perception, t });
    const cell = view.cells.find((c) => c.n === Number(pressN));
    if (!cell) {
      console.log(`\nNo cell ${pressN} on this screen.`);
    } else {
      const { pressBoardButton } = await import("../server/services/aac-sim/act.js");
      // Resolve the cell back to its button by position within the board surface.
      const boardCells = view.cells.filter((c) => c.where === "board");
      const idx = boardCells.indexOf(cell);
      const slot = model.cells()[idx];
      if (!slot || slot.type === "blank") {
        console.log(`\nCell ${pressN} is empty — pressing it would do nothing.`);
      } else {
        console.log(`\n── pressing ${pressN} `.padEnd(70, "─"));
        const before = session.socket.outbox.length;
        const r = pressBoardButton(model, slot.button);
        console.log(`the child ${r.note}`);
        if (r.message) {
          session.socket.deliver(r.message);
          try {
            await session.socket.waitFor(
              (m) => ["speak", "board", "board_patch", "utterance"].includes(m.type),
              { timeoutMs: 60_000, includeExisting: false },
            );
          } catch {
            console.log("(nothing came back within 60s)");
          }
          // SETTLE. The first reply is not the last: the Board Manager may still
          // be rebuilding when the Speaker has already spoken. Reading the
          // surface at the first message would report a half-built board as the
          // finished one — a harness artifact that looks exactly like a product
          // bug, so wait for the traffic to go quiet before looking.
          const settleMs = Number(arg("settle", "12000"));
          let lastCount = -1;
          const until = Date.now() + settleMs;
          while (Date.now() < until && lastCount !== session.socket.outbox.length) {
            lastCount = session.socket.outbox.length;
            await new Promise((r) => setTimeout(r, 3000));
          }
          console.log(`(settled after ${session.socket.outbox.length - before} messages)`);
          model.applyAll(session.socket.outbox.slice(before));
          console.log("");
          for (const line of renderView(projectView(model, { profile: profile.perception, t }))) console.log(line);
        }
      }
    }
  }

  console.log("\n── server traffic ".padEnd(70, "─"));
  const counts = new Map<string, number>();
  for (const m of session.socket.outbox) counts.set(m.type, (counts.get(m.type) ?? 0) + 1);
  console.log([...counts.entries()].map(([type, n]) => `${type}×${n}`).join("  "));

  // Close and WAIT for finalization, or the session is left abandoned for the
  // sweeper to reap 35 minutes later.
  const { endSimSession } = await import("../server/services/aac-sim/teardown.js");
  const ended = await endSimSession(session, { onLine: (l) => console.log(l) });
  clearTimeout(killer);
  console.log(`\nclosed=${ended.closed} after ${(ended.waitedMs / 1000).toFixed(1)}s`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\nRUN FAILED:", err?.message ?? err);
    if (err?.stack) console.error(err.stack.split("\n").slice(1, 6).join("\n"));
    process.exit(1);
  });
