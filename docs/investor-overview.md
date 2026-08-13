# Aivota — Platform & Security Overview

*Prepared for prospective investors · August 2026*

---

## 1. What Aivota Is

Aivota is an AI-driven assistive communication and education platform for students with significant communication impairments — initially children with Rett syndrome, with a roadmap extending across special-needs education. It replaces the static, hand-authored communication boards of traditional AAC (Augmentative and Alternative Communication) devices with a real-time, multimodally-aware AI environment that both *gives* the student expressive vocabulary and *teaches* them how to use it.

The platform ships as **two clients on one backend**:

- **The AAC client** — the student's own app, built for eye-gaze and low-effort interaction, driven by a four-agent AI architecture.
- **The CliniAACian portal** — the clinician, teacher, and family app, where nearly every operation can be performed by talking to an AI assistant.

A traditional AAC device offers the student a fixed grid of buttons that someone else authored in advance. Aivota's board **rebuilds itself around the moment**: what the camera sees, who is in the room, what was just said, what's on the calendar, and what this particular student has said before. When the right word still isn't on the board, the student can build it symbol-by-symbol, or let the AI find it through a guided "20 questions" search. The gap between a fixed vocabulary and open-ended communication — the central failure of conventional AAC — is the product.

---

## 2. Platform at a Glance

| | |
|---|---|
| **Student app platforms** | Windows desktop (primary — one-click installer, silent auto-update, full eye-tracking support); iPad (built, in hardware verification); web browser |
| **Clinician portal** | Web application |
| **Languages** | 11 languages — English, Hebrew, Arabic, Spanish, French, German, Portuguese, Russian, Mandarin, Cantonese, Korean — with full right-to-left support. The student app follows the *student's* language, not the operator's |
| **Business model** | Per-license permission bundles (students, devices, feature tiers); credit-based AI usage with monthly budget tiers; Paddle checkout |
| **Cost accounting** | Every AI and speech charge lands in a unified usage ledger, broken down per session, per student, per user, and per function |
| **Hosting** | AWS Israel region (il-central-1); serverless today with a container/HIPAA-hardened deployment path ready |

---

## 3. The Student Experience

### 3.1 Four AI agents behind one board

The student app is driven by four specialized AI agents coordinated through a central hub, each with a distinct role and — critically — a distinct permission scope:

- **Observer** (perception) — watches the camera and listens to the microphone; recognizes people, gestures, and scene changes; decides the AI's behavioral mode. Never speaks.
- **Speaker** (voice) — the AI's conversational voice, on a low-latency native-audio model. Never touches the board.
- **Board Manager** (button surface) — rebuilds the communication board on every conversational beat. Never speaks.
- **Monitor** (memory and supervision) — a reasoning-class model that reads the clinical record, injects long-term goals into the live agents' context, records session notes, and writes the session summary. It cannot speak to the student and cannot write clinical records.

Splitting the roles is not cosmetic: each agent runs on the model class its job needs, holds a small reliable tool surface, and — because only the Monitor can read clinical data, and the live agents receive only an AI-curated redacted prompt — the always-on device can behave with full situational awareness **without ever exposing diagnostic or medical detail** to the student or a bystander.

The Observer steers between three behavioral modes: **Companion** (the AI engages the student directly), **Facilitator** (the AI quietly manages the board while the student talks to a person), and **Standby** — plus a manual mute that silences the AI's voice while the student's own buttons keep speaking.

### 3.2 Three paths to say anything

1. **The response board.** Context-appropriate buttons regenerated in real time from the scene, the conversation, the calendar, and the student's history. Board history gives the student back/forward/pause control, so the surface never changes out from under them without recourse.
2. **The sentence builder.** A parts-of-speech grid designed entirely for eye-gaze (no scrolling, stable target positions), where the AI suggests the most probable next symbol as the sentence grows. Words are composed as **glyphs** — a main symbol plus modifiers (color, quantity, negation, tense, possession, spatial relations) — so the student can say far more than the icon set literally contains.
3. **The Word Finder.** When the concept isn't on any board, a guided "20 questions" search narrows in on it — the AI asks the questions, but a deterministic client-side engine constrains the search so it cannot wander. Found concepts are remembered and offered proactively in later sessions.

Symbols resolve from three sources: a canonical library, the student's own custom symbols (a photo of *their* dog), and AI-generated art — which passes through a refinement stage that keeps a coherent house style and converts copyrighted character references into legally-distinct analogues.

### 3.3 A voice of their own

Every button press speaks in the **student's** chosen voice — distinct from the AI's voice — with multiple TTS engines behind it (ElevenLabs, Google, Gemini, native live audio, and an on-device fallback). Speech delivery adapts to connection quality: on a poor network the device buffers rather than stutter, common phrases are cached on-device, and a local voice guarantees a button press is never silent.

### 3.4 Access methods — the accessibility depth

This is where the platform runs deepest, because the initial population (Rett syndrome) often has eye gaze as the *only* reliable channel:

- **Eye tracking** across Tobii, EyeTech, LC Technologies, Gazepoint, and WebHID hardware, plus camera-based tracking — with passive calibration (the student just looks at a moving dot; nothing to tap, no instructions to follow).
- **Three selection methods**, clinician-selectable per student: whole-button dwell; a corner "selection area" so labels can be read before committing; and an **intent decoder** that lets the student read freely and commits only when gaze genuinely settles — self-calibrating to that student's own stillness.
- **Rest space** — deliberate empty zones between buttons so there is always somewhere safe to look.
- **Configurable gaze smoothing**, dwell timing, and an anti-refire gate so a frozen tracker or a rebuilding board can never press buttons by itself.
- **Audio scanning** — the board reads itself aloud, either on demand or automatically when the system notices the student hunting without committing.
- **Touch, switch, and cursor access**; a hold-to-highlight gesture so a caregiver can point at a button without pressing it.
- **Defined gestures** — a clinician registers a student's idiosyncratic gesture ("she raises her left hand to mean *yes*"), and performing it toward the device triggers the full communication flow: voiced in the student's voice, answered by the AI, board rebuilt. Communication without touching the board at all.
- **Sign language** — ASL and Israeli Sign Language recognized through the camera.

### 3.5 Awareness and safety

- A **face mirror** in the header shows the student what the camera sees of them — both self-awareness and an honest "the camera is on" indicator, with one-touch camera/microphone toggles and a full session pause.
- **Face and voice recognition run on the server** against the student's own contact registry; the AI is *told* who is present and never guesses identity itself. A badge names who the device currently recognizes.
- **Seizure detection**: on-device motion detectors for convulsive and drop events, tuned per student, with a learned baseline of the student's habitual movements so ordinary motion doesn't trip it. Detection escalates to a **caretaker alarm** — up to a full red screen with a rising tone — and is gated on a real camera frame so it can never fire blind.
- By default the camera streams only on motion and the microphone only on detected speech (on-device neural voice-activity detection). A clinician can enable continuous **Full Attention** streaming per student.

### 3.6 Cost-bounded, always-on AI

An always-on multimodal AI is only a viable product if its unit economics are controlled:

- **Adaptive session profiles** drop the session to a lightweight resting state during quiet periods — roughly an order-of-magnitude cost reduction — and escalate back on wake.
- **Budget tiers** cap AI spend per student on rolling 3-hour/3-day/14-day windows; the device shows the remaining budget as a simple energy bar and throttles gracefully when exhausted.
- Idle watchdogs and unattended-session guards stop a device left running from burning budget.
- Every charge is attributed in the unified cost ledger, so per-student margin is measurable, not estimated.

### 3.7 Apps, games, and calls

An **apps page** (clinician-curated per student) extends the device beyond conversation:

- **Video calls** — the student can call approved contacts. The caller sees the student's live board; with explicit per-student consent a clinician can press buttons *for* the student (guided communication); shared games can be attached to a call so both sides play together.
- **YouTube** and **Spotify**, restricted to clinician-permitted channels, playlists, and videos.
- **Drawing** and **Music Maker**, both engineered for gaze (drawing follows slow deliberate eye movement; the xylophone can't play a wrong note).
- **A web browser** limited to a clinician-defined site list — on Windows, fully drivable by eye gaze.
- **Custom apps** assigned per student from the organization's catalogue, and a bridge contract for **third-party partner apps** that receive the gaze stream and pin their choices onto the real AAC board.

Four finished games ship today — **Space Trader, Sandbox, Bubbles, Musical Microbes** — all built for gaze input. Beyond them:

- **Social Trainer** — a procedurally generated AI peer with its own face, voice, personality, and memory, for practicing conversation in a safe environment. Clinicians set focus skills and a challenge ceiling across **19 tracked social skills**; the AI debriefs warmly with the student afterward.
- **Dollhouse** — the shipped demo of the World Engine (§7): the student watches over a living simulated household as a friendly spirit and directs the family using their own AAC sentences.

### 3.8 Classroom and resilience

- **Classroom mode** lets one device serve a group, loading the whole roster so the AI can address group dynamics.
- A dropped connection **resumes the same session** — conversation, board, and memory intact. Optional AES-encrypted on-device session storage survives even a server restart. The desktop app updates itself silently, and never interrupts a student mid-conversation to do so.

---

## 4. The Clinician & Caregiver Experience

### 4.1 The chat *is* the interface

Nearly every operation in the portal — creating a student, editing a goal, authoring a board, scheduling an event, changing AAC settings — can be done by **talking to the AI assistant**, with the visual panels updating live in the same turn. The panels are views over the same data the AI reads and writes, under the same permissions. Specialized **personas** (clinical advisor, SLP, OT, pediatric PT, behavioral analyst, teacher…) tune the assistant's expertise, backed by a **RAG medical reference library** covering conditions, clinical practice, and FDA-approved medications so answers are grounded rather than generic. Only a small set of high-security operations is deliberately kept behind explicit UI.

### 4.2 The clinical record

A caseload **dashboard** greets the clinician with KPIs, a caseload-by-phase chart, upcoming deadlines, and a priority-focus list of students needing attention. Beneath it:

- **Student files** — medical, functional, educational, and progress reports with a draft/review/finalize workflow, version history, and print-ready output. Upload a PDF and the AI extracts and stores the content.
- **Incidents** — typed, severity-graded events recordable by a clinician or by the AAC's Monitor agent during a session.
- **A verbal profile** stating what speech the student can physically produce — which the AAC enforces, so a session transcript can never attribute impossible speech to the student.
- **IEP (US) and TALA (Israel) program management** — annual goals, measurable objectives, baselines, Goal Attainment Scaling with aggregate T-scores, ICF functional profiles across six domains, data collection with trend visualization, related services, team management, meetings, and transition plans for ages 16–21.
- **Contacts & people directory** with biometric enrollment: multi-angle face galleries and multi-sample voice galleries that grow passively from confident sightings and self-correct when a match is fixed.
- **Calendar and locations**, fully integrated with the AAC — an upcoming event surfaces into the student's session in advance, so the board adapts to "it's music class now."

### 4.3 Content authoring

- **Board builder** — AI-generated boards from natural-language descriptions, refined in a drag-and-drop editor; multi-page boards, glyph composition, and context hints for automatic board activation. Boards created here load into the student's AAC automatically when the context hint is triggered.
- **Content packages** — shareable board bundles with an access-controlled lifecycle: institute-scoped by default, public listing only after human attestation (no identifiable people) plus platform-admin review. The AI can propose a publication but can never complete one.
- **Caption Studio** — turn any video into glyph-captioned video: transcribe, extract ideas, generate glyphs per cue, preview, and export a captioned MP4.

### 4.4 Insight and billing infrastructure

- **Deep Analysis** (premium) — a periodic pass over everything recorded about a student that surfaces patterns a busy team may have missed and drafts the clinical report in the same pass.
- **Video analysis** (premium) — upload footage of the student and get a timeline of relevant events and attention targets.
- **Insurance bridge** — US remote-therapeutic-monitoring (RTM) tracking against CPT codes 98977/98979/98980/98985, automatic clinician review-time tracking, monthly billing summaries with CSV export, and AI-drafted, clinician-finalized Letters of Medical Necessity with an ICD-10 picker. The code set is regime-driven data, so adding a market is a registry change, not a rewrite.
- **Messaging and video calls** between team members and to the student's device, with push notifications.

### 4.5 Organization and administration

Institutes with members, roles, classrooms, and invite-code onboarding; per-user settings including two-factor authentication, an SLP mode for therapist-carried devices, and opt-in Dropbox backup of records to the clinician's own account. The portal adapts its terminology — "student," "client," or "patient" — to the organization type (school, clinic, family). A permission-gated **admin backoffice** manages personas, the voice catalogue, model selection, licenses, SSO providers, cost dashboards, deep-analysis queues, the platform-wide audit trail, and a CRM pipeline fed by the public marketing site's AI lead-capture chat.

---

## 5. Security & Data Protection

The platform holds health records, biometric data, and the communication content of minors. Security is architectural, not bolted on. (Full detail: `docs/SECURITY_ARCHITECTURE.md`, `docs/SECURITY_OVERVIEW.md`.)

### 5.1 Data classification and the PHI boundary

- All data is classified (PHI / PII / operational / audit) with PHI tables physically separated in a private schema — 67 tables — whose reads require a typed access context that **fails closed**.
- The one mixed table (boards) splits student content from shareable content by a database-enforced constraint, so "which rows were PHI" is a query, not a forensic exercise.
- **The AI permission asymmetry (§3.1) is itself a security control**: the agents that see and hear the student never hold clinical data; the agent that reads clinical data cannot speak or write clinical records.
- National ID numbers are **write-only** — stored encrypted, returned as `[REDACTED]` to every reader, including the AI.

### 5.2 Encryption

- TLS 1.2+ on every connection; plain HTTP redirected.
- Database, file storage, and backups encrypted at rest (AWS-managed keys).
- Especially sensitive fields (MFA secrets, identity-provider secrets, OTP codes) are encrypted a **second time at the application layer** — a stolen database file doesn't reveal them.

### 5.3 Access control and audit

- Role-based access (admin, clinician, caregiver, family) with deliberately narrower family scoping; a student device can read only its own student's data.
- TOTP two-factor authentication, enforceable per institute, mandatory for system admins, with one-time recovery codes.
- SSO via SAML 2.0, OIDC, and OAuth2 — adding an identity provider (including a national one) is configuration, not code.
- Audit logging of logins, MFA challenges, cross-institute reads, share lifecycle, consent events, and erasure requests — retained for the longest window any applicable regime requires (currently 7 years); proof-of-deletion records are kept permanently.

### 5.4 Consent and guardianship

- Guardian consent is captured through a guided wizard with **identity verification** (SMS OTP per Israeli PPA requirements, government SSO, or signed-form fallback) and co-guardian acknowledgement, producing a signed receipt.
- **Cross-institute sharing requires the guardian to co-sign** before any record moves; sensitive records pass an extra confirmation gate; every cross-institute read is audit-logged.
- The sub-processor list in force is **stamped into each consent record**; adding a vendor increments the notice version and new processing requires fresh consent.
- Age-of-majority transitions (13 US / 16 EU / 18 IL) are flagged automatically.

### 5.5 Right to erasure

Soft-delete with immediate access revocation → 30-day cancellation window → scheduled hard delete of all linked health, educational, communication, biometric, and session data in a single transaction, including stored photos — with the deletion's audit trail preserved forever as proof.

### 5.6 Data residency and sub-processors

All infrastructure runs in AWS's Israel region (il-central-1); student data does not leave Israel for storage or backup. Expansion regions are planned as **per-region deployments** — EU data stays in the EU, US data in the US. AI providers (Google Gemini, OpenAI, Anthropic) and TTS providers (Google, ElevenLabs) process transient prompt content only — they never receive the database. Other sub-processors: AWS SES/SNS (email/SMS), Paddle and RevenueCat (billing), Dropbox (opt-in backup only).

### 5.7 Incident response and hardening

- A documented detect → contain → assess → notify → remediate → post-mortem process, with notification inside the **strictest applicable window** (GDPR 72h / IL 30d / HIPAA-FERPA 60d) and pre-approved bilingual templates.
- Dependency scanning on every change (npm audit, Dependabot); releases blocked on unaddressed critical vulnerabilities.
- Self-audit complete ahead of the external penetration test: security headers, CSRF protection, login rate limiting, log scrubbing (no stack traces or response bodies in logs), and full login audit trails.

---

## 6. Compliance & Market Readiness

**Compliance regimes are data, not code paths.** The platform ships with a regime registry — il_moe, il_health, il_general, us_hipaa, us_ferpa, us_coppa, us_section_508, eu_gdpr, eu_en_301_549, uk_dfe, uk_pba_2018 — and each license declares which regimes apply. Retention windows, notification deadlines, consent rules, and billing code sets all resolve through the registry, so entering a new market is a registry update.

**Israeli Ministry of Education vendor approval** (the gateway to the school system) rests on four pillars:

| Pillar | Status |
|---|---|
| SSO through the MoE identity provider | Technically ready — configuration change once MoE issues sandbox credentials |
| WCAG 2.1 AA accessibility | Automated baseline clean; manual audit is the last remaining item |
| Security architecture documentation | Done — regime-neutral, reusable for HIPAA/GDPR/FERPA reviews |
| External penetration test | Self-audit complete; awaiting the Experis engagement |

The AWS deployment has two Terraform paths: the cost-efficient serverless path in use today, and a hardened HIPAA-compliance path (containerized, VPC-isolated) ready to enable for production healthcare deployments.

---

## 7. What Is Genuinely Hard to Copy

1. **The four-agent architecture with asymmetric clinical permissions** — reliability and privacy from the same structural decision, not from prompt discipline.
2. **Real-time multimodally-driven board generation** — the board as a live conversational surface rather than authored content.
3. **The glyph composition system** with canonical/custom/AI-generated symbol resolution and IP-safe generation.
4. **The deterministic Word Finder** — an AI-guided search the AI cannot derail.
5. **PHI-bounded prompt curation** — situational awareness without clinical exposure, reviewable by clinicians.
6. **Server-authoritative biometrics** feeding live multimodal models that never infer identity themselves.
7. **Engagement-adaptive cost profiles and per-student budget metering** — the difference between a demo and a deployable always-on AI product.
8. **Accessibility depth** — intent decoding, rest space, passive calibration, defined gestures, sign language — built for the hardest users first, which makes every easier population a downhill expansion.

---

## 8. In Development

Stated plainly, because credibility matters more than completeness:

- **The World Engine** — a unified customizable living-world simulation where AAC vocabulary *is* the command language: the student presses glyphs and a simulated world responds, so language practice happens against visible consequences rather than quizzes. **Dollhouse ships today as its demo**; further surfaces (quest play, symbol learning, shared online multiplayer) are prototypes folding in.
- **iPad** — the app is built and publishable as a demo (sideload distribution with a guided walkthrough); proper App Store verification and distribution will arrive after the company is officially established. Eye tracking is not possible on iPadOS; iPad v1 is touch-first.
- **Classroom active-user switching** — the roster loads today; live mid-session switching of the active student is planned.
- **Partner-app monetization** — the embedding contract is shipped; license-token issuing for paid third-party apps is not yet built.
- **Multi-region data residency** — planned as demand materializes in the EU/US.
- **External penetration test and the final WCAG manual audit** — the two open items for MoE approval.
- **Voice identification rollout** — recognition works; the per-license gating that precedes release is pending.

---

*This document describes the platform as implemented in the codebase as of August 2026. Feature-level sources: `docs/SYSTEM_OVERVIEW.md`, `planning-docs/feature-overview.md`, `docs/SECURITY_OVERVIEW.md`, `docs/SECURITY_ARCHITECTURE.md`.*
