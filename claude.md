# Aivota project

## Purpose and goals
This is a project to help students with special needs communicate, interact with the world and learn.
Currently we are focusing on an AAC platform for children with Rett's Syndrome. We plan to expand this to serve a wide variety of educational needs.

## Structure
The platform contains two separate clients: The regular (clinician) client, used by clinicians and caretakers, and the AAC client, used by the students themselves. Both share a common server.
All calls to the API from the client need to use the apiRequest function.
The project uses ES Modules, don't use __dirname

Further docs available in ai-docs. Check the relevant document before working on a project.
ai-docs/main.md - The Clinician and AAC systems

We are also making games, which are largely separate from the main part of the system, though they are designed to interact with the AI. Before working on a game, check that game's instructions folder.

## AWS Strategy
We have 2 separate AWS systems which are served from github actions. Currently we are using the Lambda system to save costs. Later we will begin using the ecs system. Updates made to the Lambda system should be made to the ecs system as well, apart from using Lambda vs ECS.

There are 2 different deployment paths in Terraform. The lightweight one we are using now is to save costs. There is also a path with higher security (HIPAA compliance) that we will enable once we are ready to move to production. Keep both in mind when handling AWS systems.

## Translations
All parts of the system use i18n translations with a t() function for multilingual support.
Whenever the term "student" is used, we use ts() instead, which swaps "student" for "child" when relevant.
If you add any strings to the client, add their translations.
If you see any missing translations on the client while working, add them. (Except for debug-related features)
All translation files should have identical keys on identical lines.
Use the scripts/validate-i18n.ts to check for this after editing translation files.

## Testing
At the end of each minor task, check to see if we have a testing suite set up for that part of the system. If not, create one. If so, test it.
Run a full npm test after completing major tasks that touch a large part of the system.
The npm test does not call the real LLM - we use a mock LLM for this instead.
Don't run test:llm or test:ai without being instructed to.

## General Behaviors
Use logs whenever needed - preferably logging to a file rather than the console.
If you try to fix an error and fail, don't hesitate to create a log that will help uncover the issue. The log can always be removed when the issue is fixed.

See docs/INFRASTRUCTURE.md for AWS architecture.

## Security
See docs/SECURITY_ARCHITECTURE.md for security rules. Follow these principles. 

When considering a change that would require a change in security architecture, check ministry-of-education-approval in planning-docs to check against the high-level principles we must operate under.


# High-Level Architecture and Concepts

## Goal

A fully-contained AI-powered system for special-needs education.

### Clinician Platform

Used by caretakers

- Chat-driven natural language interface - all features (except for a few high-security access permissions) can be managed directly through the AI chat
- Student Report management
    - Stores medical, functional, and educational reports
- Student Plan management
    - Set S.M.A.R.T. goals for students
- Events Calendar
    - Define events (Accessible by the AAC monitor)
- Prebuilt AAC board generator and editor
    - Boards have a "usage hint" - when in that situation, the AAC will load the board
- Symbol Editor
    - Upload student-specific symbols that can be used by the AAC
- Student Contacts manager
    - Assign contacts to students, along with profile pictures and biometric data that can be used for facial recognition by the AAC
- Educational Game generator
    - Uses a set of premade rules and templates to generate games on command for teaching class subjects
    - Designed to work out of the box with minimal testing or editing
- Automatic AAC prompt management
    - The clinician AI automatically updates the AAC prompt to account for student reports and define current goals
    - AI is instructed not to expose high-security information such as medical diagnoses to the AAC, except for what it needs to know
    - User can review this prompt to double check
- Deep Analysis Mode
    - Periodically reviews all data using high-level AI (Claude Opus) to find behavioral patterns, uses this to generate reports and make future plans

### Student Platform (AAC)

Used by students

- Dual-Agent architecture - 2 specialized agents that communicate with each other
    - Slow, smart "monitor" agent manages long-term memory, goal-setting and decision-making (Claude)
        - Reads from the same database used on the clinician platform
        - Enriches the existing prompt based on recent and upcoming events
        - Cannot write directly to the clinician platform database (security risk), but can take session notes and leave incident reports
    - Multimodal "interactive" agent manages the interface and communicates with the student in real-time (Gemini Live)
        - Dynamically generates AAC boards
            - Observes surroundings through a camera and listens through a microphone
            - Adds buttons to boards based on context
            - Glyph System
                - Each button represents a whole response, comprised of a set of Glyphs
                - A Glyph represents a phrase, consisting of a main symbol along with one or more modifier symbols
                - Symbols may be canonical (using emojis as placeholders for now), custom per-student, or generated
                    - Generated symbols are AI-generated in real-time when needed and are cached by key on a database
            - Sentence Builder
                - Student may open this when their response is not available in the main response board
                - Works like a traditional AAC board with parts of speech, using the same glyph system
                - AI dynamically generates suggestions for the next symbol based on its memory of the student and their preferences
            - Word Finder
                - Student may open this when a word is not available in the main response board or the sentence builder
                - AI asks questions to narrow down the concept the student is looking for (like a game of 20 questions)
                - AI remembers the result and will suggest it in the future when appropriate
        - 2 active modes, automatically switches based on context:
            - *Interactive Mode:* Talks with the student directly. Speaks and provides response boards for its own questions. Encourages the student to progress on their goals when appropriate. Education-oriented personality, remembers preferences but avoids forming personal relationships. Can play games with student when appropriate.
            - *Facilitator Mode:* Facilitates communication between student and another person. Remains silent and provides context-appropriate boards allowing the student to respond to questions or talk about their own needs and interests.