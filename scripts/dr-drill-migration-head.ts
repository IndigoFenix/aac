/**
 * DR drill — the "migration head" check, isolated so it can be unit-tested.
 *
 * The question the drill has to answer is "does the restored snapshot carry the
 * schema PRODUCTION runs?", and production deploys `origin/main`
 * (.github/workflows/deploy.yml). The working tree is the wrong yardstick: on
 * `staging` it is routinely one or more migrations ahead of prod, and the first
 * two drills (2026-08-31, 2026-09-01) failed this check for exactly that reason
 * while the backup itself was fine.
 *
 * So the check resolves the restored head hash against TWO journals:
 *   - `main`        what production deploys (origin/main, read via git)
 *   - `workingTree` this checkout (drizzle/meta/_journal.json + drizzle/*.sql)
 * and passes when the restored head is origin/main's head. A working tree that is
 * ahead is reported as a note, never a failure. See docs/DISASTER_RECOVERY.md.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface JournalEntry {
  idx: number;
  tag: string;
  /** sha256 of the raw .sql — the value drizzle's migrator records (scripts/migrate.ts). */
  hash: string;
  /**
   * When production first ran this migration: the push time of the earliest
   * ECR image whose commit contains the .sql (deploy.yml tags every image with
   * `github.sha`). origin/main only; absent when ECR history was unavailable or
   * the image has been expired.
   */
  deployedAt?: Date;
  /**
   * Fallback clock: the committer date of the last commit touching the .sql on
   * origin/main. Commit time is NOT deploy time — `staging` fast-forwards into
   * `main`, so a migration committed on Monday and pushed Friday reads "Monday"
   * (the 2026-08-31 drill: 0165–0170 committed Aug 25–30, all deployed Aug 31
   * 06:38Z). Used only when `deployedAt` is unknown, and it errs toward FAILING.
   */
  committedAt?: Date;
}

/** An image push = a production deploy. From `aws ecr describe-images`. */
export interface DeployRecord {
  /** The commit the image was built from (its ECR tag). */
  sha: string;
  pushedAt: Date;
}

/**
 * A migration that reached production less than this long before the snapshot
 * may not have run yet when the snapshot was taken (the migrator runs at task
 * boot, minutes after the image push). Inside the window it is not a finding;
 * outside it, production should have carried the migration.
 */
export const DEPLOY_GRACE_MS = 60 * 60_000;

export interface Journal {
  /** Where this journal came from, for messages: "origin/main", "working tree". */
  source: string;
  /** Sorted by idx ascending. */
  entries: JournalEntry[];
}

export interface HeadAssessmentInput {
  /** `hash` of the newest row in drizzle.__drizzle_migrations, or null when the table is empty. */
  dbHash: string | null;
  /** Row count of drizzle.__drizzle_migrations. */
  applied: number;
  /** origin/main's journal, or null when git could not provide it. */
  main: Journal | null;
  workingTree: Journal;
  /** When the restored snapshot was taken; null if unknown. */
  snapshotTime: Date | null;
}

export interface HeadAssessment {
  ok: boolean;
  /** One line for the checks table. */
  detail: string;
  /** Extra context for the evidence file's Notes section. */
  notes: string[];
}

const short = (h: string) => `${h.slice(0, 12)}…`;

function headOf(j: Journal): JournalEntry | undefined {
  return j.entries[j.entries.length - 1];
}

function find(j: Journal | null, hash: string): JournalEntry | undefined {
  return j?.entries.find((e) => e.hash === hash);
}

function listTags(entries: JournalEntry[], max = 4): string {
  return truncate(entries.map((e) => e.tag), max);
}

function truncate(items: string[], max: number): string {
  return items.length <= max ? items.join(", ") : `${items.slice(0, max).join(", ")} … +${items.length - max}`;
}

/** When (and by which clock) a migration reached production. */
function landing(e: JournalEntry): { at: Date; how: "deployed" | "committed" } | null {
  if (e.deployedAt) return { at: e.deployedAt, how: "deployed" };
  if (e.committedAt) return { at: e.committedAt, how: "committed" };
  return null;
}

function describeLanding(entries: JournalEntry[], max = 4): string {
  return truncate(
    entries.map((e) => {
      const l = landing(e);
      return l ? `${e.tag} (${l.how} ${l.at.toISOString()})` : e.tag;
    }),
    max,
  );
}

export function assessMigrationHead(input: HeadAssessmentInput): HeadAssessment {
  const { dbHash, applied, main, workingTree, snapshotTime } = input;
  const notes: string[] = [];

  if (!dbHash || applied === 0) {
    return {
      ok: false,
      detail: "drizzle.__drizzle_migrations is empty — the restored database has never been migrated; this is not a production copy",
      notes,
    };
  }

  const inMain = find(main, dbHash);
  const inTree = find(workingTree, dbHash);
  const known = inMain ?? inTree;

  if (!known) {
    return {
      ok: false,
      detail:
        `restored head ${short(dbHash)} is not any migration in ${main ? "origin/main or " : ""}this checkout (${applied} applied) — ` +
        `the snapshot carries a schema this repo does not know; do not cut over to it without finding out why`,
      notes,
    };
  }

  // The ledger should hold exactly one row per migration up to the head.
  if (applied !== known.idx + 1) {
    notes.push(
      `drizzle.__drizzle_migrations has ${applied} rows but the head ${known.tag} is idx ${known.idx} (expected ${known.idx + 1} rows) — the ledger is inconsistent; worth a look, but not a restore defect.`,
    );
  }

  const treeHead = headOf(workingTree);
  const treeAhead = treeHead && treeHead.idx > known.idx ? workingTree.entries.filter((e) => e.idx > known.idx) : [];

  if (!main) {
    if (treeAhead.length) {
      notes.push(
        `origin/main was unavailable, so the head was compared against this checkout only. The working tree is ${treeAhead.length} migration(s) ahead of the snapshot (${listTags(treeAhead)}) — unreleased on this branch or undeployed to production; the drill cannot tell which without origin/main.`,
      );
    } else {
      notes.push("origin/main was unavailable; the head was compared against this checkout only.");
    }
    return {
      ok: true,
      detail: `${known.tag} (${applied}/${workingTree.entries.length} in this checkout; origin/main unavailable)`,
      notes,
    };
  }

  const mainHead = headOf(main);
  if (!mainHead) {
    return { ok: false, detail: "origin/main has no migrations at all — the journal read is broken", notes };
  }

  if (!inMain) {
    // Known only to the working tree: production carries a migration main does not.
    return {
      ok: false,
      detail:
        `restored head ${known.tag} is not on origin/main (main head ${mainHead.tag}) — production was migrated from a branch; ` +
        `merge it before the next deploy or the migrator will diverge`,
      notes,
    };
  }

  if (inMain.idx < mainHead.idx) {
    const missing = main.entries.filter((e) => e.idx > inMain.idx);
    // Migrations that reached production AFTER the snapshot could not be in it —
    // that is the 2026-08-31 drill (snapshot 03:05Z, deploy 06:38Z), not a
    // backup defect. Ones deployed well before the snapshot should be in it.
    const cutoff = snapshotTime ? snapshotTime.getTime() - DEPLOY_GRACE_MS : null;
    const undated = missing.filter((e) => !landing(e));
    const stale = cutoff === null ? [] : missing.filter((e) => (landing(e)?.at.getTime() ?? Infinity) < cutoff);
    if (cutoff !== null && undated.length === 0 && stale.length === 0) {
      notes.push(
        `origin/main gained ${missing.length} migration(s) that reached production after the snapshot: ${describeLanding(missing)}. ` +
          `The restored schema is what production ran at snapshot time; re-run after the next nightly snapshot to see them included.`,
      );
      if (missing.some((e) => landing(e)?.how === "committed")) {
        notes.push("Some of those are dated by commit time (ECR deploy history was unavailable or the image has expired); commit time can only be earlier than the deploy, so the verdict stands.");
      }
      return {
        ok: true,
        detail: `${known.tag} == origin/main head as of the snapshot (${applied}/${main.entries.length} applied); main +${missing.length} since`,
        notes,
      };
    }
    const why =
      cutoff === null
        ? "the snapshot time is unknown, so the drill cannot tell whether they reached production before or after it"
        : undated.length
          ? `neither a deploy nor a commit time is known for ${listTags(undated)}`
          : `${describeLanding(stale)} reached production more than ${DEPLOY_GRACE_MS / 60_000} min before the snapshot, so it should carry ${stale.length === 1 ? "it" : "them"} — the deploy never migrated, or migrated something else` +
            (stale.some((e) => landing(e)?.how === "committed")
              ? "; NOTE those dates are commit times (ECR history unavailable), which run earlier than the deploy — confirm against `aws ecr describe-images --repository-name aivota` before acting"
              : "");
    return {
      ok: false,
      detail:
        `${known.tag} is ${missing.length} migration(s) behind origin/main head ${mainHead.tag} (${applied}/${main.entries.length} applied; missing ${listTags(missing)}) — ${why}; ` +
        `check the deploy that carried ${missing.length === 1 ? "it" : "them"} before trusting the schema`,
      notes,
    };
  }

  if (treeAhead.length) {
    notes.push(
      `The working tree is ${treeAhead.length} migration(s) ahead of production (${listTags(treeAhead)}) — unreleased on this branch, not a backup defect.`,
    );
  }
  return {
    ok: true,
    detail: `${known.tag} == origin/main head (${applied}/${main.entries.length} applied)${treeAhead.length ? `; working tree +${treeAhead.length} unreleased` : ""}`,
    notes,
  };
}

// ---------------------------------------------------------------------------
// Loaders
// ---------------------------------------------------------------------------
interface RawJournal {
  entries: { idx: number; tag: string; when: number }[];
}

function sha256(s: string | Buffer): string {
  return createHash("sha256").update(s).digest("hex");
}

/** This checkout: drizzle/meta/_journal.json + the .sql files on disk. */
export function loadWorkingTreeJournal(root: string): Journal {
  const journal = JSON.parse(fs.readFileSync(path.join(root, "drizzle", "meta", "_journal.json"), "utf8")) as RawJournal;
  const entries = [...journal.entries]
    .sort((a, b) => a.idx - b.idx)
    .map((e) => ({ idx: e.idx, tag: e.tag, hash: sha256(fs.readFileSync(path.join(root, "drizzle", `${e.tag}.sql`))) }));
  return { source: "working tree", entries };
}

function git(root: string, args: string[], input?: string): string {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    input,
    stdio: ["pipe", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
}

export interface MainJournalResult {
  journal: Journal | null;
  /** What happened, for the transcript. */
  notes: string[];
}

/**
 * origin/main's journal, read straight from git objects so the hashes are of the
 * blobs the Linux deploy container reads (no working-tree line-ending risk).
 * Best-effort fetch first; on any failure returns null with the reason.
 */
export function loadMainJournal(root: string, ref = "origin/main", deploys: DeployRecord[] | null = null): MainJournalResult {
  const notes: string[] = [];
  try {
    git(root, ["fetch", "-q", "origin", "main"]);
  } catch (err) {
    notes.push(`git fetch origin main failed (${firstLine(err)}); using the last fetched ${ref}`);
  }
  try {
    const journal = JSON.parse(git(root, ["show", `${ref}:drizzle/meta/_journal.json`])) as RawJournal;
    const sorted = [...journal.entries].sort((a, b) => a.idx - b.idx);

    // One process: blob ids from ls-tree, contents from cat-file --batch.
    const tree = git(root, ["ls-tree", "-r", "-z", ref, "--", "drizzle"]);
    const blobByPath = new Map<string, string>();
    for (const rec of tree.split("\0")) {
      if (!rec) continue;
      const m = /^\d+ blob ([0-9a-f]+)\t(.+)$/.exec(rec);
      if (m) blobByPath.set(m[2], m[1]);
    }
    const shas = sorted.map((e) => {
      const sha = blobByPath.get(`drizzle/${e.tag}.sql`);
      if (!sha) throw new Error(`${ref} journal lists ${e.tag} but drizzle/${e.tag}.sql is not in the tree`);
      return sha;
    });
    const batch = execFileSync("git", ["cat-file", "--batch"], {
      cwd: root,
      input: shas.join("\n") + "\n",
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
    });
    const contents = parseCatFileBatch(batch);
    // Landing time per migration, one call: newest-first log, so the first
    // commit that names a path is the one that last touched it.
    const landed = parseNameOnlyLog(git(root, ["log", "--format=%ct", "--name-only", ref, "--", "drizzle/*.sql"]));
    let entries: JournalEntry[] = sorted.map((e, i) => {
      const body = contents.get(shas[i]);
      if (!body) throw new Error(`git cat-file returned no body for ${e.tag}`);
      const committedAt = landed.get(`drizzle/${e.tag}.sql`);
      return { idx: e.idx, tag: e.tag, hash: sha256(body), ...(committedAt ? { committedAt } : {}) };
    });
    if (deploys && deploys.length) {
      try {
        entries = assignDeployDates(entries, deploys, deployContains(root, entries, deploys));
        notes.push(`${entries.filter((e) => e.deployedAt).length}/${entries.length} migrations dated by ECR deploy history (${deploys.length} images)`);
      } catch (err) {
        notes.push(`could not map migrations to deploys (${firstLine(err)}); falling back to commit times`);
      }
    } else {
      notes.push("no ECR deploy history; migrations dated by commit time only (earlier than the deploy — errs toward failing)");
    }
    return { journal: { source: ref, entries }, notes };
  } catch (err) {
    notes.push(`could not read ${ref} migrations from git (${firstLine(err)})`);
    return { journal: null, notes };
  }
}

/**
 * `deployedAt` for every entry some deploy contains: the push time of the
 * EARLIEST image whose commit has the file. `contains(sha, tag)` answers
 * "does the tree at this commit include drizzle/<tag>.sql". Pure.
 */
export function assignDeployDates(
  entries: JournalEntry[],
  deploys: DeployRecord[],
  contains: (sha: string, tag: string) => boolean,
): JournalEntry[] {
  const ordered = [...deploys].sort((a, b) => a.pushedAt.getTime() - b.pushedAt.getTime());
  return entries.map((e) => {
    const first = ordered.find((d) => contains(d.sha, e.tag));
    return first ? { ...e, deployedAt: first.pushedAt } : e;
  });
}

/**
 * One `git cat-file --batch-check` over every `<sha>:drizzle/<tag>.sql` name.
 * A deploy commit that is not in the local object store (never fetched, or
 * force-pushed away) simply contains nothing.
 */
function deployContains(root: string, entries: JournalEntry[], deploys: DeployRecord[]): (sha: string, tag: string) => boolean {
  const names: string[] = [];
  for (const d of deploys) for (const e of entries) names.push(`${d.sha}:drizzle/${e.tag}.sql`);
  const out = git(root, ["cat-file", "--batch-check=%(objectname) %(objecttype) %(rest)"], names.map((n) => `${n} ${n}`).join("\n") + "\n");
  // Each input line is "<name> <name>"; %(rest) echoes the second copy so a hit
  // can be matched back to its name. Misses print "<name> missing".
  const present = new Set<string>();
  for (const line of out.split(/\r?\n/)) {
    const m = /^[0-9a-f]{40} blob (\S+)$/.exec(line.trim());
    if (m) present.add(m[1]);
  }
  return (sha, tag) => present.has(`${sha}:drizzle/${tag}.sql`);
}

/** `git cat-file --batch` output: `<sha> <type> <size>\n<size bytes>\n` per object. */
export function parseCatFileBatch(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  let pos = 0;
  while (pos < buf.length) {
    const nl = buf.indexOf(0x0a, pos);
    if (nl < 0) break;
    const header = buf.subarray(pos, nl).toString("utf8");
    const m = /^([0-9a-f]+) (\w+) (\d+)$/.exec(header);
    if (!m) throw new Error(`unexpected cat-file header: ${header}`);
    const size = Number(m[3]);
    const start = nl + 1;
    out.set(m[1], buf.subarray(start, start + size));
    pos = start + size + 1; // trailing newline
  }
  return out;
}

/**
 * `git log --format=%ct --name-only` output: a unix timestamp line, then the
 * paths that commit touched, blank-line separated. Newest first, so the first
 * timestamp seen for a path wins.
 */
export function parseNameOnlyLog(text: string): Map<string, Date> {
  const out = new Map<string, Date>();
  let current: Date | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (/^\d{9,}$/.test(line)) {
      current = new Date(Number(line) * 1000);
      continue;
    }
    if (current && !out.has(line)) out.set(line, current);
  }
  return out;
}

function firstLine(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.split("\n")[0].trim();
}
