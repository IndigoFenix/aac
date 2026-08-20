// Play ONE scenario with an AI child, then have a judge score it.
//
//   npx tsx scripts/aac-sim-play.ts --scenario ask-for-a-drink --profile prereader-eyegaze
//   npx tsx scripts/aac-sim-play.ts --scenario tell-about-the-dog --profile fluent-reader --no-judge
//
// ⚠️ REAL, BILLED, AND THREE-SIDED: the AAC's own agents, the child model
// (gemini-2.5-flash) and the judge (claude-haiku) are all live. The transcript
// lands in transcripts/aac-sim/.

import "dotenv/config";
import { eq } from "drizzle-orm";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configureSimTeardown } from "../server/services/aac-sim/teardown.js";

// BEFORE ANY DYNAMIC IMPORT. The coordinator reads both switches once into
// `static readonly` fields at class-definition time, so setting them after it
// has been imported does nothing — silently. A sim never reconnects, so it
// wants teardown-on-drop and immediate finalization rather than the warm
// window the real client needs.
configureSimTeardown();

function arg(name: string, fallback: string | null = null): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}
const noJudge = process.argv.includes("--no-judge");

async function main() {
  const { profileById } = await import("../shared/aac/sim-profiles.js");
  const { scenarioById, ALL_SCENARIOS } = await import("../server/services/aac-sim/scenarios.js");

  const profile = profileById(arg("profile", "prereader-eyegaze")!);
  const scenario = scenarioById(arg("scenario", "ask-for-a-drink")!);
  if (!profile) return fail(`No such profile.`);
  if (!scenario) {
    return fail(["No such scenario. Try:", ...ALL_SCENARIOS.map((x) => `  ${x.id}`)].join("\n"));
  }

  const { db } = await import("../server/db.js");
  const { users, userStudents } = await import("../shared/schema-private.js");
  const { findSimStudent } = await import("../server/services/aac-sim/students.js");
  const { runScenario } = await import("../server/services/aac-sim/runner.js");
  const { SimTrace } = await import("../server/services/aac-sim/trace.js");
  const { en } = await import("../client-aac/src/i18n/en.js");

  const t = (key: string): string => {
    const hit = key.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], en);
    return typeof hit === "string" ? hit : key;
  };

  const studentId = await findSimStudent(profile);
  if (!studentId) return fail(`No sim student for ${profile.id} — run scripts/aac-sim-seed.ts.`);

  const [link] = await db
    .select({ userId: userStudents.userId })
    .from(userStudents)
    .where(eq(userStudents.studentId, studentId));
  const [user] = await db.select().from(users).where(eq(users.id, link!.userId));

  console.log(`scenario : ${scenario.id} — ${scenario.intent}`);
  console.log(`child    : ${profile.id} (${profile.perception.reading} reader, ${profile.access})`);

  // The trace is opened BEFORE the run and streamed line by line, so a crash
  // mid-session still leaves the trail that explains it — which is the one time
  // anybody actually wants it.
  const dir = join(process.cwd(), "transcripts", "aac-sim");
  mkdirSync(dir, { recursive: true });
  const stamp = `${scenario.id}-${profile.id}-${Date.now().toString(36)}`;
  const tracePath = join(dir, `${stamp}.trace.jsonl`);
  const trace = new SimTrace();
  trace.openFile(tracePath);
  console.log(`trace    : ${tracePath}\n`);

  const transcript = await runScenario({
    scenario,
    profile,
    studentId,
    user: user as never,
    t,
    seed: Number(arg("seed", "1")),
    settleMs: Number(arg("settle", "9000")),
    onLine: (l) => console.log(l),
    trace,
  });

  // A VOID RUN IS NOT JUDGED. Scoring a run the harness broke produces a
  // confident report about a product failure that never happened.
  if (transcript.outcome === "aborted") {
    console.log(`
${"═".repeat(66)}`);
    console.log(`RUN VOID — ${transcript.abortReason ?? "aborted"}`);
    console.log("Not judged: a harness failure is not a finding.");
    console.log(`
last events (full trace at ${tracePath}):`);
    for (const l of trace.tail(15)) console.log("  " + l);
    process.exitCode = 3;
    return;
  }

  const passed = scenario.succeeded(transcript);
  console.log(`\n${"═".repeat(66)}`);
  console.log(`outcome  : ${transcript.outcome}  ·  predicate: ${passed ? "MET" : "NOT MET"}`);
  console.log(
    `presses  : ${transcript.counters.presses} (${transcript.counters.localPresses} local) · ` +
      `mis-selects ${transcript.counters.misselects} · dead ends ${transcript.counters.deadEnds}`,
  );
  console.log(`wall     : ${(transcript.wallMs / 1000).toFixed(1)}s`);
  console.log(
    `child LLM: ${transcript.childUsage.promptTokens} in / ${transcript.childUsage.completionTokens} out`,
  );

  let report = null;
  if (!noJudge) {
    const { judgeRun } = await import("../server/services/aac-sim/judge.js");
    console.log("\njudging…");
    const j = await judgeRun(transcript);
    report = j.report;
    trace.record("judge-raw", { raw: j.raw, usage: j.usage });
    if (report) trace.record("judge", { report });
    if (!report) {
      console.log(`the judge returned nothing usable — raw payload is in ${tracePath}`);
    } else {
      console.log("");
      for (const k of ["reachability", "boardRelevance", "comprehensibility", "fidelity", "responsiveness", "repair"] as const) {
        const s = report[k];
        // A judge that skipped a criterion is reported as skipped, not crashed
        // over and not scored as zero — a missing score is not a bad score.
        if (!s || typeof s.score !== "number") {
          console.log(`  ${k.padEnd(18)} (not returned by the judge)`);
          continue;
        }
        console.log(`  ${k.padEnd(18)} ${s.score}/3  (turn ${s.turn})  ${s.why}`);
      }
      if (report.findings?.length) {
        console.log("\n  findings:");
        for (const f of report.findings) console.log(`   - ${f}`);
      }
      console.log(`\n  ${report.summary}`);
    }
  }

  const file = join(dir, `${stamp}.json`);
  writeFileSync(file, JSON.stringify({ transcript, predicateMet: passed, report }, null, 2), "utf-8");
  console.log(`\ntranscript → ${file}`);
}

function fail(msg: string) {
  console.error(msg);
  process.exitCode = 2;
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\nPLAY FAILED:", err?.message ?? err);
    if (err?.stack) console.error(err.stack.split("\n").slice(1, 6).join("\n"));
    process.exit(1);
  });
