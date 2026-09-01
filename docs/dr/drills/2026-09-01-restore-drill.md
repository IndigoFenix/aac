# DR restore drill — 2026-09-01

**Result: FAIL** (6 passed, 1 failed)

Region `il-central-1` throughout — no snapshot left Israel. Cross-region copies are
ruled out by AKIM §14; see [../../DISASTER_RECOVERY.md](../../DISASTER_RECOVERY.md).

| Field | Value |
|---|---|
| Source instance | `aivota-prod-postgres` |
| Snapshot | `rds:aivota-prod-postgres-2026-09-01-03-05` |
| Snapshot created | 2026-09-01T03:05:12.214Z |
| Drill instance | `aivota-dr-drill-202609011226` (db.t3.micro, single-AZ, private, deletion protection off) |
| Restore requested | 2026-09-01T12:26:15.830Z |
| Restore available | 2026-09-01T12:33:37.942Z |
| **Measured restore duration** | **7.3 min** (438s) — the empirical restore component of RTO |
| Smoke checks completed | 2026-09-01T12:34:22.147Z |
| Teardown | 2026-09-01T12:34:35.106Z |
| Observed RPO | newest activity_logs row 2026-08-31T17:36:49.560Z vs snapshot 2026-09-01T03:05:12.214Z → 9.47 h inside the snapshot |
| Operator | Daniel |
| Command | `npx tsx scripts/dr-restore-drill.ts --execute` |
| Transcript | `logs/dr-drill-202609011226.log` (gitignored) |

## Checks

| Check | Result | Detail |
|---|---|---|
| migration head | ❌ FAIL | restored head 737f5030edc2… != repo head 0174_lush_mach_iv 72d522d49c3e… (174/175 applied) — the snapshot predates the deployed schema, or the repo is ahead of production |
| rows: students | ✅ pass | 41 rows |
| rows: users | ✅ pass | 14 rows |
| rows: chat_sessions | ✅ pass | 6,073 rows |
| rows: activity_logs | ✅ pass | 890 rows |
| rows: medical_records | ✅ pass | 10 rows |
| data freshness | ✅ pass | newest activity_logs row 2026-08-31T17:36:49.560Z vs snapshot 2026-09-01T03:05:12.214Z → 9.47 h inside the snapshot |

## RTO / RPO read-out

- **Restore duration (measured):** 7.3 min for the snapshot restore alone.
  Full RTO also includes the decision to fail over, the `aivota-prod/database`
  secret edit and the ECS `force-new-deployment` roll (see the runbook's cutover
  step) — add those to the number above before quoting an RTO.
- **RPO (snapshot path, measured):** newest activity_logs row 2026-08-31T17:36:49.560Z vs snapshot 2026-09-01T03:05:12.214Z → 9.47 h inside the snapshot
- **RPO (PITR path):** RDS continuous backup targets ~5 minutes and is NOT
  exercised by this drill. Restoring to a point in time uses
  `aws rds restore-db-instance-to-point-in-time` — same guards apply.

## Notes

- **Re-assessed 2026-09-01 — the migration-head FAIL was a check defect, not a
  backup defect.** Restored head `737f5030edc2…` is `0173_many_loners`, which IS
  `origin/main`'s head (174/174 applied — production fully migrated). The "missing"
  `0174_lush_mach_iv` exists only as an untracked file in the `staging` working
  tree (created 09:07Z today, after the snapshot; never committed or deployed).
  The check compared against the working tree instead of `origin/main`; corrected
  in `scripts/dr-drill-migration-head.ts` (replaying this drill's reading through
  it yields PASS with the note "working tree is 1 migration(s) ahead of production
  (0174_lush_mach_iv) — unreleased on this branch, not a backup defect"). Under the
  corrected check this drill is a **PASS (7/7)**; the measured restore, row-count
  and freshness figures above stand.
