# Aivota — System Overview

## 1. Purpose

Aivota is an AI-driven assistive communication and education platform designed for students with significant communication impairments — initially focused on Rett Syndrome, with a roadmap extending to broader special-needs populations. The system replaces traditional static AAC (Augmentative and Alternative Communication) devices with a real-time, multimodally-aware, adaptive AI environment that both *gives* the student expressive vocabulary and *teaches* them how to use it.

## 2. Two-Client Architecture

The platform comprises two distinct client applications sharing a common backend:

- **Clinician Platform** — Used by caregivers, therapists, and teachers. Provides student-record management (medical, functional, educational), goal-setting (S.M.A.R.T. plans), event calendars, AAC board authoring, symbol library curation, contact and biometric profile management, and educational-game generation. Crucially, **every feature is operable through a natural-language chat interface**, with only a small set of high-security permission operations gated behind explicit UI.

- **Student Platform (AAC Client)** — Used directly by the student. Designed for non-verbal or minimally-verbal interaction, eye-gaze and touch input, and real-time multimodal sensing (camera + microphone). This is where the system's core technical novelty lies.

A single shared backend mediates between them, enforcing a strict information-flow boundary (described in §6).

## 3. Dual-Agent AAC Architecture

The Student Platform is driven by **two specialized AI agents that communicate with each other**, each with a distinct role, model class, and permission scope:

### 3a. Interactive Agent (real-time, multimodal)
- Implemented on a low-latency multimodal model (Gemini Live, with OpenAI Realtime as an alternate provider).
- Receives a continuous stream of camera frames, raw PCM microphone audio, and user button presses.
- Generates spoken responses, dynamically composes AAC boards, and emits structured tool calls representing communicative acts.
- Operates under one of two **mute states** (set only by the user, never by the AI):
  - *Unmuted* — the agent speaks directly to the student.
  - *Muted* — the agent remains silent.
- Operates in one of three **AI behavioral modes** (set by the AI itself, distinct from mute state):
  - *Interactive* — actively engages, teaches, plays games, advances goals.
  - *Facilitator* — passive, provides board options to facilitate communication with a third party.
  - *Standby* — low-activity holding state.

### 3b. Monitor Agent (slower, reflective)
- Implemented on a reasoning-oriented model (Claude).
- Has **read access to the clinical database** (reports, goals, plans, contacts, calendar).
- Does **not** have write access to clinical records — only to a constrained "session notes" and "incident reports" channel.
- Periodically refreshes the Interactive Agent's prompt with current goals, upcoming events, and contextual reminders.
- Performs **Deep Analysis**: periodic high-level review of accumulated session data to detect behavioral patterns, regression, or progress, surfaced back to the Clinician Platform.

The two agents communicate via a structured message-passing protocol; the Interactive Agent treats the Monitor as a privileged context source, and the Monitor cannot directly speak to the student.

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

1. **Response Board** — The Interactive Agent generates context-appropriate response buttons in real time, based on the current visual scene, conversational history, and student preferences.
2. **Sentence Builder** — When no response button fits, the student opens a parts-of-speech grid. The AI suggests the most probable next symbol based on the partially-built sentence, the student's memory profile, and the current scene.
3. **Word Finder ("20 Questions" engine)** — When the desired concept isn't in any board, a frontend-owned **deterministic narrowing engine** guides the AI through targeted clarifying questions. The narrowing state is held client-side; the AI is *constrained* by injected state rather than driving freely. Resolved concepts are persisted to the student's memory and surfaced proactively in future sessions.

This three-tier structure — generated boards, AI-assisted construction, AI-guided concept search — collapses the gap between fixed AAC vocabularies and the open-ended communicative needs of a developing user.

## 6. PHI-Bounded Permission Architecture

Because the Student Platform is always-on and multimodally observant, the system enforces a strict information-flow boundary:

- The Clinician AI may read and write the full clinical record.
- The Monitor Agent may **read** the clinical record but writes only to a non-clinical journal (session notes, incident reports).
- The Interactive Agent receives only an AI-curated, redacted prompt — never raw clinical data — automatically prepared by the Monitor Agent and reviewable by clinicians.
- Sensitive identifiers (e.g. government ID numbers) are write-only at the database layer, returned as redacted placeholders on read.
- Cross-institute sharing of student records is gated through an explicit consent and invitation flow; cross-institute reads are audit-logged separately from owned reads.

This division allows the AAC agent to behave with full situational awareness without ever exposing diagnostic or medical detail to the student or to a bystander.

## 7. Multimodal Context Pipeline

The Interactive Agent's awareness is built from several parallel sensing channels:

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

## 9. Classroom (Multi-Student) Mode

A single AAC device may be shared across multiple students. The system supports a classroom mode that loads general data about all classroom members into the session, allowing the AI to address group dynamics without losing per-student personalization.

## 10. Companion Educational Games

The platform includes a generator for **bespoke educational games** built from a set of parameterized templates and rules. Generated games run as standalone embedded applications communicating with the core AI through a shared bridge protocol. A separate **social-training game** uses an independent live AI agent to simulate conversational partners with controlled emotional expression, allowing students to practice social interaction in a safe environment.

---

## Summary of Technically Novel Contributions

1. **Dual-agent AAC architecture** with asymmetric clinical-data permissions.
2. **Real-time, multimodally-driven dynamic board generation** replacing static AAC vocabularies.
3. **Glyph composition system** with mixed canonical/custom/AI-generated symbol resolution and IP-safe refinement.
4. **Frontend-deterministic narrowing engine** guiding AI-driven concept search.
5. **PHI-bounded prompt curation** between clinical record and on-device AI.
6. **Server-authoritative biometric context injection** for live multimodal models.
7. **Engagement-adaptive session profiles** for cost-bounded always-on AI.
