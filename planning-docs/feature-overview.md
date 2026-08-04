# Aivota AI — Complete Feature Overview

*Last full sweep of the codebase: 2026-08-04. Previous edition: 2026-04-14 — everything marked **NEW** was added since then.*

Aivota is an AI-driven assistive communication and education platform for students with significant
communication impairments, initially focused on Rett Syndrome. It ships as **two clients on one backend**:
the **CliniAACian portal** (clinicians, caregivers, teachers, family) and the **AAC client** (the student).

For the architecture behind these features see `docs/SYSTEM_OVERVIEW.md`; for security and data-flow rules
see `docs/SECURITY_ARCHITECTURE.md`.

---

# Part 1 — CliniAACian / Caretaker Portal

The portal is organised as a persistent AI chat alongside a swappable feature panel. Every panel below is
also reachable and largely operable **through the chat assistant** — the AI can read and write the same
records the UI exposes, gated by the same permissions.

## AI Chat Assistant
- Conversational AI with full platform context — it knows the current student, their records, goals, calendar and boards.
- Voice input/output with customizable TTS.
- Manage all data either through the manual interface or by asking the AI.
- **Specialized personas** — assistant, coach, clinical advisor, teacher, pediatric PT, SLP, OT, behavioral analyst. Selectable per conversation; the number of "expert agents" available is a license permission.
- Multi-line chat input, streaming replies, visible thinking indicator.
- **Chat history sidebar** with named sessions and the ability to reopen a previous session. **NEW**
- **Prompt tracing** — per-message record of the prompt actually sent, for debugging and audit. **NEW**

## RAG-based Medical Data Library
- The AI has access to a large reference base covering medical conditions, clinical practice, and FDA-approved medications, so it can give grounded clinical answers rather than generic ones.

## Student Files (Reports)
- Upload PDF files to automatically extract and store student information.
- The AI has access to all student data and uses it to develop insights during conversations.
- Record types:
  - **Medical records** — diagnoses, medications, health alerts, equipment
  - **Functional reports** — mobility, ADL, sensory profile, safety
  - **Educational reports** — communication modes, assistive tech, behavioral strategies
  - **Progress reports**
- Draft / review / finalized workflow with version history.
- Print-ready output.
- **Incidents** — typed, severity-graded, timestamped events (medical/behavioral), recordable by a clinician or by the AAC's Monitor agent during a session. Each carries sensitivity markers that drive the cross-institute share confirmation gate. **NEW**
- **Accommodations** and **assessment sources** as first-class records. **NEW**

## Student Management
- Create and manage student profiles with demographics, diagnosis, and background.
- Search and filter by name, ID, school, or status.
- Multi-institute assignment; active/completed status tracking.
- **Verbal profile** — a structured statement of what speech the student can actually produce (`none` / `vocalizations` / `single_words` / `fluent`). This is not just documentation: the AAC coordinator enforces it, so a transcript can never attribute to a student speech they are physically incapable of producing, and unevidenced within-ability speech is demoted to ambient context instead of a reply-demanding turn. **NEW**
- **Student devices** — register/deregister the physical devices allowed to run the AAC for a student, with a per-license device cap. **NEW**
- **Student transfer** between institutes, and **student erasure** with a scheduled erasure job for right-to-be-forgotten requests. **NEW**
- **Student approval** flow before a clinician gains access. **NEW**

## Contacts & People Directory
- Per-student contact list: name, relationship, notes, and a shared biometric record.
- Contacts can link to a platform **user** or to **another student** (peer), with the biometric record synced across the link.
- Formal **IEP/TALA team-member fields** — role, organization, email, phone.
- **Callable flag** — marks a contact the student may video-call and the AI may offer to call. **NEW**
- **Guardian verification fields** — government ID number/type/country, verification source, legal-guardian and co-guardian declarations. ID numbers are write-only at the database layer and read back redacted. **NEW**
- `lastSeenAt` / `timesIdentified` maintained automatically by face and voice recognition.

## Biometric Enrollment
- Enroll a person by camera capture or **photo upload**, with automatic quality scoring. **NEW**
- **Multi-angle face gallery and multi-sample voice gallery** — a person is recognised across pose, lighting, expression, loudness and mic distance. Galleries grow passively from confident novel sightings and lose weight (then evict) when a match they produced is corrected. **NEW**
- AI-extracted physical description: hair colour, eye colour, estimated age/sex, identifying features.
- Recognition is **server-authoritative** — the live model is told who is present, it never infers identity itself.

## Event Calendar & Locations
- Schedule events, meetings, repeating appointments, and classes.
- Full integration with the AAC — an upcoming event is surfaced into the AI's session context in advance, so the board adapts to "it's music class now".
- **Attendees** and **event↔service links**. **NEW**
- **Locations** — a named place registry with matching logic, so events and the AAC can reason about where the student is. **NEW**
- Timezone-correct scheduling.

## AAC Board Builder (SyntAACx)
- AI-powered board generation from natural-language descriptions.
- Visual drag-and-drop editor with a button inspector.
- Multi-page boards with navigation; button customization (labels, symbols, colors, actions).
- AI-generated custom symbols with an approval workflow.
- **Context hints** — describe the situations a board is for (in class, while eating, at home). During an AAC session the AI examines the scene, checks calendar events, and calls up the board automatically.
- Export to **Grid 3 (.gridset)** format.
- **Glyph builder** — compose a glyph from a main symbol plus modifiers directly in the editor. **NEW**
- **Cover-image selector**, **board debug view**, **system-prompt management**, **cost-analytics dashboard**, and **user statistics** panes. **NEW**
- **Board packages control** — add a board to a content package from the editor. **NEW**

## Content Packages **NEW**
Shareable bundles of AAC content (boards today; the shape generalises to other item types).
- Owned by an institute; per-member ACL where an `edit` grant is effectively co-ownership.
- **Visibility**: `institute` (default) or `public`. Public listing passes an **admin review gate** (`pending` → `approved`/`rejected`); institute-scoped packages skip review because they never leave a boundary that already governs their boards.
- **Publish attestation** — a human must confirm the package contains no images of identifiable people. The AI may propose a publish but can never complete one.
- **Per-membership auto-load** — the same board can auto-load in one package and be picker-only in another.
- Refcounted lifecycle: deleting a package orphans and freezes it rather than yanking content out from under a student mid-session; it is garbage-collected once nothing links to it.

## Progress Tracking (IEP / TALA)
- Full IEP (US) and TALA (Israel) program management.
- Annual goals with baselines, targets, and success criteria.
- Short-term objectives with measurement methods.
- Data collection with trend visualization and baseline measurements.
- Related services tracking (speech, OT, PT, etc.), with service↔goal links.
- Team management with roles and contact info.
- Meeting scheduling and consent form management.
- **Profile domains** — per-domain strengths, needs, impact statement, and IEP adverse-effect statement. **NEW**
- **Transition plans and transition goals** for students aged 16–21. **NEW**
- **User goals/objectives** — goals attached to a caregiver rather than the student. **NEW**

## Interpret Communication
- Paste text or upload/crop an image of an AAC utterance (including a photo of a paper board) and have the AI interpret what the student was trying to say, in context.
- Interpretations can be saved to the record, copied, or deleted.

## Games & Custom Apps
- Author bespoke educational apps from parameterized templates — object editor, room editor, class rename, goal-tree quest preview.
- Assign apps per student; only apps from the student's own institutes are offered.
- Generated apps run as standalone embedded applications that talk to the core AI over the shared games bridge.

## Video Captions — Caption Studio **NEW**
Turn ordinary video into glyph-captioned video the student can follow.
1. Upload a video (plus an optional SRT/VTT caption file).
2. If there are no captions, **transcribe the audio** with server STT.
3. **Extract the ideas** from each caption segment with the AI.
4. **Generate glyphs** for those ideas, with a manual glyph-builder override per cue.
5. Preview with a live glyph overlay on the player, and **export a captioned MP4** via WebCodecs.
- Video hashing avoids reprocessing the same file; caption projects persist.
- Gated by the `videoCaptionEnabled` license permission.

## Deep Analysis & Report Drafting (Premium)
- Performs a deep analysis of all data concerning a student and looks for patterns that might have been missed.
- Produces a detailed report on insights, progress, and suggested next steps.
- **Clinical report drafting (formerly "DocuSLP") was merged into Deep Analysis** rather than shipping as a separate module — the same pass that finds the patterns writes the document. **NEW**
- Analyses are queued, tracked, and reviewable from the admin backoffice.
- Gated by the `deepAnalysisEnabled` license permission.

## Video Analysis (Premium)
- Upload videos of the student to analyze behavior.
- Creates a timeline of relevant events and marks areas and objects the student is focusing on.

## Consent & Sharing **NEW**
- **Consent wizard** — guided informed-consent capture, with guardian identity verification, co-guardian acknowledgement, and a signed **consent receipt**.
- **Consent authority panel** — record who holds the authority to consent (including court orders and issuing authority).
- **Consent history** and a **consent threshold cron** that watches for expiring or insufficient consent.
- **Consent invitations** — send a request to a guardian by email/SMS; they sign on a public consent page.
- **Cross-institute sharing** — outgoing shares, incoming shares, and a guardian inbox of invitations awaiting the current user. Approve / decline / redeem / accept / revoke lifecycle.
- **Standing shares** for ongoing access, plus per-object shares.
- Cross-institute reads are audit-logged separately from owned reads.
- Sharing sensitive records (incidents, medical) passes an extra confirmation gate.

## Insurance Bridge **NEW**
- **RTM tracker** — per-student remote-therapeutic-monitoring totals for a billing period, with regime-aware threshold pills (US CPT 98977 / 98979 / 98980 / 98985).
- **Clinician activity intervals** — the timed clinician-interaction data those codes are billed from.
- **Letters of Medical Necessity** — AI-drafted, clinician-finalized, print-ready, with an ICD-10-CM code picker.
- Regime-driven: the code set and thresholds come from the license's `billingRegime` (`none` / `us_cpt`), so adding a market is a registry change rather than a rewrite.
- Gated by the `insuranceBridgeEnabled` license permission.

## Messages (Person Chat) **NEW**
- Direct and group text messaging between platform people (clinicians, caregivers, family).
- Chat rooms with participants, WebSocket live delivery, and **push notification tokens** for mobile.

## Video Calls **NEW**
- Live video/audio calls between a clinician or family member and the student's AAC.
- Multi-party call sessions with participants and fan-out; TURN credential issuing for NAT traversal.
- **Mirrored board view** — the caller sees the student's live AAC board.
- **Facilitator control** — with `allowFacilitatorControl` enabled per student, a clinician on the call may press buttons on the student's board for them (guided communication). Off by default; presses are ignored otherwise.
- **Incoming call popup** and auto-answer handling on the AAC side.
- **Clinician STT** on the call audio.
- **Call-embedded games** — attach a shared game or quest surface to a live call so both sides play together.
- **Invite people** to an in-progress call.

## App Downloads **NEW**
- Windows (Electron) one-click installer that auto-updates itself afterwards.
- iPad (Capacitor) `.ipa` with a numbered sideloading walkthrough, since there is no App Store listing yet.
- Versions and availability read live from the release feeds' manifests; download links point straight at the CDN.

## Organization (Institute) Management
- Institute profile, members, roles, classrooms, and student assignment.
- **Invite codes** with redemption tracking.
- **Institute invites** for onboarding staff.
- **Classrooms** with classroom↔user and classroom↔student membership.

## Settings
- Profile, language, theme, notifications.
- **SLP Mode** — a per-*user* account setting (applies on every student, not stored per student). When on, the AAC session never sleeps on its own, a wake/sleep button appears on the AAC screen, and the AI assists the therapist rather than treating the student as its only conversational partner. **NEW**
- **Dropbox connection** — link an account and back up records to it. **NEW**
- **Two-factor authentication**, with recovery codes.

---

# Part 2 — AAC Client (Student-Facing)

## Core Communication
- AI-powered dynamic communication boards that adapt in real time to context.
- Multiple input methods: touch, eye gaze (configurable dwell), cursor, voice, gestures, and sign language.
- **Four-agent architecture** — Observer (perception), Speaker (voice), Board Manager (button surface), Monitor (long-term memory and supervision), coordinated through a central Coordinator. This replaced the earlier two-agent Interactive/Monitor design. **NEW**
- **Behavioral modes**, chosen by the Observer from the multimodal scene:
  - **Companion Mode** — the AI interacts directly with the student, asking questions and guiding progress toward goals.
  - **Facilitator Mode** — the AI manages the board quietly while the student interacts with others, speaking only when necessary.
  - **Standby Mode** — minimal presence.
  - Manually-activated **Silent/Mute Mode** forces the AI to stay silent.
- Quick-access buttons: Yes / No / More / Home / Back / Speak.
- **Board history — back, forward, and pause.** The student can step back to a previous board, step forward again, or pause automatic board rebuilding so the surface holds still. **NEW**
- **"More" button** that expands the current board rather than replacing it. **NEW**
- Pre-built board support alongside AI-generated boards, with a synchronized board format across both.
- **Home board** with tiered navigation (home → context → board).

## Glyph System **NEW**
Communicative output is structured as **glyphs**, not single icons.
- A glyph is a **main symbol plus zero or more modifiers** (color, quantity, negation, tense, possessive, spatial relation…). A button carries one or more glyphs forming a complete utterance.
- Symbols resolve in priority order: **canonical library → student-specific custom symbols → AI-generated symbols**, cached by semantic key for reuse.
- AI-generated symbols pass through an **image-prompt refinement stage** that enforces a coherent house style and converts copyrighted character references into legally-distinct analogues.
- **Numerals**, **emoji rasterization**, and **RTL-aware glyph rendering** (with a non-reversible set for emoji that must not mirror).
- **Relational and spatial modifiers** (in front of, over, under…).
- **Single-glyph mode** — constrain AI-generated buttons to one glyph each (the glyph may still carry modifiers), for early communicators. The sentence builder is unaffected.
- **Glyph input translation** (experimental) — mirror speech directed at the student (the AI's replies and overheard speech) back as a glyph strip in the header.
- **Voice-to-glyph** — spoken input rendered as glyphs.

## Multi-Path Vocabulary Access
Three nested fallbacks for expressing a concept:
1. **Response Board** — context-appropriate buttons regenerated on every conversational beat.
2. **Sentence Builder** — a parts-of-speech grid where the AI suggests the most probable next symbol given the partial sentence, the student's memory profile, and the scene. Includes **expressions**. **NEW**
3. **Word Finder / Guessing Mode ("20 questions")** — a frontend-owned deterministic narrowing engine drives the AI through clarifying questions when the concept isn't on any board. Resolved concepts persist to the student's memory and are surfaced proactively later. Includes a dwell-refire policy with a silent cooldown so an eye-gaze user isn't re-asked in a loop. **NEW**

## Language & Register **NEW**
- **Language level** (1–5: single words → short phrases → simple sentences → full sentences → complex) matched to the student's receptive language. Applies to the companion Speaker and to the social-trainer peer.
- **Interlocutor register** — the board reshapes for who the student is talking to. A **helper** (parent, teacher, therapist) gets needs and requests first-class; a **peer** gets reactions, ask-backs and sharing. Known contacts are classified deterministically from relationship/role; unknown people are inferred live by the Observer.
- **Authority deference** — when the user is a child, the persona spec emits an explicit deference block. **NEW**
- **Sentence complexity** control.

## Eye Tracking & Selection
- Compatible with **Tobii, EyeTech, LC Technologies, Gazepoint, WebHID, and browser/camera-based** tracking, plus mouse for testing.
- Passive fixation-based calibration (no tapping required).
- Configurable dwell timeout.
- **Selection method** — three choices: **NEW**
  - *Whole button* — looking anywhere on a button selects it.
  - *Selection area* — a small eye mark in the button's corner is the only live target, so the label can be read first.
  - *Intent decoder* — reading is allowed; a button is selected only once gaze settles, with a spark showing where the choice is forming.
- **Rest areas** — cuts a circle of empty space where four buttons meet, so there is always somewhere close by to look that selects nothing. A board may ask for less, never more. **NEW**
- **Gaze smoothing** with off/light/medium/strong presets plus advanced tuning: responsiveness, fast-movement tracking, fixation lock, fixation zone, hold time, and viewing-distance mode (automatic from camera, or fixed). **NEW**
- **Automatic audio scan** — when the student keeps hunting across the board without committing a selection, the spoken readout starts on its own; the ear control lights up as if pressed, and any selection stops it. Delay is configurable and floors well above the dwell time. **NEW**
- **Button hold selection** and repeated-press guard. **NEW**
- **Gaze sidecar** for hardware trackers on desktop, with dynamic port negotiation.

## Perception & Safety
- **Facial expression recognition** (smile, frown, attention/focus), **head gestures** (nods, shakes, turns), **hand gestures** (wave, point, raise, pinch), and **body pose**.
- **Sign language interpretation** via camera — ASL and Israeli Sign Language; each completed phrase is submitted to the AI as a statement.
- **Object detection** — identifies items the student is focusing on and adds them to the board.
- **Multi-person detection** with server-authoritative face and voice identification.
- **Defined gestures** **NEW** — clinician-configured per student (name + physical description + meaning). Performing one toward the device replays the full button-press flow: the meaning is voiced in the student's voice, the Speaker replies, the board rebuilds — communication without touching the board.
- **Seizure detection** **NEW** — on-device motion detectors for convulsive (rhythmic) and drop/atonic events, with optional audio corroboration that can raise concern for a flagged motion but never alarms on its own. Per-detector sensitivity is clinician-tuned, and a machine-learned habitual-motion baseline persists across sessions so the student's ordinary movements don't trip it. The detector flags; the AI then looks and decides.
- **Emergency alarm** **NEW** — escalating on-screen and audible alarm, gated on a real visual frame so it cannot fire blind.
- **Silero VAD** — neural voice-activity detection on device, so the mic only streams on actual speech. **NEW**
- **Scene-change detection** and activity-driven frame gating instead of fixed-interval polling.
- **Passive co-listening** — monitors ambient speech, detects choice offers and yes/no questions directed at the student, and surfaces the matching response buttons.

## Voice & Audio
- TTS engines: **ElevenLabs, Google, OpenAI, Gemini TTS, Gemini Live native audio, and browser speechSynthesis**.
- Separate configurable voices for student output and AI response, with per-voice **pitch shift in semitones**.
- **Live Audio AI** toggle — the Speaker either speaks directly through Gemini Live native audio (more natural intonation, higher cost) or runs as HTTP completion plus streaming TTS (cheaper, more reliable tool calling). **NEW**
- **Local browser voice** fallback for slow connections.
- **Streaming STT** on voice input, with the recognised text displayed back to the student. **NEW**
- **Voice identification** against the contact registry. **NEW**
- **Two-tier voice** handling and a voice gallery per person.

## Built-In Apps
Togglable and tunable from CliniAACian; the AI can launch any of them by name.
- **Phone Call** — browse callable contacts and place a live video call. **NEW**
- **YouTube player** with large accessible controls, restricted to clinician-permitted **channels, playlists, and individual videos** (any YouTube link is auto-typed). Pinned videos appear as one-tap tiles. **NEW**
- **Spotify player** with AI-powered song suggestions.
- **Drawing canvas** — supports eye-gaze drawing; the AI adds context buttons about what the student seems to be drawing.
- **Music Maker** — virtual piano with color-coded keys.
- **Web browser** — in-frame browser limited to a clinician-defined permitted-website list (subpages included). **NEW**
- **Games** (below) and the World Engine surfaces (Part 3).

Note: the AI's app registry can launch more app ids than are finished — the world-engine
prototypes are registered so they can be driven end-to-end during development. Registry
membership is not evidence a student can play something.

## Games — Playable Today
Standalone Vite projects served at `/games/<name>/`, playable directly, in the launcher, or embedded in either client, communicating over the `shared/games-bridge.ts` postMessage contract. These four are self-contained and finished.

| Game | What it is |
|---|---|
| **Space Trader** | Mine asteroids and trade up to capture the Star. A puzzle game built for eyegaze. |
| **Sandbox** | Push sand with your gaze to dig valleys and raise hills, then watch springs, rivers and plants emerge. |
| **Bubbles** | Tap to pop floating bubbles — reflex and hand-eye coordination, auto-adjusting difficulty. |
| **Musical Microbes** | Place tiny organisms (pulsers, responders, harmonizers, echoers, silencers) that interact to make generative music. No wrong notes. |

### Social Trainer **NEW**
Not a world game — an AI-driven conversation partner, so it sits outside the World Engine work below.

A procedurally-generated peer character the student practices conversation with. The peer has its own face, voice, personality and history, and reacts to how it is treated. While a session runs the AAC AI drops to silent/utterance-button mode — the student talks to the peer *through* the AI's buttons, and the peer's text replaces the AI's in the header. At the end the AI receives a debrief and discusses it warmly with the student.
- Clinician configuration: **focus skills**, **off-limits skills**, and a **challenge ceiling**.
- 19 tracked social skills — responding, asking about others, reading mood, recovering from missteps, speaking up, complimenting well, starting conversations, engaging with interests, turn-taking, staying on topic, changing topics smoothly, greetings, saying goodbye, perspective-taking, naming feelings, empathy, politeness, asking for help, saying no kindly.
- Optional **live audio voice** for the peer (more natural, less delay, higher cost).

## Accessibility & Display
- **5 levels of icon-to-text ratio** — from extra-large icons with minimal text through to icon and text at equal size.
- Parts-of-speech color coding.
- Dark/light themes; font size, high contrast, reduced animations, enhanced focus indicator.
- **12 languages** with full RTL support (Hebrew, Arabic).
- Designed for Rett Syndrome — passive input, low-effort interaction, fixation-based activation.

## Visual Feedback
- Animated avatar with emotional states (happy, sad, neutral, sleeping) that responds to the student's attention, plus a fullscreen avatar overlay.
- Face mirror showing the student's detected expressions and hand positions.
- **Intent spark and core mark** — shows where a gaze selection is forming. **NEW**
- **Energy bar**, **button busy indicator**, **processing indicators**, and connection/recording status. **NEW**
- **Sleep overlay** while resting, with wake signalling.
- **Identification badge** when a person is recognised. **NEW**
- **Update status indicator** and app version badge for the packaged app. **NEW**

## Session Behaviour & Cost Control
- **Adaptive session profiles** — an *active* profile with full prompt, full tools and high-frequency frames, and a *resting* profile with a lightweight prompt, reduced tools and aggressive context compression during inferred sleep. The model escalates back via an explicit wake action. Roughly an order-of-magnitude cost reduction during quiet periods.
- **Full Attention Mode** **NEW** — when on, camera and mic stream continuously while awake. When off (the default), video is sent only on motion and audio only on speech.
- **Startup modes** **NEW** — *quick* reuses cached session-plan sections whose input hashes still match, regenerating only stale groups; *thorough* rebuilds the plan from scratch every session.
- **Budget tiers** **NEW** — a named monthly AI-spend plan (demo through premium) scaling the caps on a multi-window meter (3-hour / 3-day / 14-day rolling). The AAC shows remaining budget per window and roughly when it refills, and throttles when exhausted.
- **Idle watchdog** and unattended-session guards so a device left running doesn't burn budget. **NEW**
- **Session debug logs** stored per session, with an in-app debug panel. **NEW**
- **Classroom mode** — one device shared across multiple students; general data about all classroom members is loaded so the AI can address group dynamics without losing per-student personalization.
- **Reconnect and resume** — a dropped session resumes rather than restarting.
- **AAC auto-update** for the packaged desktop app, with single-instance enforcement. **NEW**
- **Local storage** — optional encrypted on-device storage of session data, independently toggleable from remote storage. **NEW**

## Privacy Controls (per student)
- Gate the Monitor agent's read access to **goals/objectives**, **reports**, and **notes** independently.
- **Share AAC notes with institute** — whether the owning institute sees notes recorded during AAC sessions (interests, preferences, observations) without an explicit share grant. Cross-institute access always requires one.
- The live agents (Observer / Speaker / Board Manager) receive only an AI-curated, redacted prompt — never raw clinical data.

---

# Part 3 — The World Engine **NEW — IN DEVELOPMENT**

> **Status: not complete, and not yet a shippable student feature.** Most of what was
> previously listed as "new games" are not independently playable titles — they are
> surfaces onto one unified simulation that is still being built. **Dollhouse is the demo
> of that system**, and is the only surface currently presentable.
>
> Design docs live in `planning-docs/games/world-engine/` — read its `INDEX.md` first;
> it carries a per-document status column (LAW / SHIPPED / PARTIAL / DESIGN / SUPERSEDED).

## What it is
A single simulation engine (`shared/world-engine/`) that every world-based experience embeds,
rather than each game reimplementing a world. The long-term goal is that AAC vocabulary *is*
the command language of a living world: the student presses glyphs, and a real simulated
place responds — so language practice happens against consequences rather than against a quiz.

The engine is layered, and the layers are the honest map of what exists:

| Layer | What it covers | Roughly where it stands |
|---|---|---|
| **0 — Laws & substrate** | *A scope is an object in a vacuum* — one uniform recursive object model from a body to a town to a caravan. Space/time compression as physics. Fast-forwardable cell rules. Hierarchical cells (planet → region → town). | Core model built; several steps open. Progression regulation is design-only. |
| **1 — Language & intent** | Glyph press → `IntentFrame` → `GoalSpec`. A deterministic slot-filling parser, no LLM. Facts, questions, information-sharing, an open noun library. | The utterance spine is essentially complete. Gaps tracked in a live ledger. |
| **2 — Bodies & minds** | ~17 atomic physical primitives; one pursuit engine serving needs, commands, pooled tasks and adoption. One `walkTo`; three-layer pathfinding; attention spark as soft control. | Consolidation complete; movement shipped over five rounds. |
| **3 — Household & town** | Household duties and sims-mode needs, construction and blueprints, workstations, group activities, toys, town economy. | Built and mid-rewrite on construction. |
| **4 — Civilization & world** | Settlement emergence, resources and trade, nations and empires, imperial scale, society rules, influence and authority. | Machinery built; the realism pass is unscheduled. |
| **5 — Surface & performance** | What the student actually sees: AAC integration, board organization, icon gaps, LOD tiers, and the spirit-ladder camera/level machine. | The thinnest layer — this is the gap between "the simulation works" and "a student can play it". |

Also in the engine: planet and terrain generation, rain-fed rivers, day/night and atmosphere,
seasons, materials, creature behaviour and personality, NPC dialogue and voice, and multiplayer
as seed + clock + mutations.

## Surfaces onto the engine
None of these are finished games; they are views onto the shared world at different stages.

| Surface | What it is | State |
|---|---|---|
| **Dollhouse** | Watch over a living house as a friendly spirit. A family goes about its day inside; talk to them and direct them with sentence buttons. | **The demo of the World Engine** — the presentable surface, and the one released to date. |
| **Picnic Quest** (goal-tree player) | Explore, collect, answer and unlock your way to a goal. The first goal-tree quest. | Prototype surface, folding in. |
| **Symbol Learning** | Teaches AAC symbols by *demonstrating* them — abstract concepts (big/small) shown happening in the world, then connected to the symbol and practiced in the sentence builder. | Prototype surface, folding in. |
| **Social World** | Shared field where the student meets contacts as avatars and plays with physics toys, ferried into a live video call. | Prototype surface, folding in. |
| **Sandbox** | Shipped as a standalone game; its cell-rule system was the prototype that became the engine's substrate layer. | Playable (listed above). |

## Developer benches
Not shown to students and not student features: **World Lab** (world-file test bench),
**Cloud Lab** (sky/cloud bench), **Creature Lab**, **Seagull Dream**, **Popusim**, and
**Grand Dream** (retiring).

## Verification note
Two verification levels are used in this codebase and should not be conflated: *test-verified*
(`npm run test:engine` green) versus *GL-verified* (actually driven in a live browser). Most
recent engine work is test-verified only — a passing suite is not evidence that a student can
see or do the thing.

---

# Part 4 — Platform-Wide

## Identity & Access
- Role-based access: admin, clinician, caregiver, family.
- Invite-based onboarding with codes.
- **SSO via configurable identity providers** (SAML), with auto-provisioning and claim mapping. **NEW**
- **Two-factor authentication**, mandatory for system admins, with recovery tokens. **NEW**
- **Phone OTP** verification and SMS. **NEW**
- Password reset and session invalidation.
- **Family access scoping** — family members see a deliberately narrower slice than clinicians.

## Licensing
Per-license permission bundle: max students, max devices per student, AAC enabled, board maker, custom apps, unrestricted AI, calendar, dashboard level, expert-agent count, deep analysis, video captions, packages, insurance bridge, billing regime, and applicable compliance regimes.

## Compliance Regimes
Regimes are data, not code paths — adding one is a registry update. Currently registered: **il_moe** (Israeli Ministry of Education), **il_health**, **il_general**, **us_ferpa**, **us_hipaa**, **us_coppa**, **us_section_508**, **eu_gdpr**, **eu_en_301_549**, **uk_dfe**, **uk_pba_2018**.

## Billing & Payments
- Credit-based system with tiered credit packages.
- **Paddle** checkout for web purchases. **NEW**
- **RevenueCat** subscriptions for in-app purchase, with webhook event handling and a product catalogue. **NEW**
- Subscription plans alongside one-off credit purchases.
- **Unified usage-cost ledger** — every LLM and TTS charge fans out to the chat session, student, user, and user↔student rows, with a per-function-type breakdown per session (chat, observer, speaker, board manager, TTS, session summary, per-tool, symbol refinement, interpretation, photo analysis, deep analysis…). **NEW**

## Legal & Policy Pages
Accessibility statement, privacy policy, cookie policy, terms of service, AI policy, and a public consent-signing page.

## Data Protection
- HIPAA-oriented architecture with PHI-bounded information flow between the clinical record and the on-device AI.
- Sensitive identifiers write-only at the database layer, redacted on read.
- Encryption service for at-rest PHI columns.
- **Activity logging** with a retention cron. **NEW**
- **Student erasure** service with a scheduled job. **NEW**
- **Dropbox backup** of records to a clinician's own account. **NEW**

---

# Part 5 — Admin Backoffice

Section-gated by per-admin permission keys (`"*"` grants everything).

| Section | What it manages |
|---|---|
| **personas** | AI persona definitions available in clinician chat |
| **library** | Reference/topic library content |
| **voices** | The shared voice catalogue (ElevenLabs and prebuilt) |
| **models** | LLM model selection and per-function overrides |
| **sessions** | Session history browser across the platform |
| **cost-usage** | Cost and usage dashboard, with per-session cost breakdown and per-student budget panel **NEW** |
| **contacts** | Contact inquiries from the marketing site |
| **licenses** | License creation, permissions, and assigned students **NEW** |
| **identity-providers** | SSO provider configuration **NEW** |
| **activity-log** | Platform-wide audit trail **NEW** |
| **deep-analyses** | Queued and completed deep analyses **NEW** |
| **public-symbols** | Review and approval of publicly-listed symbols **NEW** |
| **crm** | Potential-customer pipeline, customer detail, and CRM settings **NEW** |
| **admins** | Admin users and their section permissions **NEW** |

Also platform-side: a **landing-page chatbot** for prospective customers, and a **customer support service**.

---

# Appendix — Status Notes

- **DocuSLP** — merged into Deep Analysis. A vestigial "Create Reports" nav entry and placeholder panel still exist in the client and should be removed.
- **The World Engine (Part 3)** is the largest incomplete area. Dollhouse is its demo; Picnic Quest, Symbol Learning and Social World are prototype surfaces being folded in, not independent titles. Layer 5 (what the student actually sees) is the thinnest layer.
- **Board Manager live model** — experimental toggle; runs the board agent on a live model to test latency at higher cost.
- **Glyph input translation** — marked experimental in the UI.
- **Spotify** — implemented; still light on content curation compared with YouTube.
- Several recent AAC subsystems (unattended-session guards, STT misrecognition fix, transcript-attribution trust) are **shipped in the codebase but not yet in a released build**.
