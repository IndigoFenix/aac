# Disaster Recovery — backups, restore, drills

Scope: the production AiVota stack in **`il-central-1`** (`aivota-prod-*`).
Staging runs on Render and is **out of scope** (see [What is NOT backed up](#what-is-not-backed-up)).

This document is the §17 contingency-plan evidence: what exists, how to restore it,
how fast that actually is, and where the dated drill records live.

---

## 1. Residency constraint — why DR is in-region only

`il-central-1` (Tel Aviv) is the **only** AWS region in Israel. Every conventional
DR reflex that reaches for a second region — `aws rds copy-db-snapshot` to
`eu-central-1`, S3 Cross-Region Replication, a warm standby elsewhere — moves PHI
out of Israel and is therefore itself a **cross-border transfer under AKIM §14**,
requiring prior written approval and SCCs *for the backup copy itself*.

**Cross-region snapshot copies are ruled out**, not merely unimplemented. DR here
buys resilience from Multi-AZ, from 35 days of in-region point-in-time recovery
and from a **tested** restore procedure — not from geography. Anyone reading a
generic HIPAA checklist and reaching for "copy snapshots to a second region"
should read this paragraph first, then §14 of the assessment.

The residual risk this leaves is explicit: a total loss of the `il-central-1`
region loses the service until AWS restores the region. That is a documented
accepted risk, not an oversight. If the business decides it is unacceptable, the
fix is a legal one (approval + SCCs for an out-of-country backup copy), not a
Terraform one.

---

## 2. What IS backed up

| Asset | Mechanism | Retention | Where |
|---|---|---|---|
| **PostgreSQL** `aivota-prod-postgres` | RDS automated backups + continuous WAL (PITR) | **35 days** in prod (7 elsewhere) | `terraform/rds.tf:109` |
| | Backup window 03:00–04:00 UTC; maintenance Mon 04:00–05:00 UTC | | `terraform/rds.tf:110-111` |
| | Multi-AZ synchronous standby (prod only) — an AZ failure is a failover, not a restore | n/a | `terraform/rds.tf:114` |
| | Storage + snapshots encrypted with the account CMK | n/a | `terraform/rds.tf:91-92` |
| | Deletion protection on; a destroy would leave `aivota-prod-final-snapshot` | n/a | `terraform/rds.tf:127-129` |
| **PHI uploads** `aivota-prod-uploads-<acct>` | S3 versioning (every overwrite/delete keeps the prior version) | noncurrent versions expire after **30 days** | `terraform/storage.tf:18-23`, `:111-139` |
| **Secrets** `aivota-prod/database`, `aivota-prod/app-secrets` | Secrets Manager soft-delete | **30-day** recovery window in prod | `terraform/secrets.tf:133`, `:150` |
| **TURN / Redis auth secrets** | same | 30 days in prod | `terraform/coturn.tf:53`, `terraform/redis.tf:68` |
| **Redis** (only under the `hipaa` profile, `enable_redis`) | ElastiCache daily snapshots, window 03:00–05:00 | `redis_snapshot_retention_days`, default **7** | `terraform/redis.tf:119-120`, `terraform/variables.tf:269-273` |
| **Audit / access logs** | CloudWatch log groups (CMK, `audit_log_retention_days`) + the logs bucket lifecycle | see `INFRASTRUCTURE.md` §Log Retention | `terraform/rds.tf:173-190`, `terraform/storage.tf:285` |
| **Infrastructure definition** | Terraform state in S3 (versioned) + this git repo | indefinite | `INFRASTRUCTURE.md` §Terraform State |
| **Application image** | ECR, sha-pinned per deploy | ECR lifecycle | `.github/workflows/deploy.yml` |

There is **no `aws_backup_plan`**. RDS automated backups + PITR are the whole
database backup story, and they are sufficient for the retention we claim; a
Backup vault would add an immutable copy and a separate access boundary, which is
a hardening item, not a gap in coverage.

`copy_tags_to_snapshot` is **not** set on the instance (it is on the Track G
hardening list), so automated snapshots do not carry the instance's `DataClass`
tag. The drill script tags the *restored* instance itself, so drill teardown is
still tag-guarded.

## What is NOT backed up

- **AAC device session recordings.** Clips live on the device's local disk and are
  pruned by age (default 30 days, 1–365 per student — `shared/aac/session-recording.ts`).
  Nothing uploads them; a lost or wiped device loses them, by design.
- **Staging.** Staging runs on Render, not AWS, and holds no production PHI. It is
  rebuilt, not restored.
- **Client-side model caches, generated glyph rasters, build artifacts.** All
  regenerable.
- **Anything held by cross-border sub-processors** (Gemini Live, Anthropic,
  TTS providers). Their retention is a §8.5 open item, not a backup we control.

---

## 3. RTO / RPO

> **Status: target, until a drill file exists.** Until `docs/dr/drills/` contains a
> dated record, the numbers below are design targets and must be described that
> way to AKIM. The drill script measures the restore component empirically and
> writes it into an evidence file; transcribe the measured figure into this table
> after each drill.

| Scenario | RPO (data loss) | RTO (time to serve) | Basis | Measured? |
|---|---|---|---|---|
| **AZ failure** (Multi-AZ failover) | 0 (synchronous standby) | ~1–2 min, automatic | `terraform/rds.tf:114` | not drilled |
| **Logical corruption / bad migration** (PITR) | ≤ 5 min (continuous WAL) | restore duration + cutover | RDS PITR, 35-day window | not drilled |
| **Instance loss** (restore latest snapshot) | ≤ 24 h (snapshot cadence) | restore duration + cutover | daily automated snapshot | **drill measures this** |
| **Object overwrite/delete in uploads** | 0 within 30 days | minutes (version restore) | `terraform/storage.tf:111-139` | not drilled |
| **Secret deleted** | 0 within 30 days | minutes (`restore-secret`) | `terraform/secrets.tf:133`,`:150` | not drilled |
| **Region loss (`il-central-1`)** | — | **unbounded** — accepted risk, see §1 | no out-of-country copy by design | n/a |

**Measured restore duration**

<!-- DRILL-TABLE: append one row per drill; source = docs/dr/drills/<date>-restore-drill.md -->

| Drill date | Snapshot | Restore → available | Observed RPO | Result | Evidence |
|---|---|---|---|---|---|
| _(none yet)_ | — | — | — | — | — |

Full RTO = **restore duration + decision time + cutover**. The cutover (§5) is a
secret edit plus an ECS rolling deploy: budget ~5 min for the secret and ~3–5 min
for the service to reach steady state on top of the measured restore.

---

## 4. The drill

```bash
npm run dr:drill                 # --plan: prints every AWS call, touches nothing
npm run dr:drill -- --execute    # the real thing
npm run dr:drill -- --teardown-only aivota-dr-drill-<stamp>
npm run dr:drill -- --help
```

`scripts/dr-restore-drill.ts` restores the newest automated snapshot of
`aivota-prod-postgres` into a throwaway `aivota-dr-drill-<yyyymmddhhmm>` instance
**in `il-central-1`**, on the same subnet group, security group and parameter
group as production (so `rds.force_ssl = 1` applies to the copy too), `db.t3.micro`,
single-AZ, private, deletion protection off, tagged `Purpose=dr-drill`. It then
port-forwards to the copy through the `aivota-prod-bastion` SSM session on local
port **15433** (never 5432 — `npm run db-tunnel` owns that, and a collision would
point the checks at production), connects with the master credentials from
`aivota-prod/database`, and asserts:

- the drizzle migration head equals the newest `drizzle/*.sql` in the repo;
- `students`, `users`, `chat_sessions`, `activity_logs`, `medical_records` all
  have rows;
- the newest `activity_logs.created_at` sits inside the snapshot window — the gap
  between that row and the snapshot time is the **observed RPO**.

Then it deletes the instance (`--skip-final-snapshot --delete-automated-backups`)
unless `--keep`, and writes `docs/dr/drills/<yyyy-mm-dd>-restore-drill.md` with
the snapshot id and time, the restore start/available/teardown timestamps, the
measured restore duration, the observed RPO, every check's pass/fail, the
operator and the exact command line. A verbose transcript goes to
`logs/dr-drill-<stamp>.log` (gitignored — it can echo AWS identifiers).

**Guards.** It refuses to create or delete any identifier that does not start with
`aivota-dr-drill-`, and refuses to delete anything not tagged `Purpose=dr-drill`.
Those two rails are what make it safe to run against the production account.

**Cost.** A `db.t3.micro` restore of the prod volume for under an hour is cents;
the storage of the restored volume dominates. `--keep` leaves it billing — don't.

**Schedule: quarterly**, plus after any change to the schema-migration runner, the
RDS instance class/engine version, or the secret layout. Evidence lives in
`docs/dr/drills/` and is committed. After each drill, add a row to the measured
table in §3 and update the "Status: target" note once the first drill lands.

---

## 5. Manual restore procedure (database)

Use this when the drill script is not appropriate — i.e. a real incident.
Everything below stays in `il-central-1`.

### 5.1 Decide the restore point

```bash
export AWS_PROFILE=aac
# Automated snapshots (daily; ids look like rds:aivota-prod-postgres-YYYY-MM-DD-HH-MM)
aws rds describe-db-snapshots --region il-central-1 \
  --db-instance-identifier aivota-prod-postgres --snapshot-type automated \
  --query 'reverse(sort_by(DBSnapshots,&SnapshotCreateTime))[:5].[DBSnapshotIdentifier,SnapshotCreateTime,Status]' \
  --output table

# For PITR, the earliest/latest restorable time:
aws rds describe-db-instances --region il-central-1 \
  --db-instance-identifier aivota-prod-postgres \
  --query 'DBInstances[0].[LatestRestorableTime,InstanceCreateTime]' --output table
```

Snapshot restore loses up to a day. **PITR is the default choice for logical
corruption** — pick the last known-good minute.

### 5.2 Restore to a NEW instance (never in place)

RDS cannot restore over a running instance, and you want the original intact
until the copy is verified.

```bash
# (a) point in time — preferred
aws rds restore-db-instance-to-point-in-time --region il-central-1 \
  --source-db-instance-identifier aivota-prod-postgres \
  --target-db-instance-identifier aivota-prod-postgres-restore-$(date +%Y%m%d%H%M) \
  --restore-time 2026-08-30T09:15:00Z \
  --db-instance-class db.t3.micro \
  --db-subnet-group-name aivota-prod-db-subnet-group \
  --vpc-security-group-ids <sg-of-aivota-prod-postgres> \
  --db-parameter-group-name aivota-prod-pg-params \
  --no-publicly-accessible --no-multi-az \
  --tags Key=DataClass,Value=PHI Key=Purpose,Value=restore

# (b) from a snapshot
aws rds restore-db-instance-from-db-snapshot --region il-central-1 \
  --db-instance-identifier aivota-prod-postgres-restore-$(date +%Y%m%d%H%M) \
  --db-snapshot-identifier "rds:aivota-prod-postgres-2026-08-30-03-05" \
  --db-instance-class db.t3.micro \
  --db-subnet-group-name aivota-prod-db-subnet-group \
  --vpc-security-group-ids <sg-of-aivota-prod-postgres> \
  --db-parameter-group-name aivota-prod-pg-params \
  --no-publicly-accessible --no-multi-az \
  --tags Key=DataClass,Value=PHI Key=Purpose,Value=restore
```

Discover the subnet group and SG from the source rather than typing them:

```bash
aws rds describe-db-instances --region il-central-1 \
  --db-instance-identifier aivota-prod-postgres \
  --query 'DBInstances[0].[DBSubnetGroup.DBSubnetGroupName,VpcSecurityGroups[].VpcSecurityGroupId,DBParameterGroups[0].DBParameterGroupName]'
```

Console equivalent: RDS → Databases → `aivota-prod-postgres` → **Actions →
Restore to point in time** (or Snapshots → *snapshot* → **Restore**). Set the same
VPC/subnet group/security group, uncheck public access, set Multi-AZ off for a
verification copy (**on**, and a production instance class, if this restore is
going to *become* production).

The restored instance keeps the **master credentials of the source at that time**
and the CMK encryption. It does **not** keep the source's tags unless
`copy_tags_to_snapshot` is set — tag it at restore time as above.

### 5.3 Verify before cutting over

```bash
# tunnel to the RESTORED endpoint on a non-default local port
aws ssm start-session --region il-central-1 --target <bastion-instance-id> \
  --document-name AWS-StartPortForwardingSessionToRemoteHost \
  --parameters "host=<restored-endpoint>,portNumber=5432,localPortNumber=15433"
```

Then run the same assertions the drill runs: migration head vs
`drizzle/meta/_journal.json`, non-zero counts on `students` / `users` /
`chat_sessions` / `activity_logs` / `medical_records`, and `max(created_at)` on
`activity_logs` against the restore point. **Do not skip this**: an unverified
restore that gets cut over is a second outage.

### 5.4 Cut over

The application resolves `DATABASE_URL` from Secrets Manager, not from Terraform:
the ECS task takes `DATABASE_URL` from the **`aivota-prod/database`** secret
(`terraform/ecs.tf:215-216`) and loads the whole `aivota-prod/app-secrets` JSON at
boot (`terraform/ecs.tf:135-147`, `server/config/aws-secrets.ts`). So a cutover is
a secret edit plus a redeploy — **no `terraform apply` and no image rebuild**.

```bash
# 1. keep the old value where you can find it
aws secretsmanager get-secret-value --region il-central-1 \
  --secret-id aivota-prod/database --query SecretString --output text > /tmp/db-secret.before.json

# 2. write the restored host into DATABASE_URL (and DB_HOST) — edit the JSON, keep every other key
#    console: Secrets Manager → aivota-prod/database → Retrieve/Edit secret value
aws secretsmanager put-secret-value --region il-central-1 \
  --secret-id aivota-prod/database --secret-string file:///tmp/db-secret.after.json

# 3. roll the service so tasks pick up the new secret value
aws ecs update-service --region il-central-1 \
  --cluster aivota-prod-cluster --service aivota-prod-service --force-new-deployment

# 4. watch it land
aws ecs describe-services --region il-central-1 \
  --cluster aivota-prod-cluster --services aivota-prod-service \
  --query 'services[0].deployments[].[status,desiredCount,runningCount,rolloutState]' --output table
curl -sS https://api.aivota.ai/health
```

ECS reads the secret at task start, so running tasks keep the old endpoint until
they are replaced — the `--force-new-deployment` is what performs the switch. The
task health check allows a 120 s start period for migrations
(`terraform/ecs.tf:235`), so the new task may take ~2–3 min to report healthy.

If the restored instance is meant to be permanent, afterwards: rename or retire
the old instance, set Multi-AZ and the production instance class on the new one,
confirm `backup_retention_period = 35`, and reconcile Terraform (the instance
identifier is `${local.name_prefix}-postgres`, so a permanent rename means either
renaming back or a `terraform import` — plan it, don't discover it).

### 5.5 Rollback

Because step 5.4 changes exactly one secret and rolls one service, rollback is the
same two commands in reverse:

```bash
aws secretsmanager put-secret-value --region il-central-1 \
  --secret-id aivota-prod/database --secret-string file:///tmp/db-secret.before.json
aws ecs update-service --region il-central-1 \
  --cluster aivota-prod-cluster --service aivota-prod-service --force-new-deployment
```

Caveat: any writes that landed on the restored database after cutover do **not**
exist on the original. Rolling back is only safe while the restored copy is still
being verified, or after an explicit decision to discard the writes since cutover.
Never roll back silently — record the decision in the incident notes.

Do **not** delete the failed-over-from instance until the new one has completed a
successful automated backup and a drill-style verification.

---

## 6. S3 object-version restore (PHI uploads)

Versioning is on for `aivota-prod-uploads-<account-id>`
(`terraform/storage.tf:18-23`); noncurrent versions live **30 days**
(`terraform/storage.tf:111-139`). Past that window there is no recovery — this is
also the disposal caveat noted in the assessment §17.

```bash
BUCKET=aivota-prod-uploads-<account-id>
KEY=students/<id>/<object>

# what versions exist (newest first), including delete markers
aws s3api list-object-versions --region il-central-1 --bucket "$BUCKET" --prefix "$KEY" \
  --query '{versions:Versions[].[VersionId,LastModified,IsLatest,Size],markers:DeleteMarkers[].[VersionId,LastModified,IsLatest]}'

# case A: object was DELETED — remove the delete marker (the old version becomes current)
aws s3api delete-object --region il-central-1 --bucket "$BUCKET" --key "$KEY" --version-id <delete-marker-version-id>

# case B: object was OVERWRITTEN — copy the good version back over the current one
aws s3api copy-object --region il-central-1 --bucket "$BUCKET" \
  --copy-source "$BUCKET/$KEY?versionId=<good-version-id>" --key "$KEY"

# pull a version to disk without touching the bucket
aws s3api get-object --region il-central-1 --bucket "$BUCKET" --key "$KEY" \
  --version-id <good-version-id> ./recovered.bin
```

Bulk restore of a prefix: list versions, filter to the newest non-delete-marker
per key, and `copy-object` each. Objects are CMK-encrypted; the caller needs
`kms:Decrypt` and `kms:GenerateDataKey` on the account CMK as well as S3 rights.

**Erasure interaction:** restoring an object version can resurrect data a student
erasure was supposed to remove. Before restoring anything under a student prefix,
check that student has no completed erasure (`student_erasure_completed` audit
event). A restore that undoes an erasure is a privacy incident.

## 7. Secrets restore

Deleted secrets sit in a 30-day soft-delete window in prod:

```bash
aws secretsmanager list-secrets --region il-central-1 --include-planned-deletion \
  --query 'SecretList[?DeletedDate].[Name,DeletedDate]' --output table
aws secretsmanager restore-secret --region il-central-1 --secret-id aivota-prod/app-secrets
```

Prior *values* are separate from deletion: `list-secret-version-ids` +
`get-secret-value --version-id <id>` recovers a clobbered value. Terraform-managed
generated values (RDS master password, Redis auth, TURN secret) also exist in the
Terraform state, which is versioned in S3 — treat that state as credential
material, because it is.

## 8. Redis / realtime bus

Only present under the `hipaa` profile. Payloads on the bus are ID-only
(`server/services/personChat/personChatFanout.ts`), so a lost node is a
reconnection event, not data loss. If Redis is unavailable, the supported
degradation is `REALTIME_BUS=postgres` (`terraform/ecs.tf:177-178`) — LISTEN/NOTIFY
fanout. Snapshots exist (`terraform/redis.tf:119`) but restoring one is rarely the
right move; recreating the replication group is faster.

## 9. Contacts and escalation

| Role | Name | Contact | Notes |
|---|---|---|---|
| Incident commander | _TBD_ | _TBD_ | Declares the disaster, owns the cutover decision |
| AWS account owner / break-glass | _TBD_ | _TBD_ | Root MFA holder |
| Information-security trustee (AKIM §5.2) | _TBD_ | _TBD_ | Named officer — open item |
| AKIM contact for §10 notification | _TBD_ | _TBD_ | Notification windows in `SECURITY_ARCHITECTURE.md` §9 |
| AWS Support | — | console → Support | Region-level events |

Alerts route to the SNS alerts topic (`INFRASTRUCTURE.md` §Alert delivery); the
`alert_email` variable is still an open item.

## 10. Related documents

- [`INFRASTRUCTURE.md`](INFRASTRUCTURE.md) — AWS architecture, profiles, secrets, deploy.
- [`SECURITY_ARCHITECTURE.md`](SECURITY_ARCHITECTURE.md) §8 — backup/DR/retention posture.
- [`AKIM_COMPLIANCE_ASSESSMENT.md`](AKIM_COMPLIANCE_ASSESSMENT.md) §14, §17.
- [`dr/README.md`](dr/README.md) — the evidence folder.
