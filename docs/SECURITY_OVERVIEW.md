# Aivota — Security Overview

A plain-language summary of how Aivota protects student information, and what we do specifically to satisfy the Israeli Ministry of Education's (MoE) vendor-approval requirements. This document is written for school administrators, parents, regulators, and business stakeholders — it avoids technical jargon and points to deeper documents for engineers.

> **Companion documents (technical):**
> - `docs/SECURITY_ARCHITECTURE.md` — full security architecture
> - `docs/INFRASTRUCTURE.md` — AWS infrastructure details
> - `planning-docs/ministry-of-education-approval/moe-plan.md` — MoE approval plan
> - `planning-docs/ministry-of-education-approval/moe-status.md` — current status

---

## 1. What Aivota Is, and What Data It Holds

Aivota is an AAC (augmentative and alternative communication) platform that helps students with special needs — initially children with Rett syndrome — communicate, interact with the world, and learn. The platform has two sides:

- **Clinician side**, used by therapists, teachers, and caregivers to set up communication boards, track progress, and review sessions.
- **Student side** (the AAC client), used by the student to communicate with help from an AI assistant.

Because the platform is used in schools and clinics, it holds information that is sensitive by nature:

| Kind of data | Examples |
|---|---|
| Health and educational records | Medical notes, IEP goals, behavioral observations, therapy progress |
| Personal information | Student name, guardian contact, photo (for face recognition), national ID number |
| Communication content | Things the student "said" through the AAC system, voice recordings during sessions |
| Operational | School/clinic accounts, license info, login records |

We treat the first three categories as **protected health information (PHI)** regardless of which country a school is in. The platform applies the strictest applicable rule by default.

---

## 2. The Four Pillars of MoE Approval

To be approved as an authorized vendor by the Israeli Ministry of Education, a software provider must demonstrate four things. Here's what each means and where Aivota stands.

### 2.1 Single Sign-On (SSO) through the MoE identity provider

**What it is:** Teachers, students, and guardians should log in to Aivota using their existing MoE credentials — not a separate Aivota password.

**What we built:** Aivota supports the three major identity standards (SAML 2.0, OIDC, and OAuth2). Adding the MoE identity provider is a **configuration change, not a code change** — once MoE issues us their sandbox credentials, we add a row in our identity-provider table and the login button appears for institutes that have opted in.

**Status:** Technically ready. Awaiting MoE Sapakim portal credentials to run the sandbox dry-run.

### 2.2 Accessibility — WCAG 2.1 Level AA

**What it is:** The product must be usable by people with disabilities. WCAG 2.1 Level AA is the international standard, and Israeli law (IS 5568) effectively requires it for public-sector software.

**What we built:**
- Both clients (clinician and student) support font scaling, high contrast, reduced animations, and an enhanced focus indicator.
- Every interactive button has an accessible label so screen readers can announce it.
- The AAC client itself is built around switch and dwell-based selection — it is *designed* for students who can't use a standard mouse or keyboard.
- A signed accessibility statement is published in the product, with the date of the last audit and a contact for accessibility concerns.

**Status:** The automated baseline is clean (zero accessibility-linter errors). Manual checks for keyboard navigation, color contrast, and screen-reader compatibility are partially done — full audit is the last remaining item.

### 2.3 System architecture and data-handling documentation

**What it is:** A document that explains, in detail, what data we hold, where it lives, who can see it, how it's encrypted, and how long we keep it. This is what a regulator's security reviewer reads.

**What we built:** `docs/SECURITY_ARCHITECTURE.md` — covers data classification, encryption (in transit and at rest), authentication and authorization, audit logging, sub-processors, backup and disaster recovery, and incident response.

**Status:** Done. The document is regime-neutral so the same file works for MoE, HIPAA, GDPR, and FERPA reviews.

### 2.4 Penetration test

**What it is:** A neutral third party (typically Experis, contracted by MoE) tries to break into the system. The findings must be remediated before approval.

**What we built (before the test):**
- Standard security headers on every response.
- Cross-Site Request Forgery (CSRF) protection on all state-changing endpoints.
- Rate limiting on login and password-reset endpoints to defeat brute force.
- Removed every external library with a known critical vulnerability.
- Logs no longer contain stack traces or response bodies (so a leaked log file can't expose user data).
- Login attempts (success, failure, MFA) are now written to the audit log with IP and user-agent.

**Status:** Self-audit done; all the "loud" findings (security headers, CSRF, rate limiting, log scrubbing) are fixed. Awaiting the external Experis engagement.

---

## 3. How Your Data Is Protected

This section explains the protections that apply *all the time*, not just to MoE accounts.

### 3.1 Encryption

- **In transit:** Every connection to Aivota uses TLS 1.2 or higher (the same lock-icon HTTPS that banks use). Plain HTTP is automatically redirected.
- **At rest:** The database, file storage, and backups are all encrypted using AWS-managed encryption keys.
- **In the database itself:** Certain especially-sensitive fields (your two-factor secret, identity-provider client secrets, phone-OTP codes) are encrypted a *second* time at the application layer, so even a stolen database file doesn't reveal them in clear text.
- **Israeli national ID numbers** are write-only — they're stored encrypted and never returned to the screen or to the AI; you'll always see `[REDACTED]` where the number would be.

### 3.2 Who can see what

Every read of sensitive data goes through a permission check called the **access context**. Three principles:

1. **You see only your institute's students** — unless another institute has explicitly shared a specific student with you and a guardian has co-signed.
2. **The student's own device sees only that student's data** — even if the same browser is logged in to multiple students at different times.
3. **System administrators have separate, logged access** — their reads are tracked apart from regular users.

Cross-institute reads (the sharing case) are **audit-logged on every access**. Your own-institute reads are not — that volume would be unhelpful noise, and the within-institute permissions already prevent abuse.

### 3.3 Two-factor authentication

Optional for users, can be **enforced** by an institute administrator. Uses TOTP codes (the same kind generated by Google Authenticator, 1Password, Authy, etc.). Recovery codes are issued at setup so a lost device doesn't lock you out — and those recovery codes are one-time use only.

### 3.4 Audit log

Every important event is recorded:
- Logins (success and failure), MFA challenges, password resets
- Cross-institute reads of student data
- Creation, approval, and revocation of share invitations
- Consent signed, revoked, or re-signed
- Right-to-erasure requests, cancellations, and completions

The audit log itself is retained for the *longest* retention window required by any applicable regulation — currently 7 years for Israeli MoE / health regimes, 6 years for HIPAA, etc. Records that prove we honored a deletion request are kept forever.

### 3.5 Where the data lives

All Aivota infrastructure today is hosted in AWS's **Israel region** (`il-central-1`). That means:
- Student data does not leave Israel for storage or backup.
- AWS itself is the only sub-processor for hosting.
- The AI providers (Google Gemini, OpenAI, Anthropic) and the text-to-speech providers (Google, ElevenLabs) may process *transient* prompt content — they don't receive a copy of the database.

When we expand to a region outside Israel, that will be a per-region deployment with its own database, so EU data stays in EU and US data stays in US.

---

## 4. Consent and Guardianship

Aivota is used by minors, so consent is foundational.

- **Onboarding flow:** When a clinician adds a new student, the system sends a request to the listed guardian via SMS or email. The guardian signs the consent on their own device.
- **Identity verification:** For sensitive medical data, the guardian's identity is verified through a one-time SMS code (Israeli Privacy Protection Authority requirement, February 2026), through their own government SSO if available, or by uploading a signed form as a fallback.
- **Co-signing on cross-institute sharing:** If a school wants to share a student's record with a clinic (or vice versa), the *guardian* has to co-sign before any record actually moves. Until the guardian signs, the share invitation is a *pending bundle* — it carries the intent but does not grant access.
- **Stamped recipients:** When a guardian signs consent, the list of third-party services we use at that moment (AWS, Google, OpenAI, etc.) is stamped into the consent record. If we later add a new third-party service, existing consents remain valid for what they covered, but new processing involving the new service requires fresh consent.
- **Age-of-majority handling:** When a student crosses the relevant age threshold (different by jurisdiction — 13 in the US for COPPA, 16 in much of the EU, 18 in Israel for full majority), the system flags this and prompts the institute to either obtain student consent directly or take the appropriate action.

---

## 5. The Right to Be Forgotten

If a guardian (or the student, once of age) asks for their data to be deleted:

1. The student record is **soft-deleted** immediately — links to users and institutes are revoked, active shares are cancelled, and the data is no longer accessible.
2. A 30-day cancellation window starts. During this window, an administrator can reverse the deletion if it was a mistake.
3. After 30 days, a scheduled job performs a **hard delete** — the student record and all linked health, educational, communication, biometric, and session data are physically removed from the database in a single transaction.
4. The student's photo (used for face recognition) is also deleted from file storage.
5. The audit trail of the deletion itself is preserved forever as proof we honored the request.

If something fails (for example, the file storage is unreachable during cleanup), the database deletion still goes through and the operations team is alerted to finish the cleanup manually.

---

## 6. Sub-processors (Third-Party Services)

We use a small number of external services. The full list, with category and purpose, is below. This list is stamped into every consent record, so guardians know exactly who's involved.

| What it does | Provider |
|---|---|
| Cloud hosting and storage | Amazon Web Services (Israel region) |
| AI conversation (live AAC sessions) | Google Gemini, OpenAI, Anthropic |
| Text-to-speech (the AI's voice) | Google Cloud TTS, ElevenLabs |
| Federated login (when configured) | Google OAuth, Israeli MoE Sapakim, other institute IdPs |
| Transactional email | Resend |
| SMS for consent and OTP | AWS SNS |
| Billing (when applicable) | Stripe, RevenueCat |
| Personal-file backup (opt-in only) | Dropbox |

If we ever add a new vendor, the canonical list updates, the consent-notice version increments, and any *new* processing involving that vendor requires fresh consent. Existing consents stay valid for the list they were signed against.

---

## 7. Incident Response

If something goes wrong — a breach, a leaked credential, an unusual access pattern — the response process is:

1. **Detect.** Automated alerts on CPU, memory, error rates, database health, and (when enabled) AWS GuardDuty.
2. **Page.** On-call engineer is notified through CloudWatch alarms.
3. **Contain.** Affected component is shut down or its credentials are rotated.
4. **Assess.** Identify what data was affected, who it belongs to, and which regulators need to be notified.
5. **Notify** *within the strictest applicable window*:
   - GDPR: 72 hours
   - HIPAA, FERPA: 60 days
   - Israeli MoE, IL Privacy Protection Law: 30 days
   - The most demanding window wins. For an institute under both Israeli law and GDPR, that's 72 hours.
6. **Remediate** the root cause; rotate any leaked secrets.
7. **Post-mortem.** Written up; attached to the compliance evidence file.

Pre-approved notification templates exist in Hebrew and English for the three main incident categories, so a real incident isn't slowed down by drafting language from scratch.

---

## 8. Penetration Testing and Ongoing Hardening

- **Automated vulnerability scanning:** Every code change is checked against a public vulnerability database (npm audit + GitHub Dependabot). Releases are blocked if a critical vulnerability is unaddressed.
- **Annual external penetration test:** Required for MoE vendor status (Experis-conducted in 2026). Critical findings block production deploys until closed; high findings have a 30-day remediation SLA.
- **Pre-flight self-audit:** Before the external test, we run our own scan — OWASP ZAP baseline, header check, secret-scan, dependency audit — and fix what we find so the external test focuses on real exploitable issues, not noise.

---

## 9. What's Not Yet Done

Honesty matters. The following items are tracked, documented, and on the roadmap:

1. **Multi-region data residency.** Today everything is in Israel. EU and US institutes that require local residency aren't supported yet; we plan per-region deployments as those markets open.
2. **A single human review of the incident-response templates by outside counsel** before they're considered final. Today they're usable drafts.
3. **Per-institute breach-notification contact.** Today we contact the institute's admin email; institutes can't yet designate a specific privacy officer.
4. **External penetration test by Experis.** Self-audit is complete; the external engagement is pending Sapakim onboarding.

---

## 10. How to Reach Us

- **Accessibility concerns:** the contact email shown on the in-product accessibility statement.
- **Privacy / data-subject requests:** the contact email shown on the in-product privacy policy.
- **Security incidents:** the contact email shown on the platform's security page (admin-only route).

These addresses are configured per deployment and may differ between the production platform and a specific institute's environment.

---

*Last updated: 2026-05-28. This document is reviewed quarterly and after any material change in how the platform processes data.*
