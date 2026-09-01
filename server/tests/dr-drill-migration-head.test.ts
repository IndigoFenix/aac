/**
 * The DR drill's "migration head" check (scripts/dr-drill-migration-head.ts).
 *
 * Pins the lesson of the first two drills: production deploys origin/main, so a
 * working tree that is ahead of the snapshot must NOT fail the check — but a
 * snapshot behind origin/main, or a head the repo has never seen, must.
 */
import {
  assessMigrationHead,
  parseCatFileBatch,
  parseNameOnlyLog,
  assignDeployDates,
  DEPLOY_GRACE_MS,
  type DeployRecord,
  type Journal,
} from "../../scripts/dr-drill-migration-head.js";

const j = (source: string, ...tags: string[]): Journal => ({
  source,
  entries: tags.map((tag, idx) => ({ idx, tag, hash: `hash-of-${tag}` })),
});

const MAIN = j("origin/main", "0000_init", "0001_users", "0002_students", "0003_many_loners");
const TREE_EQUAL = j("working tree", "0000_init", "0001_users", "0002_students", "0003_many_loners");
const TREE_AHEAD = j("working tree", "0000_init", "0001_users", "0002_students", "0003_many_loners", "0004_lush_mach_iv");

/** The 2026-08-31 shape: snapshot 03:05Z; the deploy that carried the newest migrations pushed 06:38Z. */
const SNAP = new Date("2026-08-31T03:05:06Z");
const AFTER_SNAP = new Date("2026-08-31T06:38:41Z");
const LONG_BEFORE_SNAP = new Date(SNAP.getTime() - DEPLOY_GRACE_MS - 60_000);
const JUST_BEFORE_SNAP = new Date(SNAP.getTime() - DEPLOY_GRACE_MS + 60_000);
const dated = (journal: Journal, at: Record<string, Date>, key: "committedAt" | "deployedAt" = "committedAt"): Journal => ({
  ...journal,
  entries: journal.entries.map((e) => (at[e.tag] ? { ...e, [key]: at[e.tag] } : e)),
});

describe("assessMigrationHead", () => {
  it("passes when the restored head is origin/main's head", () => {
    const r = assessMigrationHead({ dbHash: "hash-of-0003_many_loners", applied: 4, main: MAIN, workingTree: TREE_EQUAL, snapshotTime: SNAP });
    expect(r.ok).toBe(true);
    expect(r.detail).toContain("0003_many_loners == origin/main head (4/4 applied)");
    expect(r.notes).toEqual([]);
  });

  it("still passes when the working tree is ahead — that is an unreleased branch, not a backup defect (the 2026-09-01 false negative)", () => {
    const r = assessMigrationHead({ dbHash: "hash-of-0003_many_loners", applied: 4, main: MAIN, workingTree: TREE_AHEAD, snapshotTime: SNAP });
    expect(r.ok).toBe(true);
    expect(r.detail).toContain("working tree +1 unreleased");
    expect(r.notes).toHaveLength(1);
    expect(r.notes[0]).toContain("0004_lush_mach_iv");
    expect(r.notes[0]).toContain("not a backup defect");
  });

  describe("snapshot behind origin/main", () => {
    it("passes when every missing migration landed on main AFTER the snapshot (the 2026-08-31 false negative)", () => {
      const main = dated(MAIN, { "0002_students": AFTER_SNAP, "0003_many_loners": AFTER_SNAP });
      const r = assessMigrationHead({ dbHash: "hash-of-0001_users", applied: 2, main, workingTree: TREE_AHEAD, snapshotTime: SNAP });
      expect(r.ok).toBe(true);
      expect(r.detail).toContain("0001_users == origin/main head as of the snapshot (2/4 applied); main +2 since");
      expect(r.notes.some((n) => n.includes("gained 2 migration(s) that reached production after the snapshot") && n.includes("0002_students (committed"))).toBe(true);
      // commit-time dating is the fallback and says so
      expect(r.notes.some((n) => n.includes("dated by commit time"))).toBe(true);
    });

    it("prefers the DEPLOY time over the commit time — committed days earlier, deployed after the snapshot, passes (the real 2026-08-31 case)", () => {
      const main = dated(
        dated(MAIN, { "0002_students": LONG_BEFORE_SNAP, "0003_many_loners": LONG_BEFORE_SNAP }),
        { "0002_students": AFTER_SNAP, "0003_many_loners": AFTER_SNAP },
        "deployedAt",
      );
      const r = assessMigrationHead({ dbHash: "hash-of-0001_users", applied: 2, main, workingTree: TREE_AHEAD, snapshotTime: SNAP });
      expect(r.ok).toBe(true);
      expect(r.notes[0]).toContain("0002_students (deployed 2026-08-31T06:38:41.000Z)");
      expect(r.notes.some((n) => n.includes("dated by commit time"))).toBe(false);
    });

    it("fails when the deploy that carried a migration ran well before the snapshot, whatever the commit time says", () => {
      const main = dated(
        dated(MAIN, { "0002_students": AFTER_SNAP, "0003_many_loners": AFTER_SNAP }),
        { "0002_students": LONG_BEFORE_SNAP, "0003_many_loners": AFTER_SNAP },
        "deployedAt",
      );
      const r = assessMigrationHead({ dbHash: "hash-of-0001_users", applied: 2, main, workingTree: TREE_AHEAD, snapshotTime: SNAP });
      expect(r.ok).toBe(false);
      expect(r.detail).toContain("0002_students (deployed");
      expect(r.detail).toContain("deploy never migrated");
      expect(r.detail).not.toContain("commit times");
    });

    it("tolerates a migration that landed inside the deploy grace window before the snapshot", () => {
      const main = dated(MAIN, { "0002_students": JUST_BEFORE_SNAP, "0003_many_loners": AFTER_SNAP });
      const r = assessMigrationHead({ dbHash: "hash-of-0001_users", applied: 2, main, workingTree: TREE_AHEAD, snapshotTime: SNAP });
      expect(r.ok).toBe(true);
    });

    it("fails when a missing migration was on main well before the snapshot — the deploy never migrated", () => {
      const main = dated(MAIN, { "0002_students": LONG_BEFORE_SNAP, "0003_many_loners": AFTER_SNAP });
      const r = assessMigrationHead({ dbHash: "hash-of-0001_users", applied: 2, main, workingTree: TREE_AHEAD, snapshotTime: SNAP });
      expect(r.ok).toBe(false);
      expect(r.detail).toContain("0001_users is 2 migration(s) behind origin/main head 0003_many_loners");
      expect(r.detail).toContain("0002_students (committed");
      expect(r.detail).toContain("reached production more than 60 min before the snapshot");
      expect(r.detail).toContain("deploy never migrated");
      // dated by commit time only → the message says to confirm against ECR before acting
      expect(r.detail).toContain("commit times");
    });

    it("fails when the snapshot time is unknown, because it cannot tell the two apart", () => {
      const main = dated(MAIN, { "0002_students": AFTER_SNAP, "0003_many_loners": AFTER_SNAP });
      const r = assessMigrationHead({ dbHash: "hash-of-0001_users", applied: 2, main, workingTree: TREE_AHEAD, snapshotTime: null });
      expect(r.ok).toBe(false);
      expect(r.detail).toContain("snapshot time is unknown");
    });

    it("fails when git gave no landing time for a missing migration", () => {
      const r = assessMigrationHead({ dbHash: "hash-of-0001_users", applied: 2, main: MAIN, workingTree: TREE_AHEAD, snapshotTime: SNAP });
      expect(r.ok).toBe(false);
      expect(r.detail).toContain("neither a deploy nor a commit time is known for 0002_students, 0003_many_loners");
    });
  });

  it("fails when the restored head is unknown to both journals", () => {
    const r = assessMigrationHead({ dbHash: "deadbeefdeadbeef", applied: 4, main: MAIN, workingTree: TREE_AHEAD, snapshotTime: SNAP });
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("not any migration in origin/main or this checkout");
  });

  it("fails when production carries a migration that is not on origin/main", () => {
    const r = assessMigrationHead({ dbHash: "hash-of-0004_lush_mach_iv", applied: 5, main: MAIN, workingTree: TREE_AHEAD, snapshotTime: SNAP });
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("not on origin/main");
  });

  it("fails on an empty ledger", () => {
    const r = assessMigrationHead({ dbHash: null, applied: 0, main: MAIN, workingTree: TREE_EQUAL, snapshotTime: SNAP });
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("never been migrated");
  });

  it("notes a row count that disagrees with the head's index", () => {
    const r = assessMigrationHead({ dbHash: "hash-of-0003_many_loners", applied: 7, main: MAIN, workingTree: TREE_EQUAL, snapshotTime: SNAP });
    expect(r.ok).toBe(true);
    expect(r.notes.some((n) => n.includes("7 rows") && n.includes("expected 4 rows"))).toBe(true);
  });

  it("falls back to the working tree when origin/main is unavailable, and says so", () => {
    const r = assessMigrationHead({ dbHash: "hash-of-0003_many_loners", applied: 4, main: null, workingTree: TREE_AHEAD, snapshotTime: SNAP });
    expect(r.ok).toBe(true);
    expect(r.detail).toContain("origin/main unavailable");
    expect(r.notes[0]).toContain("cannot tell which without origin/main");
  });
});

describe("parseCatFileBatch", () => {
  it("splits `git cat-file --batch` output into blobs by sha, binary-safe", () => {
    const a = Buffer.from("ALTER TABLE x;\n");
    const b = Buffer.from("-- multi\nline\n\nwith blank\n");
    const buf = Buffer.concat([
      Buffer.from(`aaaa blob ${a.length}\n`), a, Buffer.from("\n"),
      Buffer.from(`bbbb blob ${b.length}\n`), b, Buffer.from("\n"),
    ]);
    const m = parseCatFileBatch(buf);
    expect(m.size).toBe(2);
    expect(m.get("aaaa")?.equals(a)).toBe(true);
    expect(m.get("bbbb")?.equals(b)).toBe(true);
  });
});

describe("parseNameOnlyLog", () => {
  it("assigns each path the NEWEST commit that touched it", () => {
    const text = [
      "1788156456", "", "drizzle/0171_a.sql", "drizzle/0173_c.sql", "",
      "1788104832", "", "drizzle/0168_b.sql", "drizzle/0171_a.sql", "",
    ].join("\n");
    const m = parseNameOnlyLog(text);
    expect(m.get("drizzle/0171_a.sql")?.toISOString()).toBe(new Date(1788156456000).toISOString());
    expect(m.get("drizzle/0173_c.sql")?.toISOString()).toBe(new Date(1788156456000).toISOString());
    expect(m.get("drizzle/0168_b.sql")?.toISOString()).toBe(new Date(1788104832000).toISOString());
    expect(m.size).toBe(3);
  });
});

describe("assignDeployDates", () => {
  const deploys: DeployRecord[] = [
    { sha: "c".repeat(40), pushedAt: new Date("2026-08-31T06:38:41Z") },
    { sha: "a".repeat(40), pushedAt: new Date("2026-08-21T12:47:27Z") },
    { sha: "b".repeat(40), pushedAt: new Date("2026-08-25T14:40:48Z") },
  ];
  // which migrations each deploy's commit contains
  const tree: Record<string, string[]> = {
    ["a".repeat(40)]: ["0000_init", "0001_users"],
    ["b".repeat(40)]: ["0000_init", "0001_users", "0002_students"],
    ["c".repeat(40)]: ["0000_init", "0001_users", "0002_students", "0003_many_loners"],
  };
  const contains = (sha: string, tag: string) => tree[sha]?.includes(tag) ?? false;

  it("dates each migration by the EARLIEST deploy whose commit contains it, regardless of input order", () => {
    const out = assignDeployDates(MAIN.entries, deploys, contains);
    expect(out.map((e) => e.deployedAt?.toISOString())).toEqual([
      "2026-08-21T12:47:27.000Z",
      "2026-08-21T12:47:27.000Z",
      "2026-08-25T14:40:48.000Z",
      "2026-08-31T06:38:41.000Z",
    ]);
  });

  it("leaves a migration undated when no known deploy contains it", () => {
    const out = assignDeployDates(TREE_AHEAD.entries, deploys, contains);
    expect(out[4].tag).toBe("0004_lush_mach_iv");
    expect(out[4].deployedAt).toBeUndefined();
  });
});
