# DR restore drill — 2026-08-31

**Result: FAIL** (6 passed, 1 failed)

Region `il-central-1` throughout — no snapshot left Israel. Cross-region copies are
ruled out by AKIM §14; see [../../DISASTER_RECOVERY.md](../../DISASTER_RECOVERY.md).

| Field | Value |
|---|---|
| Source instance | `aivota-prod-postgres` |
| Snapshot | `rds:aivota-prod-postgres-2026-08-31-03-05` |
| Snapshot created | 2026-08-31T03:05:06.351Z |
| Drill instance | `aivota-dr-drill-202608310701` (db.t3.micro, single-AZ, private, deletion protection off) |
| Restore requested | 2026-08-31T07:01:07.946Z |
| Restore available | 2026-08-31T07:09:12.015Z |
| **Measured restore duration** | **8.0 min** (481s) — the empirical restore component of RTO |
| Smoke checks completed | 2026-08-31T07:09:53.411Z |
| Teardown | 2026-08-31T07:09:59.030Z |
| Observed RPO | newest activity_logs row 2026-08-30T12:16:43.647Z vs snapshot 2026-08-31T03:05:06.351Z → 14.81 h inside the snapshot |
| Operator | Daniel |
| Command | `npx tsx scripts/dr-restore-drill.ts --execute` |
| Transcript | `logs/dr-drill-202608310701.log` (gitignored) |

## Checks

| Check | Result | Detail |
|---|---|---|
| migration head | ❌ FAIL | restored head ca7e22cf20c0… != repo head 0173_many_loners 737f5030edc2… (165/174 applied) — the snapshot predates the deployed schema, or the repo is ahead of production |
| rows: students | ✅ pass | 41 rows |
| rows: users | ✅ pass | 14 rows |
| rows: chat_sessions | ✅ pass | 6,063 rows |
| rows: activity_logs | ✅ pass | 374 rows |
| rows: medical_records | ✅ pass | 10 rows |
| data freshness | ✅ pass | newest activity_logs row 2026-08-30T12:16:43.647Z vs snapshot 2026-08-31T03:05:06.351Z → 14.81 h inside the snapshot |

## RTO / RPO read-out

- **Restore duration (measured):** 8.0 min for the snapshot restore alone.
  Full RTO also includes the decision to fail over, the `aivota-prod/database`
  secret edit and the ECS `force-new-deployment` roll (see the runbook's cutover
  step) — add those to the number above before quoting an RTO.
- **RPO (snapshot path, measured):** newest activity_logs row 2026-08-30T12:16:43.647Z vs snapshot 2026-08-31T03:05:06.351Z → 14.81 h inside the snapshot
- **RPO (PITR path):** RDS continuous backup targets ~5 minutes and is NOT
  exercised by this drill. Restoring to a point in time uses
  `aws rds restore-db-instance-to-point-in-time` — same guards apply.

## Notes

- **Re-assessed 2026-09-01 — the migration-head FAIL was a check defect, not a
  backup defect.** The check compared the restored head against the *working tree*
  (and, once corrected, needed the real deploy clock — commit dates mislead here).
  Restored head `ca7e22cf20c0…` = `0164_enable_symbol_generation`. The nine
  "missing" migrations were committed on `staging` between 2026-08-25 and
  2026-08-31 (`0165`–`0167` Aug 25–26, `0168`–`0170` in `429edbdd` Aug 30,
  `0171`–`0173` in `860351f6` Aug 31 06:07Z), but production only receives a
  migration when `main` is deployed, and ECR shows **no image push between
  2026-08-25T14:40Z (`c672cf16`) and 2026-08-31T06:38Z (`860351f6`)**; the ECS
  deployment that carried all nine was created 2026-08-31T06:38:58Z — **3.5 h
  after** this 03:05Z snapshot. The snapshot therefore carried exactly the schema
  production ran when it was taken. Under the corrected check
  (`scripts/dr-drill-migration-head.ts`, which dates each migration by the ECR
  push that first carried it; unit-tested in
  `server/tests/dr-drill-migration-head.test.ts`) this drill is a **PASS (7/7)**.
  The restore, row-count and freshness results above stand as measured.
