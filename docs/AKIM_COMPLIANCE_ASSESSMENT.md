# AKIM Israel — Information Security Appendix Compliance Assessment

**Source contract:** `docs/AKIM_COMPLIANCE.pdf` — אקים ישראל "נספח אבטחת מידע – להסכם מיקור חוץ לספקים חיצוניים"
(Information Security Appendix for an Outsourcing Agreement with External Suppliers), 19 sections.

**Our role in the contract:** "הספק" (the Supplier).

| Field | Value |
|---|---|
| Assessment date | 2026-06-14; revised 2026-08-26 after the HIPAA remediation pass |
| Assessed against | **AWS `il-central-1` deployment path** (Terraform), which since 2026-08-20 is **ECS Fargate** (`deploy.yml`). The `staging` environment runs on Render and is explicitly out of scope. |
| Source of truth | `docs/SECURITY_ARCHITECTURE.md`, `docs/INFRASTRUCTURE.md`, `terraform/`, and the application source verified at assessment time. |
| Reviewer | Aivota Engineering |
| Status legend | ✅ Compliant · 🟡 Partial / needs config · 🔶 Action required · 📋 Organizational/legal (non-engineering) |

> **Scope note.** This document assesses the **technical and architectural** posture of the AWS deployment path. Several AKIM clauses are contractual/organizational commitments (sign confidentiality undertakings, accept audit rights, name a security officer, the §19 legal declaration). Those are flagged 📋 and are owned by business/legal, not engineering.

---

## Executive summary

The AWS `il-central-1` build is **designed to meet AKIM's technical bar** — encryption at rest and in transit, KMS key management, network isolation, audit logging, breach-notification tooling, and a right-to-erasure pipeline are all present. The application-layer controls (helmet, CSRF, WebSocket-upgrade Origin check, CORS allowlist, rate limiting, AES-256-GCM field encryption, production-off debug sinks) are verified as wired in current code.

**Revision note (2026-08-26).** An internal HIPAA audit found that several controls
this document had recorded as ✅ were, in the deployed system, either inert or
absent. They were remediated and the affected rows below now say what the code
and Terraform actually do: production maintenance crons (erasure sweep, audit
prune) did not run at all; the alerting pipeline had no subscriber and its CMK
blocked publication; the failed-login alarm watched a metric nothing emitted;
there was no idle logoff; removal from an institute left live sessions working;
owned PHI reads and system-admin reads were unlogged; WebSocket upgrades had no
Origin check; and WAF, RDS-exported PostgreSQL logs and the RDS error-statement
setting were unmanaged. Items that were **not** fixed are stated as open rather
than removed.

**The items that still require action before an AKIM engagement:**

1. **🔶 §14 — Cross-border sub-processors.** Even hosted in Israel, the AAC streams live student audio/video to **Google Gemini Live** (EU/US), and the **Monitor agent — Anthropic Claude by default (`claude-haiku`)** — receives **transcripts of those conversations** (PHI) to manage session memory (US). Both are core-path PHI processing outside Israel and require AKIM **prior written approval + SCCs / Transfer Impact Assessment**, plus disclosure under §5.3. (OpenAI is **not** in this path — see the sub-processor table.)
2. **✅ §5.8 / §17 / §18 — Maintenance crons now run in production (2026-08-26).** The audit-retention prune, the erasure hard-delete sweep and the consent-threshold checks are scheduled from `server/services/maintenanceCrons.ts`, which both entrypoints (`server/index.ts` and the ECS `server/app.prod.ts`) call, under a cluster-wide Postgres advisory lock so only one task runs them. Previously the ECS entrypoint scheduled none of them and the EventBridge fallback was gated on `use_lambda`, so **no sweep ran in production at all**.
3. **🔶 §6 / §7 — External penetration test pending.** Internal pre-flight done; the external (Experis) test and its certificate are not yet complete.
4. **🔶 §14 (again) — no BAA/DPA template exists in the repo,** and the `us_hipaa` regime is a label: it changes two numbers in `shared/regime/regimes.ts` and no service branches on it. Flow-down agreements with the cross-border processors are still unexecuted.
5. **🟡 §10 — breach notification has no dispatcher.** `incidentTemplateService.fillIncidentTemplate` has no production caller; it is a string formatter. Meeting the notification windows is a manual step today, and there is no breach register.
6. **🟡 §17 / DR — runbook and drill script exist; no dated drill has been RUN.** `docs/DISASTER_RECOVERY.md` is the restore runbook (RDS PITR/snapshot restore, the S3 object-version procedure, the app cutover and its rollback) and `scripts/dr-restore-drill.ts` (`npm run dr:drill`) performs an **in-region** restore drill — latest automated snapshot → throwaway `aivota-dr-drill-*` instance → migration-head and row-count smoke checks → teardown → dated evidence in `docs/dr/drills/`. Until that folder holds a file, the RTO/RPO figures remain a design target, not a tested capability. There is still no `aws_backup_plan`. **Cross-region snapshot copies are ruled out, not missing:** `il-central-1` is the only Israeli region, so a copy anywhere else is itself a §14 cross-border transfer of PHI. Region loss is an accepted, documented risk.
7. **📋 §2.4 / §5.2 / §5.3 / §8 / §9 / §16 / §19 — Organizational/legal deliverables** (named security officer, sub-processor disclosure, staff confidentiality undertakings, audit-rights acceptance, indemnification, legal declaration). Tooling supports these; the contractual execution is outstanding.

---

## Sub-processor & data-flow disclosure (for AKIM §5.3 / §14)

Canonical list: `shared/legal/recipients.ts`. Data classification reflects **actual operational use**.

| Vendor | Purpose | Data exposed | Region | AKIM-relevant? |
|---|---|---|---|---|
| **Amazon Web Services** | Hosting + encrypted-at-rest storage | All PHI/PII (encrypted) | `il-central-1` (Israel) | In-country ✅ |
| **Google Gemini Live** | Realtime AAC interaction (primary live provider) | **Live mic audio + camera video** (student + bystander faces), conversation | Google-managed (EU/US) | 🔶 Cross-border — needs §14 approval |
| **Anthropic Claude** | **Monitor/moderator agent (`aac_moderator`, default `claude-haiku`)** — supervises the live session & manages memory; also clinician chat where configured | **Transcripts of the AAC conversation** recorded by Gemini, plus memory/prompt context — **PHI** | US | 🔶 Cross-border (core path) — needs §14 approval |
| **OpenAI** | **Icon/symbol image generation from short text tags only** | Short symbol tags — **no conversation, no PHI** | US | Low — non-PHI; disclose for completeness |
| **Google Cloud TTS / ElevenLabs** | Speech synthesis for AAC voice output | Text to be spoken | US | 🔶 Cross-border — needs §14 approval |
| **Google OAuth** (when used) | Federated sign-in | Auth identity | US | Disclose |
| **External IdPs** (e.g. IL MoE Sapakim) | SSO (SAML/OIDC) | Auth identity | Per IdP | Disclose |
| **Email/SMS delivery** (AWS SES for email, AWS SNS for SMS) | Transactional mail, OTP | Recipient contact + message | Varies | Disclose |
| **Pixabay** (picture search) | Stock-image search for the AAC picture app | Short English search word only; results fetched server-side and re-served from Aivota | US | Low — non-PHI; disclose |
| **Dropbox** (per-user opt-in) | User-initiated file backup | Files the user backs up | US | 🔶 Disclose — **and note it is absent from `recipients.ts`**, so no consent snapshot names it |

> **Note on the LLM roles (per operational clarification 2026-06-14):**
> - **Gemini Live** is the realtime provider — it receives live mic audio + camera video.
> - **Anthropic Claude** is the **Monitor agent** (`aac_moderator`, default `claude-haiku` in `monitor-agent.ts`). It is fed **transcripts of the Gemini-recorded conversation** to supervise the session and manage memory — i.e. Claude is a **core-path PHI processor**, not an optional one.
> - **OpenAI** is used **only** for icon generation from short tags and does **not** receive conversation, audio, video, or PHI.
>
> **Update 2026-08-26:** `shared/legal/recipients.ts` has since been split as
> recommended — Anthropic Claude (Monitor / transcript processor), OpenAI (icon
> generation from short tags only), plus a Pixabay entry. Two follow-ups remain:
> the consent-notice version constant was **not** bumped when that split landed
> (the documented update → bump → re-consent procedure was skipped), and Dropbox
> and session-recording storage still have no entry at all. Note also that the
> *code default* for the PHI-bearing roles was OpenAI `gpt-4o` until it was
> changed to `claude-haiku`; there is still no allowlist preventing an admin from
> pointing `aac_moderator` or `clinician` at an arbitrary provider, so the
> deployed routing rests on `system_settings` rows rather than on a control.

---

## Section-by-section compliance matrix

### 1. Physical & environmental security
| Clause | Status | Evidence / notes |
|---|---|---|
| 1.1–1.3 Physical access control, policies, need-to-know | ✅ | Inherited from AWS data-center controls (`il-central-1`); SOC 2 / ISO 27001 / AWS attestations available on request. No self-managed hardware. |

### 2. Reliability, access authorization, segregation
| Clause | Status | Evidence / notes |
|---|---|---|
| 2.1 Access only to essential, authorized staff | ✅ | `accessCtx` typed authorization on all PHI reads (`SECURITY_ARCHITECTURE.md §5.4`); IAM least-privilege in Terraform. |
| 2.2 InfoSec procedures (authorization, control, responsibility) | 🟡 | Implemented technically; formal written procedure pack for AKIM is a 📋 deliverable. |
| 2.3 Staff security-awareness program | 📋 | Organizational — not engineering. |
| 2.4 Confidentiality undertakings before access | 📋 | Staff NDAs/undertakings — organizational. |
| 2.5 Undertaking ≥ this appendix's protection level + IL privacy regs | 📋 | Legal drafting. |
| 2.6 Use only for service purpose | ✅ | Data used only for AAC/clinical functions; no secondary use. |
| 2.7 Technical + physical access enforcement | ✅ | helmet/CSRF/CORS/rate-limit (verified in code); VPC SGs in `terraform/security.tf`. |
| 2.8 Revoke access when no longer needed | ✅ | Share/standing-share revocation; erasure pipeline revokes links; IAM lifecycle. **Since 2026-08-26 revocation is effective immediately:** removing a member from an institute deletes every persisted session for that user AND closes their live realtime sockets (`server/services/sessionInvalidation.ts`, called from `instituteService.removeMember`), and revoking an AAC device slot deletes the session bound to that device. Before that, `removeUserFromInstitute` only flipped `isActive`, so a terminated clinician kept PHI access for the life of their cookie. Still open: no dormant-account sweep and no periodic access review. |

### 3. AKIM information transferred to supplier
| Clause | Status | Evidence / notes |
|---|---|---|
| Data inventory table | 📋 | Must be filled per engagement. Our data classification is in `SECURITY_ARCHITECTURE.md §1` and `shared/schema-private.ts` (**74** tables as of 2026-08-26; note the row-scoped `boards` exception in §1.2.1, and the four PII carriers that live in the *public* schema — see §1.2). |

### 4. Information transfer process
| Clause | Status | Evidence / notes |
|---|---|---|
| 4.1 Encrypted channel, current TLS | 🟡 | TLS 1.2+ at ALB/CloudFront; `rds.force_ssl = 1`. **Fixed 2026-08-30:** the runtime DB connections now verify the RDS server certificate against the CA bundle the Dockerfile already shipped — `server/db-ssl.ts`, used by `server/db.ts` and `services/realtime/postgres-bus.ts`, pinned by `server/tests/db-ssl.test.ts`. Verification applies to `*.rds.amazonaws.com` hosts only, so Render-hosted staging and local Postgres are unaffected. One hop remains open and should be disclosed: ALB→ECS-task is plaintext HTTP inside the private subnets. That disclosure is now written down with its compensating controls (private subnets, no public IP, SG on port 5000 scoped to the ALB's SG only) in `docs/INFRASTRUCTURE.md` → Access & hardening; closing it means terminating TLS inside the container, which is a project rather than a flag. |
| 4.2 Strong mutual auth (e.g. certificate) | ✅ | TLS server cert; SSO via SAML/OIDC; session + MFA. |
| 4.3 Interface config approved by AKIM IT | 📋 | Per-engagement sign-off. |
| 4.4 No cleartext transfer over internet | ✅ | All ingress/egress HTTPS. |
| 4.5 Physical media transfer approved by AKIM | ✅ | N/A — no physical media transfer in the architecture. |

### 5. Information security in supplier systems
| Clause | Status | Evidence / notes |
|---|---|---|
| 5.1 High security across supply chain + sub-supplier audits | 🟡 | AWS attestations cover hosting; sub-processor (LLM/TTS) audit posture to be documented for AKIM. |
| 5.2 Appoint named InfoSec officer | 📋 | Name + contact to be provided to AKIM. |
| 5.3 Provide third-party sub-processor list | 🟡 | List exists (table above / `recipients.ts`); formal disclosure to AKIM outstanding. |
| 5.4 No exposure to sub-contractors / across projects without approval | ✅ | Single-tenant logical isolation via `accessCtx`; no cross-project data sharing. |
| 5.5 Approved sub-contractors meet requirements / sign appendix | 📋 | Flow-down agreements (SCCs etc.) for LLM/TTS vendors — legal. |
| 5.6 Separation between dev/lab systems and AKIM data + internet | ✅ | Prod/test separation; private subnets; `SECURITY_ARCHITECTURE.md §3.2`. |
| 5.7 Remote access: approval, role-scoped, logged | 🟡 | Bastion has **no ingress rules at all**, no public IP and no SSH key pair — access is AWS SSM Session Manager only (`terraform/bastion.tf`). Admin PHI reads are audited (`sharing/audit.ts`, `viaAdmin`) and support-mode impersonation is audited start/end with a 60-minute lapse. **Managed 2026-08-30:** interactive SSM shell sessions are transcribed to the logs bucket under `ssm-sessions/` via the account-default `SSM-SessionManagerRunShell` document (`terraform/ssm.tf`, `enable_ssm_session_logging`), inside the 6-year lifecycle. Two honest limits: **port-forwarding sessions — which is what the DB tunnel is — produce no transcript at all** (there is no shell stream), so their only record is the CloudTrail `StartSession`/`TerminateSession` event, which exists only under the `hipaa` profile; and IAM database authentication is enabled on the instance with the `rds-db:connect` policy created, but no engineer is attached and the `aivota_engineer` DB user has not been created, so human DB sessions still share `aivota_admin` in practice. |
| 5.8 Log retained ≥ 6 months: actor, action, changed value, timestamp | ✅ | `activity_logs` (actor/action/details/createdAt), now including **owned** PHI reads via `server/middleware/phi-read-audit.ts` — previously only cross-institute reads were recorded. CloudTrail files + ALB/S3 access logs are retained 6 years in S3; the CloudTrail-CW, VPC-flow, RDS and WAF **CloudWatch** groups are retained 2192 days directly (`audit_log_retention_days` under the `hipaa` profile) — there is no CloudWatch→S3 export path, contrary to earlier wording. **Exceeds 6 months.** Caveat: field-level "changed value" capture covers only `students` and `aac_settings` (`activityChanges.ts`). |
| 5.9 Dedicated libraries, authorized staff, personal password | ✅ | Per-user accounts; bcrypt-12; no shared creds. |
| 5.10 No AKIM data in local folders / on laptops | 📋 | Endpoint policy — organizational; technically data stays server-side. |
| 5.11 Systems hardened per standards | ✅ | See sub-items below. |
| 5.11.1 Access-control procedures, password policy | ✅ | Auth + MFA + session controls, including a **30-minute idle timeout** on clinician/admin/support sessions (`server/session-lifetime.ts`, fed by Terraform's `session_timeout_minutes`) and a 60-minute cap on support impersonation. AAC device sessions are deliberately long-lived and are protected instead by device-slot revocation and a per-student caretaker PIN. |
| 5.11.2 No routine Administrator/shared accounts | 🟡 | Application logins are personal and admin actions are audited. **Database** access is still shared in practice: human sessions use `aivota_admin` over the SSM bastion. The infrastructure half landed 2026-08-30 — `iam_database_authentication_enabled = true` on the RDS instance and an unattached `rds-db:connect` policy scoped to `dbuser:<resource-id>/aivota_engineer` (`terraform/iam.tf`, output `rds_iam_connect_policy_arn`) — but it stays 🟡 until the one-time `CREATE USER aivota_engineer; GRANT rds_iam TO aivota_engineer;` is run and the policy is attached to real engineers. Recipe in `docs/INFRASTRUCTURE.md` → Access & hardening. Separately, CI: Terraform now declares a `main`-only deploy role with a policy that can actually run the apply, plus a read-only `pull_request` plan role, both bounded by name prefix and an explicit Deny on account/billing/IAM-user actions (`terraform/iam.tf`). The workflow still authenticates as the out-of-band `cliniaccian-github-actions-bootstrap` (`AdministratorAccess`) role until the `AWS_ROLE_ARN` repo secret is repointed — a one-step manual cutover kept deliberately manual so the admin role stays available as break-glass. |
| 5.11.3 Remove unneeded services, patch | ✅ | Managed AWS services; `auto_minor_version_upgrade` on RDS. |
| 5.11.4 OS hardening + ongoing security updates | 🟡 | Fargate managed runtime; container runs non-root. **Managed 2026-08-30:** ECS Exec is off (`enable_ecs_exec = false` in both profiles — it had been hardcoded on while the task role lacked `ssmmessages:*`, so it advertised a shell nobody could open); the Terraform task-definition template is pinned to an image **digest** rather than the mutable `:latest` (`ecr_image_exists`); the coturn EC2 host has a weekly AL2023 security patch baseline + State Manager association (Saturday 00:00 UTC ≈ 03:00 Israel) and a pinned `coturn/coturn:4.17.2` image. `readonlyRootFilesystem = true` in both ECS profiles with a `/tmp` ephemeral volume as the only writable path: every app-directory debug-log writer is gated on `server/services/file-debug-log.ts` (false in production) and writes through a `safeAppend` that swallows `EROFS`, pinned by `server/tests/readonly-root-fs.test.ts`. Remains 🟡 rather than ✅ only because the coturn host is a self-managed OS whose patch cycle is now automated but not yet evidenced, and the container image itself carries no CIS-style benchmark. |
| 5.11.5 Prod/test/dev separation + matched env | 🟡 | Production is AWS `il-central-1` / ECS. **`staging` is not on AWS — it runs on Render**, outside every control described here, and it holds migrated real data; treat it as a separate risk, not as a matched environment. |
| 5.11.6 Antivirus/EDR / malware prevention | 🟡 | WAF (now with logging to a CMK-encrypted group, credential headers redacted) + GuardDuty with findings routed to the alerts SNS topic; no traditional EDR (no persistent hosts except the SSM-only bastion and coturn). Document as compensating control. |

### 6. Secure development (SDLC)
| Clause | Status | Evidence / notes |
|---|---|---|
| Secure SDLC per industry practice | 🟡 | npm audit/Dependabot, ESLint security, Zod validation, code review. Formal SDLC policy doc for AKIM is a 📋 deliverable. |

### 7. Provide certifications
| Clause | Status | Evidence / notes |
|---|---|---|
| Prior pen-test / app-test certificates | 🔶 | Internal pre-flight done (`moe-status.md §A`); **external Experis pen-test pending** — no external certificate yet. |

### 8. Audit rights
| Clause | Status | Evidence / notes |
|---|---|---|
| AKIM may audit supplier | 📋 | Accept contractually; technically supportable. |

### 9. Change notification
| Clause | Status | Evidence / notes |
|---|---|---|
| Report changes affecting AKIM data security | 📋 | Establish a notification process/contact with AKIM. |

### 10. Exceptions & reporting
| Clause | Status | Evidence / notes |
|---|---|---|
| 10.1 Report security/physical events | ✅ | Incident-response process (`SECURITY_ARCHITECTURE.md §9`). Detection now actually pages: the alerts SNS topic has an email subscription and the CMK grants CloudWatch/EventBridge permission to publish to it, and the failed-login alarm has a real metric behind it (log metric filter on the `[auth] login_failed` marker). Before 2026-08-26 the topic had no subscriber and the CMK blocked the publish. |
| 10.2 Demonstrate IR readiness (policy docs) | 🟡 | IR process documented; incident templates drafted (`server/services/incident-templates/`), **counsel review pending**, and `fillIncidentTemplate` has **no production caller** — it is a formatter, not a dispatcher. No breach register. |
| 10.3 Investigation report ≤ 3 days from event end | 🟡 | Process supports it; templates ready but sending is a manual step (see 10.2). |
| 10.4 Immediate verbal + written report ≤ 48h | 🟡 | Within breach-window resolver scope; delivery is manual (see 10.2). |
| 10.5 Immediate report of significant events | ✅ | Covered by IR process. |
| 10.6 Notify AKIM of data-subject review/correct requests ≤ 72h | ✅ | Data-subject pipeline (§18); 72h handling. |

### 11. Credit cards (PCI DSS)
| Clause | Status | Evidence / notes |
|---|---|---|
| PCI DSS if storing/processing card data | ✅ | We do **not** store/process card data; Stripe (PCI-certified) handles it. |

### 12. Cloud computing
| Clause | Status | Evidence / notes |
|---|---|---|
| 12.1 Notify AKIM of cloud changes | 📋 | Process item. |
| 12.2 Cloud data encrypted unless public/approved | ✅ | Customer-managed KMS on all PHI and secrets (`rds.tf`, `storage.tf` uploads, Secrets Manager, every Terraform-managed CloudWatch group, CloudTrail, Redis, SNS). Non-PHI buckets use SSE-S3 — "KMS everywhere" is accurate for PHI, not literally for every bucket. |
| 12.3.1 Infra access only from supplier network | ✅ | Private subnets; bastion-gated DB access. |
| 12.3.2 Access on need basis | ✅ | IAM least-privilege; `accessCtx`. |
| 12.3.3 Strong authentication | ✅ | MFA, SSO, IAM. |

### 13. Data at rest & encryption
| Clause | Status | Evidence / notes |
|---|---|---|
| 13.1 All data (DB, files, backups) encrypted at rest | ✅ | RDS `storage_encrypted=true` (CMK); the PHI uploads bucket is SSE-KMS with a bucket policy refusing non-TLS requests and PUTs naming any other SSE method; RDS snapshots encrypted. Non-PHI buckets (logs, AAC updates, static frontend, CloudFront logs, Terraform state) use SSE-S3 — encrypted, but with S3-managed keys. |
| 13.2 AES-256 or equivalent, current standards | ✅ | KMS (AES-256); app-layer AES-256-GCM (`server/services/encryption.ts`). |
| 13.3 Key management via HSM/KMS + separation of duties | ✅ | AWS KMS CMK, `enable_key_rotation=true` (`terraform/secrets.tf`); IAM-separated. |
| 13.4 Backups encrypted, access restricted | ✅ | RDS snapshots KMS-encrypted; S3 versioned + KMS. |
| 13.5 No plaintext on endpoints/mobile unless approved | 🟡 | Data stays server-side; `ENCRYPTION_KEY` in Secrets Manager, never on endpoints. **Exception to disclose:** the optional AAC session-recording feature writes unencrypted A/V clips to the device's local disk. They are now pruned by age (default 30 days, per-student 1–365, `shared/aac/session-recording.ts`) and the target folder refuses UNC paths and cloud-sync roots, but the clips themselves are not encrypted and are outside the server-side erasure cascade. |
| 13.6 Physical media encrypted + securely destroyed | ✅ | Managed-cloud — no self-managed media; AWS media destruction attested. |

### 14. Transfer of information outside Israel — **🔶 KEY ITEM**
| Clause | Status | Evidence / notes |
|---|---|---|
| 14.1 No transfer/storage/access outside Israel without written approval | 🔶 | Hosting is in `il-central-1`, **but** live AAC audio/video goes to **Gemini Live** (EU/US), **conversation transcripts go to the Anthropic Claude Monitor agent** (US), and TTS to US — all core-path PHI. Requires AKIM **prior written approval**. |
| 14.2–14.4 Comply with IL Privacy Law + GDPR/HIPAA, SCCs/TIA | 🔶 | `shared/regime/` supports regime logic; **SCCs / TIA for the LLM/TTS vendors must be executed**. |
| 14.5 Foreign third parties sign strict agreement | 📋 | Flow-down DPAs with Gemini/Anthropic/ElevenLabs. |
| 14.6 Full responsibility even via sub-contractors | 📋 | Contractual. |

> **Resolution options for §14:** (a) obtain AKIM written approval + SCCs/TIA for the cross-border LLM/TTS sub-processors (fastest); or (b) move inference/TTS to in-region/in-country providers (architectural, slower). This is the single largest gap and is not solved by hosting location alone.

### 15. Information security events
| Clause | Status | Evidence / notes |
|---|---|---|
| 15.1–15.3 Full responsibility, prevention, immediate notice | ✅ / 📋 | Technically supported (IR §9); liability framing is contractual. |

### 16. Indemnification & compensation
| Clause | Status | Evidence / notes |
|---|---|---|
| 16.1–16.3 Indemnify AKIM for damages | 📋 | Legal/insurance — accept contractually. |

### 17. Termination of engagement
| Clause | Status | Evidence / notes |
|---|---|---|
| 17.1 Stop use on termination | ✅ | Erasure pipeline + access revocation. |
| 17.2 Return or securely erase all data + copies/backups | ✅ | `studentErasureService` cascades ~25 PHI tables + S3 cleanup. |
| 17.3 Secure destruction (logical + physical) | ✅ | DB hard-delete + S3 object delete; KMS key destruction available. |
| 17.4 Written confirmation of deletion | 🟡 | `student_erasure_completed` audit event proves it; a formal certificate to AKIM is a 📋 step. |
| 17.5 Sub-processors also delete | 📋 | Flow-down to vendors. |
| 17.6 Survives termination | ✅ | N/A engineering — contractual. |
| **Cron caveat (resolved 2026-08-26)** | ✅ | The erasure sweep now runs on the production ECS path: `server/app.prod.ts` and `server/index.ts` both call `scheduleMaintenanceCrons()`, guarded by a Postgres advisory lock so exactly one task executes it, with a wiring test pinning both call sites. The legacy Lambda path still depends on `enable_cron_scheduler=true` (`terraform/eventbridge-cron.tf`), which is only reachable when `use_lambda = true`. |
| **Disposal SLA caveat** | 🟡 | A completed erasure is not instantaneous everywhere: RDS point-in-time recovery retains deleted rows for the backup window (35 days) and S3 noncurrent object versions for 30 days. Neither the retention text nor the consent notice currently states this. |

### 18. Handling data-subject inquiries
| Clause | Status | Evidence / notes |
|---|---|---|
| 18.1 Act per IL Privacy Law | ✅ | Consent + data-subject flows. |
| 18.2 No independent response without AKIM written instruction | ✅ | Process-gated. |
| 18.3 Forward inquiries to AKIM ≤ 72h with details | ✅ | Supported. |
| 18.4 Cooperate: locate/produce/correct/delete | 🟡 | **Delete** is implemented end-to-end (soft-delete → 30-day window → cascade, now actually scheduled). **Produce** and **correct** are not: there is no designated-record-set export, no access-request workflow and no amendment/denial machinery. Requests would be served by ad-hoc engineering today. |
| 18.5 Mechanisms to locate/retrieve/handle personal data | 🟡 | `accessCtx`, schema and the erasure cascade locate the data; `ActivityLogFilters.subjectId` now allows "every logged event about student X" to be queried. Not covered: disclosures to sub-processors (LLM/TTS transports) are never written to `activity_logs`, so an accounting of disclosures would be incomplete. |

### 19. Maintaining legal provisions
| Clause | Status | Evidence / notes |
|---|---|---|
| Declare compliance with IL Privacy Law 1981 + InfoSec Regs 2017 | 📋 | Legal declaration + signature — counsel to confirm. |

---

## Remediation checklist (to reach full compliance on the AWS path)

**Engineering:**
- [ ] 🔶 Execute SCCs/TIA (or obtain AKIM written approval) for cross-border PHI sub-processors: **Gemini Live** (audio/video), **Anthropic Claude Monitor** (conversation transcripts), and **Google TTS/ElevenLabs**. Draft a BAA/DPA template — none exists in the repo.
- [x] ✅ Split the `recipients.ts` "OpenAI / Anthropic" entry: Anthropic = Monitor/transcript processor (PHI); OpenAI = icon-only (no PHI). **Done.** Stripe and Dropbox added 2026-08-30. Session recording is **not** a recipient — `shared/aac/session-recording.ts` uploads nothing; it belongs in the notice body as a local-storage disclosure. **Still open: the consent-notice version has not been bumped**, so records signed before 2026-08-30 do not name Stripe or Dropbox. Bumping means a new `consent-notices/il-2026-08.ts` variant + `ACTIVE_VERSION_BY_COUNTRY`, and triggers re-consent for every IL family.
- [x] ✅ Maintenance crons run in production (`maintenanceCrons.ts` + `cron-lock.ts`, both entrypoints). The legacy Lambda path still needs `enable_cron_scheduler = true` if it is ever used again.
- [ ] 🟡 Document EDR/antivirus compensating controls (WAF + GuardDuty + serverless no-persistent-host) for §5.11.6.
- [ ] 🟡 Generate a §17.4 deletion-confirmation certificate output from the erasure audit events.
- [x] ✅ Verify the RDS server certificate for §4.1 — **done 2026-08-30** (`server/db-ssl.ts`). Non-RDS hosts keep the previous relaxed config by design.
- [ ] 🔶 Build a §10 dispatcher for `fillIncidentTemplate` plus a breach register, and add a Business-Associate→covered-entity notice template.
- [ ] 🔶 Produce contingency-plan evidence for §17: the restore runbook (`docs/DISASTER_RECOVERY.md`) and the **in-region** drill script (`npm run dr:drill`, evidence in `docs/dr/drills/`) are written — **run the drill** so a dated evidence file exists and the RTO/RPO table carries measured numbers instead of targets. Cross-region snapshot copies are **not** part of this: `il-central-1` is the only Israeli region, so any copy elsewhere is a §14 transfer. Optional hardening: an `aws_backup_plan` vault, still in-region.
- [ ] 🟡 Build the §18.4 "produce" and "correct" flows (designated-record-set export; amendment request/denial).
- [ ] 🟡 Gate `medical_records.primary_diagnosis` out of the live-agent prompts (see `SECURITY_ARCHITECTURE.md` §12.1 item 17) or bring it under `allowReadReports` with an audit row.
- [ ] 🟡 Harden the deploy role (trust covers every branch/PR; effective permissions are attached outside Terraform) and the Terraform state bucket.

**Business / legal (📋):**
- [ ] Name an information-security officer for AKIM (§5.2) and provide the sub-processor list (§5.3).
- [ ] Staff confidentiality undertakings ≥ appendix protection level (§2.4–2.5).
- [ ] Complete the external (Experis) penetration test + certificate (§6/§7).
- [ ] Accept audit-rights, change-notification, and indemnification clauses (§8/§9/§16).
- [ ] Counsel review of incident templates (§10.2) and the §19 legal declaration.
- [ ] Fill the §3 data-inventory table and §4.3 interface sign-off per engagement.

---

## References
- `docs/SECURITY_ARCHITECTURE.md` — application/data-layer security
- `docs/INFRASTRUCTURE.md` — AWS architecture
- `terraform/` — `rds.tf`, `storage.tf`, `secrets.tf`, `security.tf`, `alerting.tf`, `monitoring.tf`, `eventbridge-cron.tf`, `terraform.tfvars`, `ecs-lean.tfvars`, `hipaa.tfvars`
- `shared/legal/recipients.ts` — sub-processor canonical list
- `shared/regime/regimes.ts` — retention & breach-window resolvers
- `server/services/encryption.ts`, `server/services/studentErasureService.ts`, `server/services/activityLogRetentionCron.ts`
- `server/services/maintenanceCrons.ts`, `server/services/cron-lock.ts` — cron scheduling + cluster lock
- `server/session-lifetime.ts`, `server/services/sessionInvalidation.ts`, `server/services/caretakerPinService.ts` — automatic logoff, session revocation, AAC caretaker PIN
- `server/middleware/phi-read-audit.ts` — owned PHI-read audit
- `planning-docs/ministry-of-education-approval/moe-status.md` — pen-test pre-flight status
