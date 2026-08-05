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
Use `npm run validate-i18n` to check for this after editing translation files.

To find untranslated text, use `npm run scan:i18n` (scripts/scan-i18n-coverage.ts). It checks the
translation files against the *code* rather than against each other: t()/ts() keys missing from
en.ts, hardcoded JSX text and placeholder/title/aria-label attributes, toast copy, files that
hand-roll localization with a `language === 'he' ? … : …` ternary, server `error:CODE` responses
with no client `errors.CODE`, and locale values still byte-identical to English.
`npm run scan:i18n:keys` runs only the two hard-error checks (exit 1 on failure — CI-friendly);
`npm run scan:i18n:report` writes the full findings to planning-docs/i18n-coverage-report.md.
Suppress a false positive with an `i18n-ignore` comment on the line or the line above it.

Note: `t()` returns the key itself when a key is missing, which is truthy — so the
`t('x') || 'Fallback'` idiom is dead code. The fallback never renders; the raw key does.

## Testing
At the end of each minor task, check to see if we have a testing suite set up for that part of the system. If not, create one. If so, test it.
Run a full npm test after completing major tasks that touch a large part of the system.
The npm test does not call the real LLM - we use a mock LLM for this instead.
Don't run test:llm or test:ai without being instructed to.

### Test layout & fast paths (avoid the ~25-min full `npm test` for routine work)
Tests split by DB dependency — a DB-backed test needs jest's `globalSetup` (Postgres + Drizzle migrate); pure tests don't. Prefer the narrowest fast path, and use `-- <word>` to slice any of them (single word only — a multi-term `a|b` pattern breaks on Windows cmd.exe):
- `npm run test:engine` — `server/tests/world-engine/` (anything importing `@shared/world-engine`). DB-free, the fastest domain. Put new world-engine tests in that folder.
- `npm run test:unit` — everything EXCEPT `integration/`. DB-free (`jest.config.unit.js` drops globalSetup). The pure-logic surface (board/agent/glyph/speech/prompt units + world-engine + mocked-LLM). ~13 min full; slice it.
- `npm run test:integration` — `server/tests/integration/` only (Postgres/API). Run when touching DB/API.
- `npm test` — the whole suite (both). Use before major merges.
A test that needs the DB belongs in `integration/` (so `test:unit` can stay DB-free) — move it there rather than restoring globalSetup.

## Databases
DO NOT, UNDER ANY CIRCUMSTANCE, AUTHOR DATABASE MIGRATION FILES YOURSELF.
Edit the schema, then use db:generate to create the files. Otherwise you will mess up the system.

## General Behaviors
Use logs whenever needed - preferably logging to a file rather than the console.
If you try to fix an error and fail, don't hesitate to create a log that will help uncover the issue. The log can always be removed when the issue is fixed.

See docs/INFRASTRUCTURE.md for AWS architecture.

## Security
See docs/SECURITY_ARCHITECTURE.md for security rules. Follow these principles. 

When considering a change that would require a change in security architecture, check ministry-of-education-approval in planning-docs to check against the high-level principles we must operate under.


# Architecture and Concepts

## Goal

A fully-contained AI-powered system for special-needs education.

### Architecture

Found in docs/SYSTEM_OVERVIEW.md

### Prompt Writing

Consult docs/PROMPT_WRITING.md before writing or updating any LLM-facing strings.

## IMPORTANT: Multi-Agent AAC system update

Previously, the AAC used a two-agent architecture (Interactive Agent + Monitor Agent). We have since split the Interactive Agent into 3 distinct agents (Observer, Speaker, and Board Manager), along with the Monitor. We are leaving the old system in, in case a better live-chat model is developed, but for now we are only using the 4-agent system. Don't get them mixed up, and make sure to update any notes you have referencing the Interactive Agent accordingly.

## AAC Construction Strategy

The AAC is distributed as a standalone app. In order to make tweaks to the AI logic without forcing the users to constantly update, aim to have logic systems live mainly on the server, with the client serving mainly an input and display engine. Make client-side displays flexible so that they can consume and display a wide variety of information from the server.
- Caveat: Where the client is used to filter irrelevant data and reduce I/O load, it is worthwhile to store that logic on the client.