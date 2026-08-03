# AKIM Israel — Information Security Appendix Compliance Assessment

**Source contract:** `docs/AKIM_COMPLIANCE.pdf` — אקים ישראל "נספח אבטחת מידע – להסכם מיקור חוץ לספקים חיצוניים"
(Information Security Appendix for an Outsourcing Agreement with External Suppliers), 19 sections.

**Our role in the contract:** "הספק" (the Supplier).

| Field | Value |
|---|---|
| Assessment date | 2026-06-14 |
| Assessed against | **AWS `il-central-1` deployment path** (Terraform). The Render beta is explicitly out of scope for this assessment. |
| Source of truth | `docs/SECURITY_ARCHITECTURE.md`, `docs/INFRASTRUCTURE.md`, `terraform/`, and the application source verified at assessment time. |
| Reviewer | Aivota Engineering |
| Status legend | ✅ Compliant · 🟡 Partial / needs config · 🔶 Action required · 📋 Organizational/legal (non-engineering) |

> **Scope note.** This document assesses the **technical and architectural** posture of the AWS deployment path. Several AKIM clauses are contractual/organizational commitments (sign confidentiality undertakings, accept audit rights, name a security officer, the §19 legal declaration). Those are flagged 📋 and are owned by business/legal, not engineering.

---

## Executive summary

The AWS `il-central-1` build is **designed to meet AKIM's technical bar** — encryption at rest and in transit, KMS key management, network isolation, audit logging, breach-notification tooling, and a right-to-erasure pipeline are all present. The application-layer controls (helmet, CSRF, CORS allowlist, rate limiting, AES-256-GCM field encryption, PHI-safe logging) are verified as wired in current code.

**The items that still require action before an AKIM engagement:**

1. **🔶 §14 — Cross-border sub-processors.** Even hosted in Israel, the AAC streams live student audio/video to **Google Gemini Live** (EU/US), and the **Monitor agent — Anthropic Claude by default (`claude-haiku`)** — receives **transcripts of those conversations** (PHI) to manage session memory (US). Both are core-path PHI processing outside Israel and require AKIM **prior written approval + SCCs / Transfer Impact Assessment**, plus disclosure under §5.3. (OpenAI is **not** in this path — see the sub-processor table.)
2. **🟡 §5.8 / §17 / §18 — Lambda maintenance cron is disabled.** On the Lambda path the audit-retention prune and erasure hard-delete sweeps do not fire unless `enable_cron_scheduler = true`. Currently `false`.
3. **🔶 §6 / §7 — External penetration test pending.** Internal pre-flight done; the external (Experis) test and its certificate are not yet complete.
4. **📋 §2.4 / §5.2 / §5.3 / §8 / §9 / §16 / §19 — Organizational/legal deliverables** (named security officer, sub-processor disclosure, staff confidentiality undertakings, audit-rights acceptance, indemnification, legal declaration). Tooling supports these; the contractual execution is outstanding.

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
| **Email/SMS delivery** (Resend, AWS SNS/SES) | Transactional mail, OTP | Recipient contact + message | Varies | Disclose |
| **Stripe / RevenueCat** (when applicable) | Billing | Billing identity (no card data stored by us) | US | §11 (PCI: handled by Stripe) |
| **Dropbox** (per-user opt-in) | User-initiated file backup | Files the user backs up | US | Disclose |

> **Note on the LLM roles (per operational clarification 2026-06-14):**
> - **Gemini Live** is the realtime provider — it receives live mic audio + camera video.
> - **Anthropic Claude** is the **Monitor agent** (`aac_moderator`, default `claude-haiku` in `monitor-agent.ts`). It is fed **transcripts of the Gemini-recorded conversation** to supervise the session and manage memory — i.e. Claude is a **core-path PHI processor**, not an optional one.
> - **OpenAI** is used **only** for icon generation from short tags and does **not** receive conversation, audio, video, or PHI.
>
> The canonical `recipients.ts` entry currently groups "OpenAI Realtime / Anthropic Claude" as one live-provider line. Recommend splitting it into (a) Anthropic = Monitor/transcript processor, and (b) OpenAI = icon generation only, so the parent-facing consent notice reflects reality.

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
| 2.8 Revoke access when no longer needed | ✅ | Share/standing-share revocation; erasure pipeline revokes links; IAM lifecycle. |

### 3. AKIM information transferred to supplier
| Clause | Status | Evidence / notes |
|---|---|---|
| Data inventory table | 📋 | Must be filled per engagement. Our data classification is in `SECURITY_ARCHITECTURE.md §1` and `shared/schema-private.ts` (67 tables; note the row-scoped `boards` exception in §1.2.1). |

### 4. Information transfer process
| Clause | Status | Evidence / notes |
|---|---|---|
| 4.1 Encrypted channel, current TLS | ✅ | TLS 1.2+ at ALB/CloudFront; `rds.force_ssl = 1`; `sslmode=require`. |
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
| 5.7 Remote access: approval, role-scoped, logged | ✅ | Bastion with no default ingress (`terraform/bastion.tf`); admin reads audited. |
| 5.8 Log retained ≥ 6 months: actor, action, changed value, timestamp | ✅ | `activity_logs` (actor/action/details/createdAt); CloudTrail + VPC Flow Logs 6-yr S3 retention. **Far exceeds 6 months.** |
| 5.9 Dedicated libraries, authorized staff, personal password | ✅ | Per-user accounts; bcrypt-12; no shared creds. |
| 5.10 No AKIM data in local folders / on laptops | 📋 | Endpoint policy — organizational; technically data stays server-side. |
| 5.11 Systems hardened per standards | ✅ | See sub-items below. |
| 5.11.1 Access-control procedures, password policy | ✅ | Auth + MFA + session controls. |
| 5.11.2 No routine Administrator/shared accounts | ✅ | Personal accounts; admin actions audited. |
| 5.11.3 Remove unneeded services, patch | ✅ | Managed AWS services; `auto_minor_version_upgrade` on RDS. |
| 5.11.4 OS hardening + ongoing security updates | ✅ | Lambda/Fargate managed runtimes; image rebuilds. |
| 5.11.5 Prod/test/dev separation + matched env | ✅ | Separate envs (`prod`/`staging`); regime-driven config. |
| 5.11.6 Antivirus/EDR / malware prevention | 🟡 | WAF + GuardDuty enabled (`enable_waf`, `enable_guardduty`); no traditional EDR (serverless — no persistent hosts). Document as compensating control. |

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
| 10.1 Report security/physical events | ✅ | Incident-response process (`SECURITY_ARCHITECTURE.md §9`). |
| 10.2 Demonstrate IR readiness (policy docs) | 🟡 | IR process documented; incident templates drafted (`server/services/incident-templates/`), **counsel review pending**. |
| 10.3 Investigation report ≤ 3 days from event end | ✅ | Process supports it; templates ready. |
| 10.4 Immediate verbal + written report ≤ 48h | ✅ | Within breach-window resolver scope. |
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
| 12.2 Cloud data encrypted unless public/approved | ✅ | KMS at rest everywhere (`storage.tf`, `rds.tf`). |
| 12.3.1 Infra access only from supplier network | ✅ | Private subnets; bastion-gated DB access. |
| 12.3.2 Access on need basis | ✅ | IAM least-privilege; `accessCtx`. |
| 12.3.3 Strong authentication | ✅ | MFA, SSO, IAM. |

### 13. Data at rest & encryption
| Clause | Status | Evidence / notes |
|---|---|---|
| 13.1 All data (DB, files, backups) encrypted at rest | ✅ | RDS `storage_encrypted=true`; S3 KMS; backups encrypted. |
| 13.2 AES-256 or equivalent, current standards | ✅ | KMS (AES-256); app-layer AES-256-GCM (`server/services/encryption.ts`). |
| 13.3 Key management via HSM/KMS + separation of duties | ✅ | AWS KMS CMK, `enable_key_rotation=true` (`terraform/secrets.tf`); IAM-separated. |
| 13.4 Backups encrypted, access restricted | ✅ | RDS snapshots KMS-encrypted; S3 versioned + KMS. |
| 13.5 No plaintext on endpoints/mobile unless approved | ✅ | Data stays server-side; `ENCRYPTION_KEY` in Secrets Manager, never on endpoints. |
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
| **Cron caveat** | 🟡 | On the **Lambda** path the erasure sweep needs `enable_cron_scheduler=true` (`terraform/eventbridge-cron.tf`) — currently disabled. ECS path runs it via `index.ts`. |

### 18. Handling data-subject inquiries
| Clause | Status | Evidence / notes |
|---|---|---|
| 18.1 Act per IL Privacy Law | ✅ | Consent + data-subject flows. |
| 18.2 No independent response without AKIM written instruction | ✅ | Process-gated. |
| 18.3 Forward inquiries to AKIM ≤ 72h with details | ✅ | Supported. |
| 18.4 Cooperate: locate/produce/correct/delete | ✅ | Erasure + access tooling. |
| 18.5 Mechanisms to locate/retrieve/handle personal data | ✅ | `accessCtx`, schema, erasure cascade. |

### 19. Maintaining legal provisions
| Clause | Status | Evidence / notes |
|---|---|---|
| Declare compliance with IL Privacy Law 1981 + InfoSec Regs 2017 | 📋 | Legal declaration + signature — counsel to confirm. |

---

## Remediation checklist (to reach full compliance on the AWS path)

**Engineering:**
- [ ] 🔶 Execute SCCs/TIA (or obtain AKIM written approval) for cross-border PHI sub-processors: **Gemini Live** (audio/video), **Anthropic Claude Monitor** (conversation transcripts), and **Google TTS/ElevenLabs**. Split the `recipients.ts` "OpenAI / Anthropic" entry: Anthropic = Monitor/transcript processor (PHI); OpenAI = icon-only (no PHI).
- [ ] 🟡 Enable the Lambda maintenance cron: set `enable_cron_scheduler = true`, `cron_target_url`, `cron_trigger_secret` + add `CRON_TRIGGER_SECRET` to app secrets (`terraform/eventbridge-cron.tf`). (Or complete the ECS cutover.)
- [ ] 🟡 Document EDR/antivirus compensating controls (WAF + GuardDuty + serverless no-persistent-host) for §5.11.6.
- [ ] 🟡 Generate a §17.4 deletion-confirmation certificate output from the erasure audit events.

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
- `terraform/` — `rds.tf`, `storage.tf`, `secrets.tf`, `security.tf`, `eventbridge-cron.tf`, `terraform.tfvars`
- `shared/legal/recipients.ts` — sub-processor canonical list
- `shared/regime/regimes.ts` — retention & breach-window resolvers
- `server/services/encryption.ts`, `server/services/studentErasureService.ts`, `server/services/activityLogRetentionCron.ts`
- `planning-docs/ministry-of-education-approval/moe-status.md` — pen-test pre-flight status
