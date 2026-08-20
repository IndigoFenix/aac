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
Production (`main`) deploys to AWS ECS Fargate via `.github/workflows/deploy.yml` (since 2026-08-20). `staging` is NOT on AWS — it runs on Render. The old Lambda path (`deploy-lambda.yml`, `terraform/lean.tfvars`, `server/app.lambda.ts`) is kept as a manual rollback only; don't add features to it.

Terraform has three profiles layered on `terraform/terraform.tfvars`: `ecs-lean.tfvars` (current: lean security, 1 task), `hipaa.tfvars` (full compliance: WAF, CloudTrail, VPC endpoints, Redis, multi-task — switch by changing `DEFAULT_PROFILE` in deploy.yml) and the legacy `lean.tfvars` (Lambda). Any new toggle must work under all three, and anything that must be compliant later should be gated by an existing flag rather than hardcoded. The ECS task loads the entire `app-secrets` JSON at boot, so a new secret key needs no Terraform change. See docs/INFRASTRUCTURE.md.

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

The sentence builder's vocabulary is DATA, not call sites — no `t()` call ever names
`aac.glyph.apple` literally — so both scanners above look straight past a `shared/glyph-registry.ts`
item nobody translated (the builder then renders the raw English key on a Hebrew board).
`npm run validate-glyphs` (scripts/validate-glyph-registry.ts) closes that gap and audits bundled
artwork in the same pass: missing/dead/blank `aac.glyph.*` keys and non-Latin values still in
English (errors), plus the art queue — emoji-only items, `directional: true` items with no
mirrorable art, dangling `imagePath`s, missing `-male`/`-female` gender variants (warnings).
`npm run validate-glyphs:art` lists the full art backlog; `--strict` fails on it. The
translation half is also a jest suite (`server/tests/glyph-registry.test.ts`), so it gates merges.

To add glyph keys, use `npx tsx scripts/i18n-insert-keys.ts <input.json>` — it writes all 11
locale files in one deterministic pass so the identical-line invariant survives. Supply each
locale's value in the spec (anything omitted is seeded with English and marked `// TODO-i18n`),
and use `"after": "<siblingKey>"` to keep the `aac.glyph` block in registry order.

The builder has a SECOND vocabulary none of the above touches: the world-engine's own grammar
layer (`shared/world-engine/interaction/lang/{en,he,es,pt}.ts`). It fails SILENTLY — `baseWord()`
returns the raw head when a word has no lexeme, and a head IS an English word, so English looks
perfect while Hebrew/Spanish/Portuguese put an English word on the child's board. (`validate-i18n`
compares locale files to each other and `scan:i18n` compares them to `t()` call sites; this path
has neither a locale file nor a `t()` call.) That bug was hand-patched at least three times before
anyone saw the pattern. `npm run validate-builder-lexicon`
(scripts/validate-builder-lexicon.ts) now derives every head the builder can surface — category
tabs, the `defaultBuilderNouns` things tab, the `AXIS_WORDS` modifier rail, and the group chips —
and checks all four SHIPPED rulesets can say it. `:report` shows everything without failing.
The reachable set lives in `interaction/intent/builder-coverage.ts` and is shared with the jest
gate (`server/tests/world-engine/builder-lexicon.test.ts`), so report and gate cannot disagree.
Only en/he/es/pt are checked: the other seven app locales have no ruleset and fall back to
English wholesale by design (lang/index.ts).

⚠️ A GAME-SPEC OBJECT'S TRANSLATIONS LIVE ONLY ON ITS SPEC ROW (`words: ItemWords` — stations,
programs, species, pools; `content/words.ts` joins them). Never add an item word to a central
lang file — the no-overlap pin in `server/tests/world-engine/lexicon-spec-words.test.ts` fails,
and that test also pins spec-head locale coverage so a spec row cannot invent a word for a locale
that never had one. The central files keep only grammar, verbs, adjectives, function words and
the CORE_CONCEPTS.

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

### Headless play verification — world-engine TEXT MODE (the AI's testing method)
To verify world-engine behavior at PLAY level without a browser, drive text mode:
`npm run world:text -- --seed <n> [--dt 1/20] [--script cmds.txt] [--cheats]`.
It boots the REAL quest-host headless (no GL/DOM; sim behavior untouched) and speaks a
tagged-line protocol — `scene look self board say press build go approach watch wait help`
— presenting only what a sighted player would see, so use it to find UX gaps (unreachable
buttons, garbled creature lines), not just crashes. Transcripts land in `transcripts/`
and are byte-identical below the `# ───` fence for the same build+seed+commands — diff
them for behavioral regressions; a transcript's `> ` lines replay via `--script`.
`--cheats` unlocks `/probe /convos /scope /stock /carry /truth` (output goes to the
`.cheats.log` sidecar and marks the transcript — don't use it for UX-gap findings).
Long play arcs belong HERE, not in jest: any suite that value-imports quest-host pays a
heavy per-worker transform tax. Laws and command grammar:
`planning-docs/games/world-engine/text-mode.md`.

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