# Adding a New Language

When adding a new language to the system, update all of the following locations.

## 1. Translation Files

Create translation files in both clients by copying `en.ts` and translating the string values. Keep all keys, structure, comments, and blank lines identical to `en.ts`.

- `client/src/i18n/{code}.ts`
- `client-aac/src/i18n/{code}.ts`

The **client-aac** files import `type { Translations } from "./en"` and type the export (e.g. `export const fr: Translations = {`). The **client** files do not — just use a plain export (e.g. `export const fr = {`).

Add the language's native name to the `language` section in **every** translation file (including existing ones like `en.ts` and `he.ts`).

Run `npx tsx scripts/validate-i18n.ts` to verify consistency.

## 2. i18n Index Files

Register the new language in both index files:

- **`client/src/i18n/index.ts`** — Add import, add to `LanguageCode` type, `SUPPORTED_LANGUAGES` array, `translations` map, and re-export.
- **`client-aac/src/i18n/index.ts`** — Same. Also used by `isValidLanguageCode()` and `getLanguageByCode()`.

Set `direction: 'rtl'` for RTL languages (Arabic, Hebrew).

## 3. Language Selectors (UI)

These components have hardcoded `<SelectItem>` lists:

- `client/src/components/StudentModal.tsx` — Student primary language
- `client/src/components/admin/LicenseForm.tsx` — Institute language
- `client/src/features/SettingsPanel.tsx` — UI display language
- `client-aac/src/components/LoginModal.tsx` — AAC login preferred language

The `InstitutePanel.tsx` language selector uses `SUPPORTED_LANGUAGES` dynamically and needs no changes.

## 4. Server Memory Schema

- `server/services/memory-schema/institute-memory-schema.ts` — Add to the `primaryLanguage` enum (~line 2004) so the AI knows it's a valid option.

## 5. Google TTS Voices

- `server/services/voice/google-tts-service.ts` — Add 4 entries to `VOICE_MAP` (`{code}-man`, `-woman`, `-boy`, `-girl`) and add a name mapping to `langMap` inside `getVoiceConfig()`.

Use Neural2 voices where available, fall back to Standard. Refer to the [Google Cloud TTS voice list](https://cloud.google.com/text-to-speech/docs/voices) for available voices and language codes.

Gemini TTS (`gemini-tts-service.ts`) uses language-agnostic prebuilt voices and needs no changes.
