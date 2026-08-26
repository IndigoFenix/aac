# Aivota — System Overview

## 1. Purpose

Aivota is an AI-driven assistive communication and education platform designed for students with significant communication impairments — initially focused on Rett Syndrome, with a roadmap extending to broader special-needs populations. The system replaces traditional static AAC (Augmentative and Alternative Communication) devices with a real-time, multimodally-aware, adaptive AI environment that both *gives* the student expressive vocabulary and *teaches* them how to use it.

## 2. Two-Client Architecture

The platform comprises two distinct client applications sharing a common backend:

- **Clinician Platform** — Used by caregivers, therapists, and teachers. Provides student-record management (medical, functional, educational), goal-setting (S.M.A.R.T. plans), event calendars, AAC board authoring, symbol library curation, contact and biometric profile management, and educational-game generation. Crucially, **every feature is operable through a natural-language chat interface**, with only a small set of high-security permission operations gated behind explicit UI.

- **Student Platform (AAC Client)** — Used directly by the student. Designed for non-verbal or minimally-verbal interaction, eye-gaze and touch input, and real-time multimodal sensing (camera + microphone). This is where the system's core technical novelty lies.

A single shared backend mediates between them, enforcing a strict information-flow boundary (described in §6).

## 3. Four-Agent AAC Architecture

The Student Platform is driven by **four specialized AI agents coordinated through a central event bus**, each with a distinct role, model class, and permission scope. Holding perception, voice, board surface, and long-term memory as separate processes — each with a small focused tool surface — substantially improves reliability over a single monolithic agent: function-call malformation, missed turns, voice-mimicry leakage, and audio safety rejections all scale with surface size, and splitting flattens them.

A central **Coordinator** owns the WebSocket to the client, the session state, and the routing table that fans events between agents. Agents never communicate directly with each other — every event passes through the Coordinator, which decides who needs to see it (context injection, user turn, or HTTP invocation).

### 3a. Observer Agent (perception and behavioral-mode steering)
- Implemented on a low-latency multimodal model with native audio + video input (Gemini Live).
- Continuously consumes camera frames and raw PCM microphone audio.
- Emits structured observation events: speech transcripts (with speaker attribution and direction — `device` / `user` / `ambient`), context updates (new person identified, gesture noted, scene change), and engagement-state transitions (rest / wake / sleep).
- Owns AI **behavioral mode** — the multimodal scene context (who is in the room, who is being addressed, whether the user is engaging the device or talking to someone else) is exactly what determines whether the AI should be in *Companion*, *Facilitator*, or *Standby* mode, so the mode tool lives on the agent with that context. The mode broadcasts to Speaker as a `[MODE]` context injection on every change.
- Recognizes **defined gestures** — clinician-configured per student in AAC Settings (name + physical description + meaning). When the student performs one toward the device, the Observer reports it and the Coordinator replays the full button-press flow: the gesture's meaning is voiced in the student's voice, Speaker replies, and the Board Manager rebuilds — communication without touching the board.
- **Never speaks, never modifies the button surface.** Pure sensing plus mode steering.

### 3b. Speaker Agent (voice)
- Implemented on the same live multimodal class as Observer but configured **text-in, audio-out** (Gemini Live native audio).
- Consumes textualized events from the Coordinator (button presses, transcripts, observations) and produces the AI's spoken responses.
- Receives the current behavioral mode passively from Observer as a `[MODE]` injection. Highly interactive in *Companion Mode*, instructed to speak only when necessary in *Facilitator Mode*.
- Can by manually disabled using the *mute* command, selected through the interface.
- Contains custom personality and student goals; handles the main conversation flow.
- **Never touches the button surface.** Voice only.

### 3c. Board Manager Agent (button surface)
- Implemented on a fast HTTP-completion model (Gemini Flash) — no Live transport.
- Stateless across invocations: the Coordinator passes the recent-events snapshot, board state, and any active builder / guessing context per call.
- Produces structured board updates (rebuild, single-button add, sidebar additions, binary-choice overlays, sentence-builder suggestions) or an explicit `no_change` when the current surface is still appropriate.
- Drives the Response Board, Sentence Builder suggestions, and Word Finder narrowing buttons (§5).

### 3d. Monitor Agent (long-term memory and supervision)
- Implemented on a reasoning-oriented model (Claude).
- Has **read access to the clinical database** (reports, goals, plans, contacts, calendar).
- Does **not** have write access to clinical records — only a constrained "session notes" and "incident reports" channel.
- Runs on a slower cadence: every ~2 minutes during active sessions, plus a forced final pass at session close that consolidates notes and writes the rolling session summary.
- Performs **Deep Analysis**: periodic high-level review of accumulated session data to detect behavioral patterns, regression, or progress, surfaced back to the Clinician Platform.
- Receives a constrained view of session events from the Coordinator and broadcasts its `[CONTEXT]` injections back to Observer / Speaker / Board Manager simultaneously to update their behavior according to long-term goals.

The Monitor is treated by the three live agents as a privileged context source, and the Monitor cannot directly speak to the student.

## 4. Glyph Composition System

Communicative output is structured as **glyphs** rather than single icons:

- A **glyph** is a composite visual unit: one **main symbol** plus zero or more **modifier symbols** (color, quantity, negation, tense, possessive, etc.).
- A **button** carries one or more glyphs forming a complete utterance.
- Symbols may originate from three sources, resolved in priority order:
  1. **Canonical symbols** — a fixed library shared across all students.
  2. **Student-specific custom symbols** — uploaded by caregivers (e.g., a photograph of the student's named pet or family member).
  3. **AI-generated symbols** — synthesized on demand when no canonical or custom symbol exists, then cached by semantic key for reuse.
- AI-generated symbols pass through an **image-prompt refinement stage** that ensures a coherent style across the platform and converts copyrighted character references into legally-distinct visual analogues before generation, allowing the student to refer to familiar media without exposing the platform to IP liability.

## 5. Multi-Path Vocabulary Access

The system provides three nested fallback paths for a student to express a concept:

1. **Response Board** — The Board Manager generates context-appropriate response buttons in real time on every conversational beat, based on the current visual scene (relayed by Observer), conversational history, and student preferences.
2. **Sentence Builder** — When no response button fits, the student opens a parts-of-speech grid. The AI suggests the most probable next symbol based on the partially-built sentence, the student's memory profile, and the current scene.
3. **Word Finder ("20 Questions" engine)** — When the desired concept isn't in any board, a frontend-owned **deterministic narrowing engine** guides the AI through targeted clarifying questions. The narrowing state is held client-side; the AI is *constrained* by injected state rather than driving freely. Resolved concepts are persisted to the student's memory and surfaced proactively in future sessions.

This three-tier structure — generated boards, AI-assisted construction, AI-guided concept search — collapses the gap between fixed AAC vocabularies and the open-ended communicative needs of a developing user.

## 6. PHI-Bounded Permission Architecture

Because the Student Platform is always-on and multimodally observant, the system enforces a strict information-flow boundary:

- The Clinician AI may read and write the full clinical record.
- The Monitor Agent may **read** the clinical record but writes only to a non-clinical journal (session notes, incident reports).
- The Observer / Speaker / Board Manager agents work from an AI-curated prompt prepared by the Monitor Agent and reviewable by clinicians, rather than from the clinical record directly.
- Sensitive identifiers (e.g. government ID numbers) are treated as write-only on the AI/memory-schema path: the value is replaced with a `[REDACTED]` placeholder on read, and that placeholder is ignored on write, so no ID number reaches a prompt. This is an API-response mask, not database-level encryption, and it is applied on the AI path — the clinician-facing REST endpoints still return the raw value to an authorized user.
- Cross-institute sharing of student records is gated through an explicit consent and invitation flow. Cross-institute and system-admin reads are audit-logged as such; owned reads are logged too, by a per-request read audit over the student-scoped GET surface.

This division is what lets the AAC agents behave with full situational awareness while working from a curated view rather than the clinical record.

> **Known gap (2026-08, tracked).** One field currently breaks the rule above:
> `medical_records.primary_diagnosis` is fetched ungated — no `allowReadReports`
> toggle, no `status='final'` filter, no institute-visibility join, no audit — and
> rendered into the shared descriptor block of the Observer, Speaker **and** Board
> Manager system prompts ("a 12 year old girl with \<diagnosis\>"). The Speaker is
> a native-audio agent that talks out loud in a room that may contain bystanders,
> and its only disclosure control there is a soft prompt instruction. The
> diagnosis has no evident function for the Board Manager (a button-layout
> generator) or the Observer (perception). Until this is gated, do not read this
> section as a guarantee that no diagnostic detail can reach the live agents. See
> `docs/SECURITY_ARCHITECTURE.md` §12.1 item 17.

## 7. Multimodal Context Pipeline

The Observer's awareness — which it relays to Speaker and Board Manager via the Coordinator — is built from several parallel sensing channels:

- **Camera stream** — frames passed to the live model continuously, gated by an activity-driven detection pipeline (replacing fixed-interval polling).
- **Microphone stream** — raw PCM audio for ambient awareness and direct speech-from-others recognition.
- **Server-side face recognition** — facial descriptors are matched authoritatively on the server against the student's contact registry; matched identities are injected into the model's context as a `[PEOPLE PRESENT]` block. The live model never performs identity inference itself.
- **Calendar and event context** — upcoming events are surfaced into the prompt by the Monitor Agent in advance.
- **Guessing-state injection** — when in Word Finder mode, the current narrowing state is injected each turn.

## 8. Adaptive Session Profiles

The system detects student engagement state and switches between session profiles to balance responsiveness with operational cost:

- **Active profile** — full prompt, full tool set, high-frequency frame analysis.
- **Resting profile** — lightweight prompt, reduced tool surface, aggressive context compression, used during inferred sleep or quiet periods. The model escalates back to active via an explicit wake action.

This profile-switching reduces always-on multimodal AI cost by approximately an order of magnitude during quiet periods without sacrificing the ability to respond when the student initiates.

## 8a. Usage-Cost Ledger

All LLM and TTS spend funnels through a single ledger (`server/services/credit-ledger.ts`). Every charge fans out to the chat session, student, user, and user↔student rows, and each session additionally accumulates a per-function-type JSON breakdown (`chat_sessions.cost_breakdown`: chat, observer, speaker, board-manager, tts, session-summary, tool:\<name\>, symbol-refinement, interpretation, photo-analysis, deep-analysis, …). The AAC path charges via `DualAgentService.trackLiveUsage/trackHttpUsage/trackTtsUsage`; the clinician chat via the message manager's `onCreditsUsed` callback; standalone services call the ledger directly. The OpenAI image-generation step of symbol creation is intentionally not billed.

## 9. Classroom (Multi-Student) Mode

A single AAC device may be shared across multiple students. The system supports a classroom mode that loads general data about all classroom members into the session, allowing the AI to address group dynamics without losing per-student personalization.

## 10. Companion Educational Games

The platform includes a generator for **bespoke educational games** built from a set of parameterized templates and rules. Generated games run as standalone embedded applications communicating with the core AI through a shared bridge protocol. A separate **social-training game** uses an independent live AI agent to simulate conversational partners with controlled emotional expression, allowing students to practice social interaction in a safe environment.

---

## Summary of Technically Novel Contributions

1. **Four-agent AAC architecture** (Observer / Speaker / Board Manager / Monitor) with asymmetric clinical-data permissions and a star-topology Coordinator that lets each live agent specialize on a small, reliable tool surface.
2. **Real-time, multimodally-driven dynamic board generation** replacing static AAC vocabularies.
3. **Glyph composition system** with mixed canonical/custom/AI-generated symbol resolution and IP-safe refinement.
4. **Frontend-deterministic narrowing engine** guiding AI-driven concept search.
5. **PHI-bounded prompt curation** between clinical record and on-device AI.
6. **Server-authoritative biometric context injection** for live multimodal models.
7. **Engagement-adaptive session profiles** for cost-bounded always-on AI.
