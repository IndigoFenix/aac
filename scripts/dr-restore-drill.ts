/**
 * =============================================================================
 * DR restore drill — restore the latest prod snapshot IN REGION, prove it, bin it.
 * =============================================================================
 *
 * Why in-region only: `il-central-1` is the ONLY AWS region in Israel. Copying a
 * snapshot of `aivota-prod-postgres` to any other region is itself a transfer of
 * PHI out of Israel (AKIM §14), so cross-region snapshot copies are ruled OUT as
 * a DR mechanism, not merely unimplemented. Everything here stays in
 * `il-central-1`. See docs/DISASTER_RECOVERY.md.
 *
 * What it does under --execute:
 *   1. Reads `aivota-prod-postgres` to discover subnet group, security groups,
 *      parameter group and engine (the restore must land in the same network).
 *   2. Picks the newest AVAILABLE automated snapshot (or --snapshot <id>).
 *   3. Restores it into `aivota-dr-drill-<yyyymmddhhmm>` — db.t3.micro, private,
 *      single-AZ, deletion protection OFF, tagged Purpose=dr-drill.
 *   4. Polls until `available`, logging elapsed time. That elapsed time is the
 *      empirical restore component of RTO.
 *   5. Port-forwards to the drill endpoint through the prod bastion via SSM (on a
 *      local port that is NOT 5432, so it cannot collide with `npm run db-tunnel`),
 *      connects with the prod master credentials from Secrets Manager (a restored
 *      snapshot carries the same master password) and runs smoke checks:
 *        - drizzle migration head == origin/main's newest drizzle/*.sql (what
 *          production deploys — NOT the working tree, which on `staging` is
 *          routinely ahead; see scripts/dr-drill-migration-head.ts)
 *        - students / users / chat_sessions / activity_logs / medical_records > 0
 *        - newest activity_logs.created_at sits inside the snapshot window
 *          (that gap is the OBSERVED RPO for the snapshot path)
 *   6. Deletes the drill instance (--skip-final-snapshot) unless --keep.
 *   7. Writes evidence to docs/dr/drills/<yyyy-mm-dd>-restore-drill.md and a
 *      verbose transcript to logs/dr-drill-<stamp>.log.
 *
 * Safety rails (both are hard refusals, not warnings):
 *   - it will only ever CREATE an identifier starting with `aivota-dr-drill-`;
 *   - it will only ever DELETE an instance whose tags contain Purpose=dr-drill.
 *
 * Usage:
 *   npm run dr:drill                       # --plan: print every AWS call, touch nothing
 *   npm run dr:drill -- --execute          # the real drill (creates + deletes an RDS instance)
 *   npm run dr:drill -- --teardown-only aivota-dr-drill-202608301200
 *   npm run dr:drill -- --help
 *
 * Prerequisites for --execute: AWS CLI + Session Manager plugin, `AWS_PROFILE`
 * (default `aac`) with rds:RestoreDBInstanceFromDBSnapshot / rds:DeleteDBInstance
 * / ssm:StartSession on the bastion, and a running `aivota-prod-bastion`.
 * ecr:DescribeImages on `aivota` and a reachable `origin` are optional but
 * without them the migration-head check falls back to commit times, which run
 * earlier than the deploy and can fail a good snapshot.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import {
  assessMigrationHead,
  loadMainJournal,
  loadWorkingTreeJournal,
  type DeployRecord,
  type Journal,
} from "./dr-drill-migration-head.js";

// ---------------------------------------------------------------------------
// Constants — mirror scripts/db-tunnel.sh and scripts/migrate-db.ts
// ---------------------------------------------------------------------------
const REGION = "il-central-1"; // the only Israeli region — do NOT parameterise
const SOURCE_DB = "aivota-prod-postgres";
const BASTION_TAG = "aivota-prod-bastion";
const ECR_REPOSITORY = "aivota"; // terraform/ecs.tf `aws_ecr_repository.main`; deploy.yml tags each image with github.sha
const DRILL_PREFIX = "aivota-dr-drill-";
const DRILL_TAG_KEY = "Purpose";
const DRILL_TAG_VALUE = "dr-drill";
const DEFAULT_INSTANCE_CLASS = "db.t3.micro";
const DEFAULT_LOCAL_PORT = 15433; // NOT 5432 — db-tunnel.sh owns that one
const DEFAULT_MAX_WAIT_MIN = 90;
const SECRET_IDS = ["aivota-prod/database", "aivota-prod-database-credentials", "aivota-prod-db"];

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DRILLS_DIR = path.join(ROOT, "docs", "dr", "drills");
const LOGS_DIR = path.join(ROOT, "logs");

/** Tables whose emptiness would mean the restore is not a usable production copy. */
const REQUIRED_NONEMPTY_TABLES = [
  "students",
  "users",
  "chat_sessions",
  "activity_logs",
  "medical_records",
] as const;

/** How stale the newest activity_logs row may be relative to the snapshot before we call it a failure. */
const MAX_ROW_LAG_HOURS = 24 * 7;
/** Clock skew we tolerate for a row that appears NEWER than the snapshot. */
const MAX_ROW_AHEAD_MIN = 5;

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
type Mode = "plan" | "execute" | "teardown" | "help";

interface Options {
  mode: Mode;
  snapshotId?: string;
  instanceClass: string;
  localPort: number;
  keep: boolean;
  maxWaitMin: number;
  teardownTarget?: string;
  profile: string;
}

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    mode: "plan",
    instanceClass: DEFAULT_INSTANCE_CLASS,
    localPort: DEFAULT_LOCAL_PORT,
    keep: false,
    maxWaitMin: DEFAULT_MAX_WAIT_MIN,
    profile: process.env.AWS_PROFILE || "aac",
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} requires a value`);
      return v;
    };
    switch (a) {
      case "--help":
      case "-h":
        opts.mode = "help";
        break;
      case "--plan":
        opts.mode = "plan";
        break;
      case "--execute":
        opts.mode = "execute";
        break;
      case "--teardown-only":
        opts.mode = "teardown";
        opts.teardownTarget = next();
        break;
      case "--snapshot":
        opts.snapshotId = next();
        break;
      case "--instance-class":
        opts.instanceClass = next();
        break;
      case "--local-port":
        opts.localPort = Number(next());
        break;
      case "--max-wait-min":
        opts.maxWaitMin = Number(next());
        break;
      case "--profile":
        opts.profile = next();
        break;
      case "--keep":
        opts.keep = true;
        break;
      default:
        throw new Error(`Unknown argument: ${a}`);
    }
  }
  if (!Number.isFinite(opts.localPort) || opts.localPort <= 0) {
    throw new Error("--local-port must be a positive number");
  }
  if (opts.localPort === 5432) {
    throw new Error("--local-port 5432 is refused: `npm run db-tunnel` owns it and a mixup would point the smoke checks at PRODUCTION.");
  }
  return opts;
}

const HELP = `
DR restore drill — in-region restore of the latest ${SOURCE_DB} snapshot.

  npx tsx scripts/dr-restore-drill.ts [mode] [options]
  npm run dr:drill -- [mode] [options]

Modes
  --plan                  (default) print every AWS call that --execute would make
                          and touch nothing. Read-only discovery is attempted; if
                          no AWS profile is available it degrades to placeholders.
  --execute               run the drill for real: restore, verify, tear down,
                          write the evidence file.
  --teardown-only <id>    delete a leftover drill instance. Refuses any id that
                          does not start with "${DRILL_PREFIX}" or that is not
                          tagged ${DRILL_TAG_KEY}=${DRILL_TAG_VALUE}.
  --help                  this text.

Options
  --snapshot <id>         restore this snapshot instead of the newest automated one.
  --instance-class <cls>  default ${DEFAULT_INSTANCE_CLASS}.
  --local-port <n>        local port for the SSM tunnel, default ${DEFAULT_LOCAL_PORT} (5432 is refused).
  --max-wait-min <n>      how long to wait for the restore to become available, default ${DEFAULT_MAX_WAIT_MIN}.
  --keep                  leave the drill instance running (you must tear it down yourself).
  --profile <name>        AWS profile, default $AWS_PROFILE or "aac".

Everything happens in ${REGION}. Cross-region copies are ruled out by AKIM §14 —
see docs/DISASTER_RECOVERY.md.
`.trimStart();

// ---------------------------------------------------------------------------
// Logging — file first, stdout second (CLAUDE.md: prefer a log file)
// ---------------------------------------------------------------------------
let logStream: fs.WriteStream | null = null;
const transcript: string[] = [];

function openLog(stamp: string): string {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
  const file = path.join(LOGS_DIR, `dr-drill-${stamp}.log`);
  logStream = fs.createWriteStream(file, { flags: "a" });
  return file;
}

function log(line = ""): void {
  transcript.push(line);
  logStream?.write(`${line}\n`);
  console.log(line);
}

function section(title: string): void {
  log("");
  log(`=== ${title} ===`);
}

// ---------------------------------------------------------------------------
// AWS CLI plumbing
//
// @aws-sdk/client-rds is NOT a dependency of this repo and this script is not a
// good enough reason to add one, so RDS/EC2/SSM go through the `aws` CLI the way
// scripts/fix-aac-session-ids.ts and scripts/migrate-staging-to-prod.ts do.
// Secrets Manager uses the SDK, which IS already a dependency.
// ---------------------------------------------------------------------------
let OPTS: Options;

function shellQuote(arg: string): string {
  return /[\s,"'=[\]{}|&<>^]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg;
}

function renderCommand(args: string[]): string {
  return ["aws", ...args].map(shellQuote).join(" ");
}

function awsArgs(args: string[]): string[] {
  return [...args, "--region", REGION, "--profile", OPTS.profile, "--output", "json"];
}

/** Run an AWS CLI call and parse its JSON. Throws on failure. */
function awsJson<T>(args: string[]): T {
  const full = awsArgs(args);
  const out = execFileSync("aws", full.map(shellQuote), {
    encoding: "utf8",
    shell: process.platform === "win32",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 32 * 1024 * 1024,
  });
  return JSON.parse(out || "{}") as T;
}

/**
 * Read-only discovery. Safe in every mode. In --plan a credential/permission
 * failure is reported and returns null rather than throwing a stack trace, so
 * the plan still prints on a machine with no AWS profile configured.
 */
function awsRead<T>(args: string[], what: string): T | null {
  log(`  [read ] ${renderCommand(awsArgs(args))}`);
  try {
    return awsJson<T>(args);
  } catch (err) {
    const msg = err instanceof Error ? err.message.split("\n").slice(0, 3).join(" | ") : String(err);
    if (OPTS.mode === "plan") {
      log(`  [read ] UNAVAILABLE (${what}): ${msg}`);
      return null;
    }
    throw new Error(`AWS call failed (${what}): ${msg}`);
  }
}

/** A call that CHANGES something. In --plan it is only printed. */
function awsMutate<T>(args: string[], what: string): T | null {
  if (OPTS.mode === "plan") {
    log(`  [WOULD] ${renderCommand(awsArgs(args))}`);
    return null;
  }
  log(`  [run  ] ${renderCommand(awsArgs(args))}`);
  return awsJson<T>(args);
}

// ---------------------------------------------------------------------------
// Types (only the fields we read)
// ---------------------------------------------------------------------------
interface DbInstance {
  DBInstanceIdentifier: string;
  DBInstanceArn: string;
  DBInstanceStatus: string;
  DBInstanceClass?: string;
  Engine?: string;
  EngineVersion?: string;
  Endpoint?: { Address?: string; Port?: number };
  DBSubnetGroup?: { DBSubnetGroupName?: string };
  VpcSecurityGroups?: { VpcSecurityGroupId?: string; Status?: string }[];
  DBParameterGroups?: { DBParameterGroupName?: string }[];
  MultiAZ?: boolean;
  DeletionProtection?: boolean;
  BackupRetentionPeriod?: number;
  KmsKeyId?: string;
}
interface DbSnapshot {
  DBSnapshotIdentifier: string;
  DBSnapshotArn?: string;
  SnapshotCreateTime?: string;
  Status?: string;
  SnapshotType?: string;
  Engine?: string;
  AllocatedStorage?: number;
  Encrypted?: boolean;
}
interface TagList {
  TagList?: { Key?: string; Value?: string }[];
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------
function describeSource(): DbInstance | null {
  const r = awsRead<{ DBInstances?: DbInstance[] }>(
    ["rds", "describe-db-instances", "--db-instance-identifier", SOURCE_DB],
    `describe ${SOURCE_DB}`,
  );
  const inst = r?.DBInstances?.[0] ?? null;
  if (inst) {
    log(`  source: class=${inst.DBInstanceClass} engine=${inst.Engine} ${inst.EngineVersion} multiAZ=${inst.MultiAZ} retention=${inst.BackupRetentionPeriod}d`);
    log(`  source: subnetGroup=${inst.DBSubnetGroup?.DBSubnetGroupName} sg=${(inst.VpcSecurityGroups ?? []).map((s) => s.VpcSecurityGroupId).join(",")} paramGroup=${inst.DBParameterGroups?.[0]?.DBParameterGroupName}`);
  }
  return inst;
}

function pickSnapshot(explicitId?: string): DbSnapshot | null {
  if (explicitId) {
    const r = awsRead<{ DBSnapshots?: DbSnapshot[] }>(
      ["rds", "describe-db-snapshots", "--db-snapshot-identifier", explicitId],
      `describe snapshot ${explicitId}`,
    );
    const snap = r?.DBSnapshots?.[0] ?? null;
    if (snap) log(`  snapshot: ${snap.DBSnapshotIdentifier} (${snap.SnapshotType}, ${snap.SnapshotCreateTime}, ${snap.Status})`);
    return snap;
  }
  const r = awsRead<{ DBSnapshots?: DbSnapshot[] }>(
    ["rds", "describe-db-snapshots", "--db-instance-identifier", SOURCE_DB, "--snapshot-type", "automated"],
    `list automated snapshots of ${SOURCE_DB}`,
  );
  const snaps = (r?.DBSnapshots ?? [])
    .filter((s) => s.Status === "available" && s.SnapshotCreateTime)
    .sort((a, b) => Date.parse(b.SnapshotCreateTime!) - Date.parse(a.SnapshotCreateTime!));
  if (!snaps.length) {
    if (OPTS.mode === "plan") {
      log("  snapshot: none discovered (plan mode continues with a placeholder)");
      return null;
    }
    throw new Error(
      `No available automated snapshot of ${SOURCE_DB}. Take one first:\n` +
        `  aws rds create-db-snapshot --profile ${OPTS.profile} --region ${REGION} --db-instance-identifier ${SOURCE_DB} --db-snapshot-identifier dr-drill-source-$(date +%Y%m%d%H%M)\n` +
        `or pass --snapshot <id>.`,
    );
  }
  const snap = snaps[0];
  const ageH = ((Date.now() - Date.parse(snap.SnapshotCreateTime!)) / 3600_000).toFixed(1);
  log(`  snapshot: ${snap.DBSnapshotIdentifier} created ${snap.SnapshotCreateTime} (${ageH}h old), ${snaps.length} available`);
  return snap;
}

function findBastion(): string | null {
  const r = awsRead<{ Reservations?: { Instances?: { InstanceId?: string }[] }[] }>(
    [
      "ec2", "describe-instances",
      "--filters", `Name=tag:Name,Values=${BASTION_TAG}`, "Name=instance-state-name,Values=running",
    ],
    `find bastion ${BASTION_TAG}`,
  );
  const id = r?.Reservations?.[0]?.Instances?.[0]?.InstanceId ?? null;
  if (id) log(`  bastion: ${id}`);
  else if (OPTS.mode === "plan") log("  bastion: not discovered (plan mode continues with a placeholder)");
  return id;
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------
function assertDrillIdentifier(id: string): void {
  if (!id.startsWith(DRILL_PREFIX)) {
    throw new Error(
      `Refusing to act on "${id}": a drill identifier must start with "${DRILL_PREFIX}". ` +
        `This guard is what stops a typo from pointing the restore or the delete at ${SOURCE_DB}.`,
    );
  }
}

/**
 * Refuse to delete anything that is not tagged Purpose=dr-drill. In --plan the
 * tag lookup is best-effort; the delete itself is never issued there anyway.
 */
function assertDrillTagged(instance: DbInstance | null, identifier: string): void {
  assertDrillIdentifier(identifier);
  if (!instance) {
    if (OPTS.mode === "plan") {
      log(`  [guard] would verify ${DRILL_TAG_KEY}=${DRILL_TAG_VALUE} on ${identifier} before deleting`);
      return;
    }
    throw new Error(`Cannot verify tags: ${identifier} was not found.`);
  }
  const tags = awsRead<TagList>(
    ["rds", "list-tags-for-resource", "--resource-name", instance.DBInstanceArn],
    `tags of ${identifier}`,
  );
  if (!tags && OPTS.mode === "plan") {
    log(`  [guard] would verify ${DRILL_TAG_KEY}=${DRILL_TAG_VALUE} on ${identifier} before deleting`);
    return;
  }
  const ok = (tags?.TagList ?? []).some((t) => t.Key === DRILL_TAG_KEY && t.Value === DRILL_TAG_VALUE);
  if (!ok) {
    throw new Error(
      `Refusing to delete ${identifier}: it is not tagged ${DRILL_TAG_KEY}=${DRILL_TAG_VALUE}. ` +
        `Only instances this script created are deletable by it.`,
    );
  }
  log(`  [guard] ${identifier} is tagged ${DRILL_TAG_KEY}=${DRILL_TAG_VALUE} — safe to delete`);
}

// ---------------------------------------------------------------------------
// Restore + wait + teardown
// ---------------------------------------------------------------------------
function restoreArgs(target: string, snapshotId: string, source: DbInstance | null): string[] {
  const subnetGroup = source?.DBSubnetGroup?.DBSubnetGroupName ?? "<source-db-subnet-group>";
  const sgs = (source?.VpcSecurityGroups ?? []).map((s) => s.VpcSecurityGroupId!).filter(Boolean);
  const paramGroup = source?.DBParameterGroups?.[0]?.DBParameterGroupName ?? "<source-parameter-group>";
  return [
    "rds", "restore-db-instance-from-db-snapshot",
    "--db-instance-identifier", target,
    "--db-snapshot-identifier", snapshotId,
    "--db-instance-class", OPTS.instanceClass,
    "--db-subnet-group-name", subnetGroup,
    "--vpc-security-group-ids", ...(sgs.length ? sgs : ["<source-security-group>"]),
    // Same parameter group as prod, so rds.force_ssl=1 applies to the drill copy
    // too and the smoke-check connection is TLS exactly like production.
    "--db-parameter-group-name", paramGroup,
    "--no-publicly-accessible",
    "--no-multi-az",
    "--no-deletion-protection",
    "--tags", `Key=${DRILL_TAG_KEY},Value=${DRILL_TAG_VALUE}`, "Key=Name,Value=" + target, "Key=DataClass,Value=PHI",
  ];
}

function waitForAvailable(target: string): { instance: DbInstance | null; availableAt: Date | null; elapsedSec: number } {
  const started = Date.now();
  if (OPTS.mode === "plan") {
    log(`  [WOULD] poll: ${renderCommand(awsArgs(["rds", "describe-db-instances", "--db-instance-identifier", target]))}`);
    log("  [WOULD] every 30s until DBInstanceStatus == \"available\" (typically 10-25 min for a snapshot restore)");
    return { instance: null, availableAt: null, elapsedSec: 0 };
  }
  const deadline = started + OPTS.maxWaitMin * 60_000;
  let last = "";
  for (;;) {
    const r = awsJson<{ DBInstances?: DbInstance[] }>(["rds", "describe-db-instances", "--db-instance-identifier", target]);
    const inst = r.DBInstances?.[0];
    const status = inst?.DBInstanceStatus ?? "unknown";
    const elapsed = Math.round((Date.now() - started) / 1000);
    if (status !== last) {
      log(`  [wait ] ${target}: ${status} (+${elapsed}s)`);
      last = status;
    } else if (elapsed % 300 < 30) {
      log(`  [wait ] ${target}: still ${status} (+${elapsed}s)`);
    }
    if (status === "available" && inst) {
      log(`  [wait ] available after ${elapsed}s (${(elapsed / 60).toFixed(1)} min)`);
      return { instance: inst, availableAt: new Date(), elapsedSec: elapsed };
    }
    if (["failed", "incompatible-restore", "incompatible-parameters", "deleting"].includes(status)) {
      throw new Error(`Restore of ${target} ended in status "${status}".`);
    }
    if (Date.now() > deadline) {
      throw new Error(
        `${target} did not reach "available" within ${OPTS.maxWaitMin} min (last status "${status}"). ` +
          `Tear it down with: npm run dr:drill -- --teardown-only ${target}`,
      );
    }
    sleepSync(30_000);
  }
}

function teardown(target: string): { at: Date | null; skipped: boolean } {
  section(`Teardown — ${target}`);
  assertDrillIdentifier(target);
  let inst: DbInstance | null = null;
  const r = awsRead<{ DBInstances?: DbInstance[] }>(
    ["rds", "describe-db-instances", "--db-instance-identifier", target],
    `describe ${target}`,
  );
  inst = r?.DBInstances?.[0] ?? null;
  if (OPTS.mode !== "plan" && !inst) {
    log(`  ${target} does not exist — nothing to delete.`);
    return { at: null, skipped: true };
  }
  assertDrillTagged(inst, target);
  awsMutate(
    [
      "rds", "delete-db-instance",
      "--db-instance-identifier", target,
      "--skip-final-snapshot",
      // The drill instance inherits automated backups it does not need; leaving
      // them behind would keep billing (and holding PHI) after the drill.
      "--delete-automated-backups",
    ],
    `delete ${target}`,
  );
  if (OPTS.mode === "plan") return { at: null, skipped: false };
  log(`  delete requested; RDS removes the instance asynchronously (a few minutes).`);
  return { at: new Date(), skipped: false };
}

// ---------------------------------------------------------------------------
// Tunnel + smoke checks
// ---------------------------------------------------------------------------
function tunnelArgs(bastionId: string, host: string, localPort: number): string[] {
  return [
    "ssm", "start-session",
    "--target", bastionId,
    "--document-name", "AWS-StartPortForwardingSessionToRemoteHost",
    "--parameters", `host=${host},portNumber=5432,localPortNumber=${localPort}`,
    "--region", REGION,
    "--profile", OPTS.profile,
  ];
}

function startTunnel(bastionId: string, host: string, localPort: number): ChildProcess {
  const args = tunnelArgs(bastionId, host, localPort);
  log(`  [run  ] ${["aws", ...args].map(shellQuote).join(" ")}`);
  return spawn("aws", args.map(shellQuote), {
    stdio: "ignore",
    shell: process.platform === "win32",
  });
}

function sleepSync(ms: number): void {
  // Deliberately synchronous: the poll loop is a script, not a server, and a
  // blocking wait keeps the transcript strictly ordered.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

async function waitForPort(port: number, timeoutMs = 60_000): Promise<void> {
  const start = Date.now();
  for (;;) {
    const open = await new Promise<boolean>((resolve) => {
      const sock = net.connect({ host: "127.0.0.1", port });
      const done = (ok: boolean) => {
        sock.destroy();
        resolve(ok);
      };
      sock.once("connect", () => done(true));
      sock.once("error", () => done(false));
      setTimeout(() => done(false), 3000);
    });
    if (open) return;
    if (Date.now() - start > timeoutMs) throw new Error(`SSM tunnel did not open on localhost:${port} within ${timeoutMs / 1000}s`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

interface DbCreds {
  user: string;
  password: string;
  database: string;
}

async function loadProdCredentials(): Promise<DbCreds> {
  if (process.env.PROD_DATABASE_URL) {
    const u = new URL(process.env.PROD_DATABASE_URL);
    return {
      user: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password),
      database: u.pathname.slice(1) || "aivota",
    };
  }
  process.env.AWS_PROFILE = OPTS.profile;
  const sm = new SecretsManagerClient({ region: REGION });
  for (const id of SECRET_IDS) {
    try {
      const r = await sm.send(new GetSecretValueCommand({ SecretId: id }));
      const j = JSON.parse(r.SecretString || "{}");
      if (j.DATABASE_URL) {
        const u = new URL(j.DATABASE_URL);
        return {
          user: decodeURIComponent(u.username),
          password: decodeURIComponent(u.password),
          database: u.pathname.slice(1) || j.DB_NAME || "aivota",
        };
      }
      if (j.DB_USER && j.DB_PASSWORD) {
        return { user: j.DB_USER, password: j.DB_PASSWORD, database: j.DB_NAME || "aivota" };
      }
    } catch {
      /* try the next id */
    }
  }
  throw new Error(
    `Could not resolve the master credentials from Secrets Manager (${SECRET_IDS.join(", ")}). ` +
      `Set PROD_DATABASE_URL instead. The restored instance carries the SAME master password as the snapshot.`,
  );
}

interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

/**
 * The two yardsticks for the migration-head check: origin/main (what production
 * deploys) and this checkout. Loaded once; the git read is logged either way.
 */
function loadJournals(): { main: Journal | null; workingTree: Journal } {
  const workingTree = loadWorkingTreeJournal(ROOT);
  const main = loadMainJournal(ROOT, "origin/main", loadDeployHistory());
  for (const n of main.notes) log(`  [git  ] ${n}`);
  const treeHead = workingTree.entries[workingTree.entries.length - 1];
  const mainHead = main.journal?.entries[main.journal.entries.length - 1];
  log(`  journal: origin/main head ${mainHead ? `${mainHead.tag} (${main.journal!.entries.length})` : "UNAVAILABLE"} | working tree head ${treeHead.tag} (${workingTree.entries.length})`);
  return { main: main.journal, workingTree };
}

/**
 * Production deploy history = ECR image pushes (deploy.yml tags every image with
 * `github.sha`). Read-only and best-effort: without it the head check dates
 * migrations by commit time, which errs toward failing.
 */
function loadDeployHistory(): DeployRecord[] | null {
  interface Images { imageDetails?: { imageTags?: string[]; imagePushedAt?: string }[] }
  let r: Images | null = null;
  try {
    r = awsRead<Images>(["ecr", "describe-images", "--repository-name", ECR_REPOSITORY], `deploy history from ECR ${ECR_REPOSITORY}`);
  } catch (err) {
    log(`  [read ] UNAVAILABLE (deploy history): ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
  }
  if (!r) return null;
  const deploys: DeployRecord[] = [];
  for (const img of r.imageDetails ?? []) {
    const sha = (img.imageTags ?? []).find((t) => /^[0-9a-f]{40}$/.test(t));
    if (sha && img.imagePushedAt) deploys.push({ sha, pushedAt: new Date(img.imagePushedAt) });
  }
  deploys.sort((a, b) => a.pushedAt.getTime() - b.pushedAt.getTime());
  const last = deploys[deploys.length - 1];
  log(`  deploys: ${deploys.length} image(s) in ECR ${ECR_REPOSITORY}${last ? `, newest ${last.sha.slice(0, 8)} pushed ${last.pushedAt.toISOString()}` : ""}`);
  return deploys;
}

async function runSmokeChecks(
  client: pg.Client,
  snapshotTime: Date | null,
  journals: { main: Journal | null; workingTree: Journal },
): Promise<{ checks: CheckResult[]; rpoText: string; notes: string[] }> {
  const checks: CheckResult[] = [];
  const notes: string[] = [];

  // 1. migration head — against origin/main, the schema production actually runs.
  try {
    const r = await client.query<{ hash: string; created_at: string; n: string }>(
      `select hash, created_at, (select count(*) from drizzle.__drizzle_migrations)::text as n
         from drizzle.__drizzle_migrations
        order by created_at desc, id desc
        limit 1`,
    );
    const row = r.rows[0];
    const verdict = assessMigrationHead({
      dbHash: row?.hash ?? null,
      applied: Number(row?.n ?? 0),
      main: journals.main,
      workingTree: journals.workingTree,
      snapshotTime,
    });
    checks.push({ name: "migration head", ok: verdict.ok, detail: verdict.detail });
    notes.push(...verdict.notes);
  } catch (err) {
    checks.push({ name: "migration head", ok: false, detail: `query failed: ${(err as Error).message}` });
  }

  // 2. row counts
  for (const table of REQUIRED_NONEMPTY_TABLES) {
    try {
      const r = await client.query<{ n: string }>(`select count(*)::text as n from ${table}`);
      const n = Number(r.rows[0].n);
      checks.push({ name: `rows: ${table}`, ok: n > 0, detail: `${n.toLocaleString("en-US")} rows` });
    } catch (err) {
      checks.push({ name: `rows: ${table}`, ok: false, detail: `query failed: ${(err as Error).message}` });
    }
  }

  // 3. freshness — the observed RPO of the snapshot path
  let rpoText = "not measured";
  try {
    const r = await client.query<{ newest: string | null }>(`select max(created_at)::text as newest from activity_logs`);
    const newest = r.rows[0]?.newest ? new Date(r.rows[0].newest.replace(" ", "T") + (/[Zz+]/.test(r.rows[0].newest) ? "" : "Z")) : null;
    if (!newest || Number.isNaN(newest.getTime())) {
      checks.push({ name: "data freshness", ok: false, detail: "activity_logs has no readable created_at" });
    } else if (!snapshotTime) {
      rpoText = `newest activity_logs row ${newest.toISOString()} (snapshot time unknown)`;
      checks.push({ name: "data freshness", ok: true, detail: rpoText });
    } else {
      const lagMs = snapshotTime.getTime() - newest.getTime();
      const lagH = lagMs / 3600_000;
      const aheadOk = lagMs >= -MAX_ROW_AHEAD_MIN * 60_000;
      const staleOk = lagH <= MAX_ROW_LAG_HOURS;
      rpoText =
        `newest activity_logs row ${newest.toISOString()} vs snapshot ${snapshotTime.toISOString()} ` +
        `→ ${lagH >= 0 ? lagH.toFixed(2) : "-" + Math.abs(lagH).toFixed(2)} h inside the snapshot`;
      checks.push({
        name: "data freshness",
        ok: aheadOk && staleOk,
        detail: !aheadOk
          ? `${rpoText} — a row NEWER than the snapshot means this is not the snapshot we think it is`
          : !staleOk
            ? `${rpoText} — more than ${MAX_ROW_LAG_HOURS}h of silence before the snapshot; investigate before trusting the backup`
            : rpoText,
      });
    }
  } catch (err) {
    checks.push({ name: "data freshness", ok: false, detail: `query failed: ${(err as Error).message}` });
  }

  return { checks, rpoText, notes };
}

// ---------------------------------------------------------------------------
// Evidence file
// ---------------------------------------------------------------------------
interface Evidence {
  mode: Mode;
  commandLine: string;
  operator: string;
  target: string;
  snapshotId: string;
  snapshotTime: string;
  instanceClass: string;
  restoreStart: Date | null;
  availableAt: Date | null;
  restoreSeconds: number;
  checksAt: Date | null;
  teardownAt: Date | null;
  kept: boolean;
  checks: CheckResult[];
  rpoText: string;
  notes: string[];
  logFile: string;
}

function iso(d: Date | null): string {
  return d ? d.toISOString() : "—";
}

function writeEvidence(ev: Evidence): string {
  fs.mkdirSync(DRILLS_DIR, { recursive: true });
  const day = new Date().toISOString().slice(0, 10);
  let file = path.join(DRILLS_DIR, `${day}-restore-drill.md`);
  let n = 2;
  while (fs.existsSync(file)) file = path.join(DRILLS_DIR, `${day}-restore-drill-${n++}.md`);

  const passed = ev.checks.filter((c) => c.ok).length;
  const failed = ev.checks.length - passed;
  const verdict = ev.checks.length === 0 ? "INCOMPLETE" : failed === 0 ? "PASS" : "FAIL";
  const mins = ev.restoreSeconds ? (ev.restoreSeconds / 60).toFixed(1) : "—";

  const body = `# DR restore drill — ${day}

**Result: ${verdict}** (${passed} passed, ${failed} failed)

Region \`${REGION}\` throughout — no snapshot left Israel. Cross-region copies are
ruled out by AKIM §14; see [../../DISASTER_RECOVERY.md](../../DISASTER_RECOVERY.md).

| Field | Value |
|---|---|
| Source instance | \`${SOURCE_DB}\` |
| Snapshot | \`${ev.snapshotId}\` |
| Snapshot created | ${ev.snapshotTime} |
| Drill instance | \`${ev.target}\` (${ev.instanceClass}, single-AZ, private, deletion protection off) |
| Restore requested | ${iso(ev.restoreStart)} |
| Restore available | ${iso(ev.availableAt)} |
| **Measured restore duration** | **${mins} min** (${ev.restoreSeconds}s) — the empirical restore component of RTO |
| Smoke checks completed | ${iso(ev.checksAt)} |
| Teardown | ${ev.kept ? "SKIPPED (--keep)" : iso(ev.teardownAt)} |
| Observed RPO | ${ev.rpoText} |
| Operator | ${ev.operator} |
| Command | \`${ev.commandLine}\` |
| Transcript | \`${path.relative(ROOT, ev.logFile).replace(/\\/g, "/")}\` (gitignored) |

## Checks

| Check | Result | Detail |
|---|---|---|
${ev.checks.map((c) => `| ${c.name} | ${c.ok ? "✅ pass" : "❌ FAIL"} | ${c.detail.replace(/\|/g, "\\|")} |`).join("\n") || "| _none run_ | — | — |"}

## RTO / RPO read-out

- **Restore duration (measured):** ${mins} min for the snapshot restore alone.
  Full RTO also includes the decision to fail over, the \`aivota-prod/database\`
  secret edit and the ECS \`force-new-deployment\` roll (see the runbook's cutover
  step) — add those to the number above before quoting an RTO.
- **RPO (snapshot path, measured):** ${ev.rpoText}
- **RPO (PITR path):** RDS continuous backup targets ~5 minutes and is NOT
  exercised by this drill. Restoring to a point in time uses
  \`aws rds restore-db-instance-to-point-in-time\` — same guards apply.

## Notes

${ev.notes.length ? ev.notes.map((n2) => `- ${n2}`).join("\n") : "- (none)"}
`;
  fs.writeFileSync(file, body, "utf8");
  return file;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  OPTS = parseArgs(argv);

  if (OPTS.mode === "help") {
    console.log(HELP);
    return;
  }

  const now = new Date();
  const stamp =
    `${now.getUTCFullYear()}` +
    `${String(now.getUTCMonth() + 1).padStart(2, "0")}` +
    `${String(now.getUTCDate()).padStart(2, "0")}` +
    `${String(now.getUTCHours()).padStart(2, "0")}` +
    `${String(now.getUTCMinutes()).padStart(2, "0")}`;
  const logFile = openLog(stamp);
  const operator = process.env.USER || process.env.USERNAME || "unknown";
  const commandLine = ["npx tsx scripts/dr-restore-drill.ts", ...argv].join(" ");

  log(`DR restore drill — mode: ${OPTS.mode.toUpperCase()}`);
  log(`Region ${REGION} (in-region only — a cross-region copy would be a §14 transfer)`);
  log(`Profile: ${OPTS.profile} | operator: ${operator} | started: ${now.toISOString()}`);
  log(`Transcript: ${path.relative(ROOT, logFile).replace(/\\/g, "/")}`);
  log(`Command: ${commandLine}`);
  if (OPTS.mode === "plan") {
    log("");
    log("PLAN MODE — nothing is created, changed or deleted. Read-only discovery is");
    log("attempted; lines marked [WOULD] are the calls --execute would issue.");
  }

  if (OPTS.mode === "teardown") {
    const target = OPTS.teardownTarget!;
    OPTS.mode = "execute"; // a teardown-only run really does delete
    teardown(target);
    log("");
    log("Teardown requested. No evidence file is written for a teardown-only run.");
    return;
  }

  const notes: string[] = [];

  section("1. Discover the source instance");
  const source = describeSource();
  if (!source && OPTS.mode === "plan") notes.push("Plan generated without AWS discovery — subnet group / security group are placeholders.");

  section("2. Choose the snapshot");
  const snapshot = pickSnapshot(OPTS.snapshotId);
  const snapshotId = snapshot?.DBSnapshotIdentifier ?? OPTS.snapshotId ?? "<newest-automated-snapshot>";
  const snapshotTime = snapshot?.SnapshotCreateTime ? new Date(snapshot.SnapshotCreateTime) : null;
  if (snapshot && snapshot.Encrypted === false) {
    notes.push("Snapshot reports Encrypted=false — expected true (CMK). Investigate before relying on it.");
  }

  const target = `${DRILL_PREFIX}${stamp}`;
  assertDrillIdentifier(target);

  section(`3. Restore into ${target}`);
  log(`  target class: ${OPTS.instanceClass}, single-AZ, not publicly accessible, deletion protection OFF, tagged ${DRILL_TAG_KEY}=${DRILL_TAG_VALUE}`);
  const restoreStart = OPTS.mode === "execute" ? new Date() : null;
  awsMutate(restoreArgs(target, snapshotId, source), `restore ${target}`);

  section("4. Wait for the restore to become available");
  const waited = waitForAvailable(target);
  const drillInstance = waited.instance;

  section("5. Tunnel to the drill instance through the bastion");
  const bastion = findBastion();
  const drillHost = drillInstance?.Endpoint?.Address ?? `${target}.<rds-suffix>.${REGION}.rds.amazonaws.com`;
  let tunnel: ChildProcess | null = null;
  let checksAt: Date | null = null;
  let checks: CheckResult[] = [];
  let rpoText = "not measured";

  if (OPTS.mode === "plan") {
    log(`  [WOULD] ${["aws", ...tunnelArgs(bastion ?? "<bastion-instance-id>", drillHost, OPTS.localPort)].map(shellQuote).join(" ")}`);
    log(`  [WOULD] read master credentials from Secrets Manager (${SECRET_IDS.join(" | ")}) via @aws-sdk/client-secrets-manager`);
    log(`  [WOULD] connect pg to localhost:${OPTS.localPort} over TLS (rds-ca-bundle.pem, hostname check relaxed — the tunnel presents the RDS cert on localhost)`);
    section("6. Smoke checks (plan)");
    const journals = loadJournals();
    const mainHead = journals.main?.entries[journals.main.entries.length - 1];
    log(`  [WOULD] migration head == origin/main head (${mainHead ? mainHead.tag : "unavailable — would fall back to this checkout"}); a working tree that is ahead is a note, not a failure`);
    for (const t of REQUIRED_NONEMPTY_TABLES) log(`  [WOULD] select count(*) from ${t} — must be > 0`);
    log(`  [WOULD] select max(created_at) from activity_logs — must fall inside the snapshot window (that gap IS the observed RPO)`);
  } else {
    if (!bastion) throw new Error(`No running bastion tagged Name=${BASTION_TAG}; cannot reach the private drill instance.`);
    tunnel = startTunnel(bastion, drillHost, OPTS.localPort);
    try {
      await waitForPort(OPTS.localPort);
      log(`  tunnel up: localhost:${OPTS.localPort} → ${drillHost}:5432`);
      const creds = await loadProdCredentials();
      const ca = fs.readFileSync(path.join(ROOT, "rds-ca-bundle.pem"), "utf8");
      const client = new pg.Client({
        host: "127.0.0.1",
        port: OPTS.localPort,
        user: creds.user,
        password: creds.password,
        database: creds.database,
        // Chain verified against the AWS CA; hostname check relaxed because the
        // tunnel presents the RDS certificate on localhost (same as
        // scripts/migrate-sessions-to-prod.ts).
        ssl: { ca, checkServerIdentity: () => undefined },
      });
      await client.connect();
      section("6. Smoke checks");
      try {
        const journals = loadJournals();
        const res = await runSmokeChecks(client, snapshotTime, journals);
        checks = res.checks;
        rpoText = res.rpoText;
        notes.push(...res.notes);
        for (const c of checks) log(`  ${c.ok ? "✅" : "❌"} ${c.name}: ${c.detail}`);
        for (const n of res.notes) log(`  ℹ️  ${n}`);
      } finally {
        await client.end();
      }
      checksAt = new Date();
    } finally {
      tunnel?.kill();
      log("  tunnel closed");
    }
  }

  section("7. Teardown");
  let teardownAt: Date | null = null;
  if (OPTS.keep) {
    log(`  --keep: leaving ${target} running. Tear it down with:`);
    log(`    npm run dr:drill -- --teardown-only ${target}`);
    notes.push(`--keep was passed; ${target} was still running when this file was written.`);
  } else {
    teardownAt = teardown(target).at;
  }

  section("8. Evidence");
  if (OPTS.mode === "plan") {
    log(`  [WOULD] write docs/dr/drills/${new Date().toISOString().slice(0, 10)}-restore-drill.md`);
    log("  [WOULD] record: snapshot id + time, restore start/available/teardown, measured duration,");
    log("  [WOULD]         observed RPO, checks passed/failed, operator, command line.");
    log("");
    log("Plan complete. Nothing was changed. Re-run with --execute to perform the drill.");
    return;
  }

  const file = writeEvidence({
    mode: OPTS.mode,
    commandLine,
    operator,
    target,
    snapshotId,
    snapshotTime: snapshotTime ? snapshotTime.toISOString() : "unknown",
    instanceClass: OPTS.instanceClass,
    restoreStart,
    availableAt: waited.availableAt,
    restoreSeconds: waited.elapsedSec,
    checksAt,
    teardownAt,
    kept: OPTS.keep,
    checks,
    rpoText,
    notes,
    logFile,
  });
  log(`  evidence: ${path.relative(ROOT, file).replace(/\\/g, "/")}`);
  const failed = checks.filter((c) => !c.ok);
  log("");
  log(failed.length ? `DRILL FAILED — ${failed.length} check(s) failed. See the evidence file.` : "DRILL PASSED.");
  if (failed.length) process.exitCode = 1;
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  log("");
  log(`ERROR: ${msg}`);
  if (process.env.DR_DRILL_DEBUG) console.error(err);
  process.exitCode = 1;
});
