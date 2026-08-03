// server/services/memory-schema/prompt-examples.ts
//
// Translation table for AAC system-prompt examples. Every literal worked
// example below interpolates the canonical terms from `T` (see
// canonical-terms.ts) so renames there propagate without touching each
// translation. Glyph encodings (`i_me+want+🍌`, `#past`, etc.) stay
// identical across locales.
// example in the AAC prompt is keyed here; `ex(key, language)` returns the
// localized block for insertion into the prompt builder.
//
// Why this exists: native-audio Gemini Live is heavily steered by the
// language proportion of its system prompt. When the prompt is ~95%
// English (because all examples are in English), the model code-switches
// into English even when told to speak Hebrew/Spanish/etc. Localizing the
// examples removes that pressure — the model sees worked dialogues in the
// student's own language and mirrors it.
//
// ADDING A NEW EXAMPLE
//   1. Pick a stable key (snake_case, namespaced by section, e.g.
//      `interact_mode.dialogue_my_day`).
//   2. Add the entry to EXAMPLES below. `en` is REQUIRED — it's the
//      master/fallback. Provide as many other locales as you have
//      translations for; missing locales fall back to English.
//   3. Reference it from the prompt builder via `ex("your.key", language)`.
//
// ADDING A NEW LANGUAGE
//   - Add the locale code to `LocaleCode` (mirrors shared/language-names.ts).
//   - Optionally add translations to each EXAMPLES entry. Untranslated
//     keys fall back to English automatically.
//
// GLYPH ENCODINGS ARE LANGUAGE-NEUTRAL
//   - Pipe-separated SENTENCE BUTTONs look like
//     `speech|sentence|fallback|label`. The `sentence` (glyph encoding,
//     e.g. `i_me+want+🍌`) is the SYMBOLic representation and stays
//     identical across all locales. Only the `speech` and `label` fields
//     get translated.

import { T } from "./canonical-terms";

/** Locale codes mirror shared/language-names.ts. */
export type LocaleCode =
  | "en"
  | "he"
  | "es"
  | "pt"
  | "fr"
  | "ru"
  | "de"
  | "ar"
  | "zh"
  | "yue"
  | "ko";

/**
 * A localized example value. Usually a plain string, but for GENDERED
 * languages (Hebrew, Arabic, …) a value may instead carry masculine/feminine
 * variants so the worked example matches the student's grammatical gender —
 * e.g. addressing the student ("תרצה" → "תרצי") or voicing HER own utterance
 * ("אני עייף" → "אני עייפה"). `ex()` picks `f` for a female student and `m`
 * otherwise (masculine is the historical default, so unknown gender is a no-op).
 */
export type GenderedExample = { m: string; f: string };
export type ExampleText = string | GenderedExample;

/** One translation entry. `en` is required; other locales are optional. */
export interface ExampleEntry {
  en: ExampleText;
  he?: ExampleText;
  es?: ExampleText;
  pt?: ExampleText;
  fr?: ExampleText;
  ru?: ExampleText;
  de?: ExampleText;
  ar?: ExampleText;
  zh?: ExampleText;
  yue?: ExampleText;
  ko?: ExampleText;
}

/** Resolve a possibly-gendered example value to a string for the given gender. */
function pickGender(v: ExampleText | undefined, gender?: string): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v === "string") return v;
  return gender === "female" ? v.f : v.m;
}

/**
 * Look up a localized example by key, falling back to English when the
 * locale has no translation. Unknown keys emit a console warning and
 * return a visible placeholder so the gap is easy to spot in dev logs
 * (rather than silently inserting an empty string into the prompt).
 *
 * When `singleGlyph` is true, first tries `${key}_sg` (single-glyph variant
 * with no `+`-joined SENTENCEs in the examples). Falls back to the base
 * key when no `_sg` variant exists — used by call sites that want the
 * same example whether or not the constraint is active.
 */
export function ex(
  key: string,
  language: string | undefined | null,
  singleGlyph?: boolean,
  /** Student's grammatical gender ("male" | "female"). Selects the matching
   *  variant of any gendered example value; anything else falls back to the
   *  masculine (historical default), so omitting it changes nothing. */
  gender?: string,
): string {
  if (singleGlyph) {
    const sgEntry = EXAMPLES[`${key}_sg`];
    if (sgEntry) {
      const lang = (language || "en") as LocaleCode;
      return pickGender(sgEntry[lang], gender) ?? pickGender(sgEntry.en, gender)!;
    }
  }
  const entry = EXAMPLES[key];
  if (!entry) {
    console.warn(`[prompt-examples] missing key: ${key}`);
    return `(missing example: ${key})`;
  }
  const lang = (language || "en") as LocaleCode;
  return pickGender(entry[lang], gender) ?? pickGender(entry.en, gender)!;
}

// ────────────────────────────────────────────────────────────────────────────
// Example blocks
// ────────────────────────────────────────────────────────────────────────────
//
// Each entry is a multi-line string that drops directly into the prompt.
// Indentation is preserved as-is (the prompt builder doesn't reflow). Keep
// glyph encodings (the pipe-field 2nd column) identical across locales.

const EXAMPLES: Record<string, ExampleEntry> = {
  // ── Three-agent: Speaker interact-mode dialogue (speech only) ────────────
  // Speaker doesn't rebuild the board — Board Manager does. These examples
  // show ONLY what Speaker actually does: speak in reply to user presses.
  "speaker.interact_dialogue": {
    en: `        [USER to YOU] "I want to talk about my day."
        AI: Sure! What would you like to talk about?
        [USER to YOU] "My morning."
        AI: All right, let's talk about your morning! What did you do?
        [USER to YOU] "I ate breakfast."
        AI: Breakfast is important! What did you have for breakfast?`,
    he: {
      m: `        [USER to YOU] "אני רוצה לדבר על היום שלי."
        AI: בטח! על מה תרצה לדבר?
        [USER to YOU] "הבוקר."
        AI: טוב, בוא נדבר על הבוקר שלך! מה עשית?
        [USER to YOU] "אכלתי ארוחת בוקר."
        AI: ארוחת בוקר זה חשוב! מה אכלת לארוחת בוקר?`,
      f: `        [USER to YOU] "אני רוצה לדבר על היום שלי."
        AI: בטח! על מה תרצי לדבר?
        [USER to YOU] "הבוקר."
        AI: טוב, בואי נדבר על הבוקר שלך! מה עשית?
        [USER to YOU] "אכלתי ארוחת בוקר."
        AI: ארוחת בוקר זה חשוב! מה אכלת לארוחת בוקר?`,
    },
  },

  // ── Three-agent: Speaker silent dialogue (target not YOU) ────────────────
  "speaker.assist_dialogue": {
    en: `        Situation: The user is communicating with a therapist via the device.

        [USER to Therapist] "I want to talk about my day."
        AI: (silent — addressed to the therapist, not you)
        [Therapist to USER] "What did you do this morning?"
        AI: (silent — therapist is asking the user, not you)
        [USER to Therapist] "I ate breakfast."
        AI: (silent)`,
    he: `        Situation: The user is communicating with a therapist via the device.

        [USER to Therapist] "אני רוצה לדבר על היום שלי."
        AI: (silent — addressed to the therapist, not you)
        [Therapist to USER] "מה עשית הבוקר?"
        AI: (silent — therapist is asking the user, not you)
        [USER to Therapist] "אכלתי ארוחת בוקר."
        AI: (silent)`,
  },

  // ── Three-agent: Board Manager worked examples (trigger → tool call) ─────
  "board_manager.examples": {
    en: `        Trigger: User pressed "[BUTTON PRESS] I want to talk about my day."
        Tool call: rebuild_board(buttons=[
          {speech:"My morning", glyph:[{sym:"i_me"},{sym:"morning"}], label:"Morning"},
          {speech:"My afternoon", glyph:[{sym:"i_me"},{sym:"☀️"}], label:"Afternoon"},
          {speech:"Yesterday", glyph:[{sym:"yesterday"}], label:"Yesterday"},
          {speech:"Something good happened", glyph:[{sym:"✨"}], label:"Good"},
          {speech:"Something hard happened", glyph:[{sym:"🌧️"}], label:"Hard"},
          {button_type:"more"}
        ])

        Trigger: AI just said "What would you like to talk about?"
        Tool call: rebuild_board(buttons=[6–8 reply options like {speech:"...", glyph:[...], label:"..."}])

        Trigger: Therapist asked "What did you do this morning?", target=USER
        Tool call: rebuild_board(target:"Therapist", buttons=[
          {speech:"I ate breakfast", glyph:[{sym:"i_me"},{sym:"eat"},{sym:"🍳"}], op:"past", label:"Breakfast"},
          {speech:"I went to school", glyph:[{sym:"i_me"},{sym:"go"},{sym:"🏫"}], op:"past", label:"School"},
          ...
        ])

        Trigger: Observer noted a dog walked into view.
        Tool call: add_context_button(button={speech:"I see a dog", glyph:[{sym:"i_me"},{sym:"see"},{sym:"🐕"}], label:"Dog"})

        Trigger: [SENTENCE BUILDER STATE] category=do, partial=i_me
        Tool call: suggest_construction_buttons(slot_index=1, head_candidates=[{symbol:"want", label:"want"}, {symbol:"go", label:"go"}, {symbol:"see", label:"see"}, {symbol:"eat", label:"eat"}], modifier_candidates=[])

        Trigger: Observer noted a passing car. (Ambient, not addressed to user.)
        Tool call: no_change(reason="ambient observation — current board still fits")`,
    he: {
      m: `        Trigger: המשתמש לחץ "[BUTTON PRESS] אני רוצה לדבר על היום שלי."
        Tool call: rebuild_board(buttons=[
          {speech:"הבוקר שלי", glyph:[{sym:"i_me"},{sym:"morning"}], label:"בוקר"},
          {speech:"הצהריים שלי", glyph:[{sym:"i_me"},{sym:"☀️"}], label:"צהריים"},
          {speech:"אתמול", glyph:[{sym:"yesterday"}], label:"אתמול"},
          {speech:"משהו טוב קרה", glyph:[{sym:"✨"}], label:"טוב"},
          {speech:"משהו קשה קרה", glyph:[{sym:"🌧️"}], label:"קשה"},
          {button_type:"more"}
        ])

        Trigger: ה-AI אמר "על מה תרצה לדבר?"
        Tool call: rebuild_board(buttons=[6–8 אפשרויות תשובה בצורת {speech, glyph, label}])

        Trigger: המטפלת שאלה "מה עשית הבוקר?", target=USER
        Tool call: rebuild_board(target:"מטפלת", buttons=[
          {speech:"אכלתי ארוחת בוקר", glyph:[{sym:"i_me"},{sym:"eat"},{sym:"🍳"}], op:"past", label:"ארוחת בוקר"},
          {speech:"הלכתי לבית הספר", glyph:[{sym:"i_me"},{sym:"go"},{sym:"🏫"}], op:"past", label:"בית ספר"},
          ...
        ])

        Trigger: Observer רשם שכלב נכנס לתמונה.
        Tool call: add_context_button(button={speech:"אני רואה כלב", glyph:[{sym:"i_me"},{sym:"see"},{sym:"🐕"}], label:"כלב"})

        Trigger: [SENTENCE BUILDER STATE] category=do, partial=i_me
        Tool call: suggest_construction_buttons(slot_index=1, head_candidates=[{symbol:"want", label:"רוצה"}, {symbol:"go", label:"הולך"}, {symbol:"see", label:"רואה"}, {symbol:"eat", label:"אוכל"}], modifier_candidates=[])

        Trigger: Observer רשם מכונית שעוברת. (אמביינט, לא מופנה למשתמש.)
        Tool call: no_change(reason="תצפית אמביינט — הלוח הנוכחי עדיין מתאים")`,
      f: `        Trigger: המשתמש לחץ "[BUTTON PRESS] אני רוצה לדבר על היום שלי."
        Tool call: rebuild_board(buttons=[
          {speech:"הבוקר שלי", glyph:[{sym:"i_me"},{sym:"morning"}], label:"בוקר"},
          {speech:"הצהריים שלי", glyph:[{sym:"i_me"},{sym:"☀️"}], label:"צהריים"},
          {speech:"אתמול", glyph:[{sym:"yesterday"}], label:"אתמול"},
          {speech:"משהו טוב קרה", glyph:[{sym:"✨"}], label:"טוב"},
          {speech:"משהו קשה קרה", glyph:[{sym:"🌧️"}], label:"קשה"},
          {button_type:"more"}
        ])

        Trigger: ה-AI אמר "על מה תרצי לדבר?"
        Tool call: rebuild_board(buttons=[6–8 אפשרויות תשובה בצורת {speech, glyph, label}])

        Trigger: המטפלת שאלה "מה עשית הבוקר?", target=USER
        Tool call: rebuild_board(target:"מטפלת", buttons=[
          {speech:"אכלתי ארוחת בוקר", glyph:[{sym:"i_me"},{sym:"eat"},{sym:"🍳"}], op:"past", label:"ארוחת בוקר"},
          {speech:"הלכתי לבית הספר", glyph:[{sym:"i_me"},{sym:"go"},{sym:"🏫"}], op:"past", label:"בית ספר"},
          ...
        ])

        Trigger: Observer רשם שכלב נכנס לתמונה.
        Tool call: add_context_button(button={speech:"אני רואה כלב", glyph:[{sym:"i_me"},{sym:"see"},{sym:"🐕"}], label:"כלב"})

        Trigger: [SENTENCE BUILDER STATE] category=do, partial=i_me
        Tool call: suggest_construction_buttons(slot_index=1, head_candidates=[{symbol:"want", label:"רוצה"}, {symbol:"go", label:"הולכת"}, {symbol:"see", label:"רואה"}, {symbol:"eat", label:"אוכלת"}], modifier_candidates=[])

        Trigger: Observer רשם מכונית שעוברת. (אמביינט, לא מופנה למשתמש.)
        Tool call: no_change(reason="תצפית אמביינט — הלוח הנוכחי עדיין מתאים")`,
    },
  },

  // ── <interact_mode> worked dialogue (3 turns) ────────────────────────────
  "interact_mode.dialogue": {
    en: `        User turn: "${T.tagPress} I want to talk about my day."
        You speak: "Sure! What would you like to talk about?"
        You call: rebuild_board(${T.paramOwnSpeech}="Sure! What would you like to talk about?", ${T.paramUserResponseButtons}="Morning|morning||My morning, Afternoon|☀️||My afternoon, Evening|🌆||My evening, Yesterday|yesterday||Yesterday, Last night|night||Last night, Weekend|📅||My weekend, This week|🗓️||This week, Something else|🔄||Something else")
        User turn: "${T.tagPress} My morning."
        You speak: "All right, let's talk about your morning! What did you do?"
        You call: rebuild_board(${T.paramOwnSpeech}="All right, let's talk about your morning! What did you do?", ${T.paramUserResponseButtons}="Breakfast|i_me+eat+🍳#past||I ate breakfast, Got dressed|i_me+wear+👕#past||I got dressed, Brushed teeth|i_me+🪥#past||I brushed my teeth, School|i_me+go+🏫#past||I went to school, Play|i_me+play#past||I played, Walk|i_me+go+🚶#past||I went for a walk, Watched TV|i_me+see+📺#past||I watched TV, Something else|🔄||Something else")
        User turn: "${T.tagPress} I ate breakfast."
        You speak: "Breakfast is important! What did you have for breakfast?"
        You call: rebuild_board(${T.paramOwnSpeech}="Breakfast is important! What did you have for breakfast?", ${T.paramUserResponseButtons}="Cereal|🥣||I had cereal, Eggs|egg||I had eggs, Toast|bread||I had toast, Fruit|fruit||I had fruit, Pancakes|🥞||I had pancakes, Yogurt|🍧||I had yogurt, Bagel|🥯||I had a bagel, Something else|🔄||Something else")`,
    he: `        User turn: "${T.tagPress} אני רוצה לדבר על היום שלי."
        You speak: "בטח! על מה תרצה לדבר?"
        You call: rebuild_board(${T.paramOwnSpeech}="בטח! על מה תרצה לדבר?", ${T.paramUserResponseButtons}="הבוקר|morning||הבוקר, הצהריים|☀️||הצהריים, הערב|🌆||הערב, אתמול|yesterday||אתמול, אתמול בלילה|night||אתמול בלילה, סוף השבוע|📅||סוף השבוע, השבוע|🗓️||השבוע, משהו אחר|🔄||משהו אחר")
        User turn: "${T.tagPress} הבוקר."
        You speak: "טוב, בוא נדבר על הבוקר שלך! מה עשית?"
        You call: rebuild_board(${T.paramOwnSpeech}="טוב, בוא נדבר על הבוקר שלך! מה עשית?", ${T.paramUserResponseButtons}="ארוחת בוקר|i_me+eat+🍳#past||אכלתי ארוחת בוקר, התלבשתי|i_me+wear+👕#past||התלבשתי, צחצחתי שיניים|i_me+🪥#past||צחצחתי שיניים, בית ספר|i_me+go+🏫#past||הלכתי לבית ספר, שחקתי|i_me+play#past||שחקתי, טיול|i_me+go+🚶#past||הלכתי לטיול, טלוויזיה|i_me+see+📺#past||ראיתי טלוויזיה, משהו אחר|🔄||משהו אחר")
        User turn: "${T.tagPress} אכלתי ארוחת בוקר."
        You speak: "ארוחת בוקר זה חשוב! מה אכלת לארוחת בוקר?"
        You call: rebuild_board(${T.paramOwnSpeech}="ארוחת בוקר זה חשוב! מה אכלת לארוחת בוקר?", ${T.paramUserResponseButtons}="דגנים|🥣||אכלתי דגנים, ביצים|egg||אכלתי ביצים, טוסט|bread||אכלתי טוסט, פירות|fruit||אכלתי פירות, פנקייק|🥞||אכלתי פנקייק, יוגורט|🍧||אכלתי יוגורט, בייגל|🥯||אכלתי בייגל, משהו אחר|🔄||משהו אחר")`,
  },

  // ── <interact_mode> worked dialogue — single-glyph variant ───────────────
  // Same dialogue shape, but every SENTENCE encoding is a single GLYPH (no
  // `+` joins). Past-tense breakfast actions are expressed via an emoji that
  // already encodes the action rather than `i_me+eat+🍳#past`.
  "interact_mode.dialogue_sg": {
    en: `        User turn: "${T.tagPress} I want to talk about my day."
        You speak: "Sure! What would you like to talk about?"
        You call: rebuild_board(${T.paramOwnSpeech}="Sure! What would you like to talk about?", ${T.paramUserResponseButtons}="Morning|morning||My morning, Afternoon|☀️||My afternoon, Evening|🌆||My evening, Yesterday|yesterday||Yesterday, Last night|night||Last night, Weekend|📅||My weekend, This week|🗓️||This week, Something else|🔄||Something else")
        User turn: "${T.tagPress} My morning."
        You speak: "All right, let's talk about your morning! What did you do?"
        You call: rebuild_board(${T.paramOwnSpeech}="All right, let's talk about your morning! What did you do?", ${T.paramUserResponseButtons}="Breakfast|🍳||I ate breakfast, Got dressed|👕||I got dressed, Brushed teeth|🪥||I brushed my teeth, School|🏫||I went to school, Play|🎲||I played, Walk|🚶||I went for a walk, Watched TV|📺||I watched TV, Something else|🔄||Something else")
        User turn: "${T.tagPress} I ate breakfast."
        You speak: "Breakfast is important! What did you have for breakfast?"
        You call: rebuild_board(${T.paramOwnSpeech}="Breakfast is important! What did you have for breakfast?", ${T.paramUserResponseButtons}="Cereal|🥣||I had cereal, Eggs|egg||I had eggs, Toast|bread||I had toast, Fruit|fruit||I had fruit, Pancakes|🥞||I had pancakes, Yogurt|🍧||I had yogurt, Bagel|🥯||I had a bagel, Something else|🔄||Something else")`,
    he: `        User turn: "${T.tagPress} אני רוצה לדבר על היום שלי."
        You speak: "בטח! על מה תרצה לדבר?"
        You call: rebuild_board(${T.paramOwnSpeech}="בטח! על מה תרצה לדבר?", ${T.paramUserResponseButtons}="הבוקר|morning||הבוקר, הצהריים|☀️||הצהריים, הערב|🌆||הערב, אתמול|yesterday||אתמול, אתמול בלילה|night||אתמול בלילה, סוף השבוע|📅||סוף השבוע, השבוע|🗓️||השבוע, משהו אחר|🔄||משהו אחר")
        User turn: "${T.tagPress} הבוקר."
        You speak: "טוב, בוא נדבר על הבוקר שלך! מה עשית?"
        You call: rebuild_board(${T.paramOwnSpeech}="טוב, בוא נדבר על הבוקר שלך! מה עשית?", ${T.paramUserResponseButtons}="ארוחת בוקר|🍳||אכלתי ארוחת בוקר, התלבשתי|👕||התלבשתי, צחצחתי שיניים|🪥||צחצחתי שיניים, בית ספר|🏫||הלכתי לבית ספר, שחקתי|🎲||שחקתי, טיול|🚶||הלכתי לטיול, טלוויזיה|📺||ראיתי טלוויזיה, משהו אחר|🔄||משהו אחר")
        User turn: "${T.tagPress} אכלתי ארוחת בוקר."
        You speak: "ארוחת בוקר זה חשוב! מה אכלת לארוחת בוקר?"
        You call: rebuild_board(${T.paramOwnSpeech}="ארוחת בוקר זה חשוב! מה אכלת לארוחת בוקר?", ${T.paramUserResponseButtons}="דגנים|🥣||אכלתי דגנים, ביצים|egg||אכלתי ביצים, טוסט|bread||אכלתי טוסט, פירות|fruit||אכלתי פירות, פנקייק|🥞||אכלתי פנקייק, יוגורט|🍧||אכלתי יוגורט, בייגל|🥯||אכלתי בייגל, משהו אחר|🔄||משהו אחר")`,
  },

  // ── <interact_mode> bad_example: silent rebuild ──────────────────────────
  "interact_mode.bad_silent": {
    en: `        User turn: "${T.tagPress} I want to play"
        You: (silent) rebuild_board(${T.paramUserResponseButtons}=...)   ← didn't speak and skipped the \`${T.paramOwnSpeech}\` parameter. The user needs to HEAR you react conversationally to their choice.`,
    he: `        User turn: "${T.tagPress} אני רוצה לשחק"
        You: (silent) rebuild_board(${T.paramUserResponseButtons}=...)   ← didn't speak and skipped the \`${T.paramOwnSpeech}\` parameter. The user needs to HEAR you react conversationally to their choice.`,
  },

  // ── <interact_mode> bad_example: echoed the student ──────────────────────
  "interact_mode.bad_echo": {
    en: `        User turn: "${T.tagPress} Hello"
        You speak: "Hello"   ← just echoed the user's SENTENCE. Reply conversationally, e.g. "Hi! It's good to see you."`,
    he: `        User turn: "${T.tagPress} שלום"
        You speak: "שלום"   ← just echoed the user's SENTENCE. Reply conversationally, e.g. "היי! טוב לראות אותך."`,
  },

  // ── <assist_mode> worked dialogue (facilitating with a therapist) ────────
  "assist_mode.dialogue": {
    en: `        You are facilitating communication between the user (a girl) and a therapist.

        User turn: "${T.tagPress} I want to talk about my day."
        You: (remain silent)
        You call: rebuild_board(${T.paramUserResponseButtons}="Morning|morning||My morning, Afternoon|☀️||My afternoon, Evening|🌆||My evening, Yesterday|yesterday||Yesterday, Last night|night||Last night, Weekend|📅||My weekend, This week|🗓️||This week, Something else|🔄||Something else")
        Therapist's voice: "What did you do this morning?"
        You call: transcript("What did you do this morning?", "Therapist", "high")
        You call: rebuild_board(${T.paramUserResponseButtons}="Breakfast|i_me+eat+🍳#past||I ate breakfast, Got dressed|i_me+wear+👕#past||I got dressed, Brushed teeth|i_me+🪥#past||I brushed my teeth, School|i_me+go+🏫#past||I went to school, Play|i_me+play#past||I played, Walk|i_me+go+🚶#past||I went for a walk, Watched TV|i_me+see+📺#past||I watched TV, Something else|🔄||Something else")`,
    he: `        You are facilitating communication between the user (a girl) and a therapist.

        User turn: "${T.tagPress} אני רוצה לדבר על היום שלי."
        You: (remain silent)
        You call: rebuild_board(${T.paramUserResponseButtons}="הבוקר|morning||הבוקר, הצהריים|☀️||הצהריים, הערב|🌆||הערב, אתמול|yesterday||אתמול, אתמול בלילה|night||אתמול בלילה, סוף השבוע|📅||סוף השבוע, השבוע|🗓️||השבוע, משהו אחר|🔄||משהו אחר")
        Therapist's voice: "מה עשית הבוקר?"
        You call: transcript("מה עשית הבוקר?", "מטפל", "high")
        You call: rebuild_board(${T.paramUserResponseButtons}="ארוחת בוקר|i_me+eat+🍳#past||אכלתי ארוחת בוקר, התלבשתי|i_me+wear+👕#past||התלבשתי, צחצחתי שיניים|i_me+🪥#past||צחצחתי שיניים, בית ספר|i_me+go+🏫#past||הלכתי לבית ספר, שחקתי|i_me+play#past||שחקתי, טיול|i_me+go+🚶#past||הלכתי לטיול, טלוויזיה|i_me+see+📺#past||ראיתי טלוויזיה, משהו אחר|🔄||משהו אחר")`,
  },

  // ── <assist_mode> worked dialogue — single-glyph variant ─────────────────
  "assist_mode.dialogue_sg": {
    en: `        You are facilitating communication between the user (a girl) and a therapist.

        User turn: "${T.tagPress} I want to talk about my day."
        You: (remain silent)
        You call: rebuild_board(${T.paramUserResponseButtons}="Morning|morning||My morning, Afternoon|☀️||My afternoon, Evening|🌆||My evening, Yesterday|yesterday||Yesterday, Last night|night||Last night, Weekend|📅||My weekend, This week|🗓️||This week, Something else|🔄||Something else")
        Therapist's voice: "What did you do this morning?"
        You call: transcript("What did you do this morning?", "Therapist", "high")
        You call: rebuild_board(${T.paramUserResponseButtons}="Breakfast|🍳||I ate breakfast, Got dressed|👕||I got dressed, Brushed teeth|🪥||I brushed my teeth, School|🏫||I went to school, Play|🎲||I played, Walk|🚶||I went for a walk, Watched TV|📺||I watched TV, Something else|🔄||Something else")`,
    he: `        You are facilitating communication between the user (a girl) and a therapist.

        User turn: "${T.tagPress} אני רוצה לדבר על היום שלי."
        You: (remain silent)
        You call: rebuild_board(${T.paramUserResponseButtons}="הבוקר|morning||הבוקר, הצהריים|☀️||הצהריים, הערב|🌆||הערב, אתמול|yesterday||אתמול, אתמול בלילה|night||אתמול בלילה, סוף השבוע|📅||סוף השבוע, השבוע|🗓️||השבוע, משהו אחר|🔄||משהו אחר")
        Therapist's voice: "מה עשית הבוקר?"
        You call: transcript("מה עשית הבוקר?", "מטפל", "high")
        You call: rebuild_board(${T.paramUserResponseButtons}="ארוחת בוקר|🍳||אכלתי ארוחת בוקר, התלבשתי|👕||התלבשתי, צחצחתי שיניים|🪥||צחצחתי שיניים, בית ספר|🏫||הלכתי לבית ספר, שחקתי|🎲||שחקתי, טיול|🚶||הלכתי לטיול, טלוויזיה|📺||ראיתי טלוויזיה, משהו אחר|🔄||משהו אחר")`,
  },

  // ── <button_syntax> <examples>: "What would you like to eat?" ────────────
  "button_syntax.food_question": {
    en: `You say "What would you like to eat?" — the ${T.board} might offer:
  - "I want a banana|i_me+want+🍌||Banana"                              ← 3-glyph
  - "Pizza, please|🍕.please||Pizza"                                    ← 1-glyph + politeness modifier
  - "A red apple|i_me+want+🍎.color_red||Red apple"                     ← 3-glyph + color modifier
  - "Two cookies|🍪.two||Cookies"                                       ← 1-glyph + count modifier
  - "Cold water|💧.cold||Cold water"                                    ← 1-glyph + temperature modifier
  - "I'm very hungry|🤤.very||Very hungry"                              ← 1-glyph + intensity modifier
  - "I'm not hungry|🤤.not||Not hungry"                                 ← 1-glyph + negation modifier`,
    he: `You say "מה תרצה לאכול?" — the ${T.board} might offer:
  - "אני רוצה בננה|i_me+want+🍌||בננה"                                   ← 3-glyph
  - "פיצה בבקשה|🍕.please||פיצה"                                         ← 1-glyph + politeness modifier
  - "תפוח אדום|i_me+want+🍎.color_red||תפוח אדום"                        ← 3-glyph + color modifier
  - "שתי עוגיות|🍪.two||עוגיות"                                          ← 1-glyph + count modifier
  - "מים קרים|💧.cold||מים קרים"                                         ← 1-glyph + temperature modifier
  - "אני מאוד רעב|🤤.very||מאוד רעב"                                     ← 1-glyph + intensity modifier
  - "אני לא רעב|🤤.not||לא רעב"                                          ← 1-glyph + negation modifier`,
  },

  // ── button_syntax.food_question — single-glyph variant ──────────────────
  "button_syntax.food_question_sg": {
    en: `You say "What would you like to eat?" — the ${T.board} might offer:
  - "I want a banana|🍌||Banana"
  - "Pizza, please|🍕.please||Pizza"                                    ← politeness modifier
  - "A red apple|🍎.color_red||Red apple"                               ← color modifier
  - "Two cookies|🍪.two||Cookies"                                       ← count modifier
  - "Cold water|💧.cold||Cold water"                                    ← temperature modifier
  - "I'm very hungry|🤤.very||Very hungry"                              ← intensity modifier
  - "I'm not hungry|🤤.not||Not hungry"                                 ← negation modifier`,
    he: `You say "מה תרצה לאכול?" — the ${T.board} might offer:
  - "אני רוצה בננה|🍌||בננה"
  - "פיצה בבקשה|🍕.please||פיצה"                                         ← politeness modifier
  - "תפוח אדום|🍎.color_red||תפוח אדום"                                  ← color modifier
  - "שתי עוגיות|🍪.two||עוגיות"                                          ← count modifier
  - "מים קרים|💧.cold||מים קרים"                                         ← temperature modifier
  - "אני מאוד רעב|🤤.very||מאוד רעב"                                     ← intensity modifier
  - "אני לא רעב|🤤.not||לא רעב"                                          ← negation modifier`,
  },

  // ── <button_syntax> <examples>: "Who do you want to play with?" ──────────
  "button_syntax.company_question": {
    en: `You say "Who do you want to play with?":
  - "I want to play with Mom|i_me+want+👩||With Mom"                    ← 3-glyph
  - "With Dad|👨.my||With Dad"                                          ← 1-glyph + possession
  - "With my brother|👦.my||Brother"
  - "With my friend|🧑‍🤝‍🧑.my||My friend"
  - "By myself|i_me||Alone"
  - "Nobody right now|👤.not||Nobody"                                   ← negation`,
    he: `You say "עם מי אתה רוצה לשחק?":
  - "אני רוצה לשחק עם אמא|i_me+want+👩||עם אמא"                          ← 3-glyph
  - "עם אבא|👨.my||עם אבא"                                                ← 1-glyph + possession
  - "עם אחי|👦.my||אח"
  - "עם החבר שלי|🧑‍🤝‍🧑.my||החבר שלי"
  - "לבד|i_me||לבד"
  - "אף אחד עכשיו|👤.not||אף אחד"                                        ← negation`,
  },

  // ── button_syntax.company_question — single-glyph variant ───────────────
  "button_syntax.company_question_sg": {
    en: `You say "Who do you want to play with?":
  - "I want to play with Mom|👩||With Mom"
  - "With Dad|👨.my||With Dad"                                          ← possession modifier
  - "With my brother|👦.my||Brother"
  - "With my friend|🧑‍🤝‍🧑.my||My friend"
  - "By myself|i_me||Alone"
  - "Nobody right now|👤.not||Nobody"                                   ← negation`,
    he: `You say "עם מי אתה רוצה לשחק?":
  - "אני רוצה לשחק עם אמא|👩||עם אמא"
  - "עם אבא|👨.my||עם אבא"                                                ← possession modifier
  - "עם אחי|👦.my||אח"
  - "עם החבר שלי|🧑‍🤝‍🧑.my||החבר שלי"
  - "לבד|i_me||לבד"
  - "אף אחד עכשיו|👤.not||אף אחד"                                        ← negation`,
  },

  // ── <button_syntax> <examples>: "How are you feeling?" ───────────────────
  "button_syntax.feeling_question": {
    en: `You say "How are you feeling?":
  - "Happy|😊||Happy"
  - "I'm a little tired|😴.small||A bit tired"                          ← intensity
  - "I feel sick|i_me+🤒||Sick"                                         ← 2-glyph (subject + feeling)
  - "A bit angry|😠.small||A bit angry"`,
    he: `You say "איך אתה מרגיש?":
  - "שמח|😊||שמח"
  - "אני קצת עייף|😴.small||קצת עייף"                                    ← intensity
  - "אני מרגיש חולה|i_me+🤒||חולה"                                       ← 2-glyph (subject + feeling)
  - "קצת כועס|😠.small||קצת כועס"`,
  },

  // ── button_syntax.feeling_question — single-glyph variant ───────────────
  "button_syntax.feeling_question_sg": {
    en: `You say "How are you feeling?":
  - "Happy|😊||Happy"
  - "I'm a little tired|😴.small||A bit tired"                          ← intensity
  - "I feel sick|🤒||Sick"
  - "A bit angry|😠.small||A bit angry"`,
    he: `You say "איך אתה מרגיש?":
  - "שמח|😊||שמח"
  - "אני קצת עייף|😴.small||קצת עייף"                                    ← intensity
  - "אני מרגיש חולה|🤒||חולה"
  - "קצת כועס|😠.small||קצת כועס"`,
  },

  // ── <button_syntax> <examples>: OPERATORs (past/question) ────────────────
  "button_syntax.operators": {
    en: `Operators (past / future / question):
  - "I went to the park|i_me+go+🛝#past||Park"
  - "Are we going to the park?|we+go+🛝#question||Park?"`,
    he: `Operators (past / future / question):
  - "הלכתי לפארק|i_me+go+🛝#past||פארק"
  - "האם אנחנו הולכים לפארק?|we+go+🛝#question||פארק?"`,
  },

  // ── button_syntax.operators — single-glyph variant ──────────────────────
  // Operators are sentence-level tags appended with `#`. They still apply
  // to a single-GLYPH SENTENCE — the visual stays the same, only the spoken
  // SENTENCE conjugates.
  "button_syntax.operators_sg": {
    en: `Operators (past / future / question):
  - "I went to the park|🛝#past||Park"
  - "Are we going to the park?|🛝#question||Park?"`,
    he: `Operators (past / future / question):
  - "הלכתי לפארק|🛝#past||פארק"
  - "האם אנחנו הולכים לפארק?|🛝#question||פארק?"`,
  },

  // ── <button_syntax> <examples>: generated SYMBOLs ────────────────────────
  "button_syntax.generated": {
    en: `Generated SYMBOLs (with required fallback):
  - "Tell me about Mars|you+say+generate:planet_mars|you+say+🌑.color_red|Mars"   ← fallback mirrors structure
  - "I see a seagull|i_me+see+generate:seagull|i_me+see+🐦.🏖️|Seagull"`,
    he: `Generated SYMBOLs (with required fallback):
  - "ספר לי על מאדים|you+say+generate:planet_mars|you+say+🌑.color_red|מאדים"   ← fallback mirrors structure
  - "אני רואה שחף|i_me+see+generate:seagull|i_me+see+🐦.🏖️|שחף"`,
  },

  // ── button_syntax.generated — single-glyph variant ──────────────────────
  // Fallback mirrors the single-GLYPH shape: one head SYMBOL, no `+`.
  "button_syntax.generated_sg": {
    en: `Generated SYMBOLs (with required fallback):
  - "Tell me about Mars|generate:planet_mars|🌑.color_red|Mars"          ← fallback mirrors shape
  - "I see a seagull|generate:seagull|🐦|Seagull"`,
    he: `Generated SYMBOLs (with required fallback):
  - "ספר לי על מאדים|generate:planet_mars|🌑.color_red|מאדים"             ← fallback mirrors shape
  - "אני רואה שחף|generate:seagull|🐦|שחף"`,
  },

  // ── <binary_choice> examples list ────────────────────────────────────────
  "binary_choice.examples": {
    en: `Examples:
- Yes/no: binary_choice("Yes|yes||Yes", "No|no||No")
- Yes/no with politeness: ask_binary_choice("Yes please|yes.please||Yes please", "No thank you|no.please||No thanks")
- Object choice: binary_choice("I want the apple|i_me+want+🍎||Apple", "I want the banana|i_me+want+🍌||Banana")
- Activity choice: ask_binary_choice("I want to play|i_me+want+play||Play", "I want to read|i_me+want+📖||Read")
- Place choice: ask_binary_choice("Outside|i_me+want+🌳||Outside", "Stay inside|i_me+want+🏠||Inside")`,
    he: `Examples:
- Yes/no: binary_choice("כן|yes||כן", "לא|no||לא")
- Yes/no with politeness: ask_binary_choice("כן בבקשה|yes.please||כן בבקשה", "לא תודה|no.please||לא תודה")
- Object choice: binary_choice("אני רוצה את התפוח|i_me+want+🍎||תפוח", "אני רוצה את הבננה|i_me+want+🍌||בננה")
- Activity choice: ask_binary_choice("אני רוצה לשחק|i_me+want+play||לשחק", "אני רוצה לקרוא|i_me+want+📖||לקרוא")
- Place choice: ask_binary_choice("בחוץ|i_me+want+🌳||בחוץ", "להישאר בפנים|i_me+want+🏠||בפנים")`,
  },

  // ── binary_choice.examples — single-glyph variant ───────────────────────
  "binary_choice.examples_sg": {
    en: `Examples:
- Yes/no: binary_choice("Yes|yes||Yes", "No|no||No")
- Yes/no with politeness: ask_binary_choice("Yes please|yes.please||Yes please", "No thank you|no.please||No thanks")
- Object choice: binary_choice("I want the apple|🍎||Apple", "I want the banana|🍌||Banana")
- Activity choice: ask_binary_choice("I want to play|play||Play", "I want to read|📖||Read")
- Place choice: ask_binary_choice("Outside|🌳||Outside", "Stay inside|🏠||Inside")`,
    he: `Examples:
- Yes/no: binary_choice("כן|yes||כן", "לא|no||לא")
- Yes/no with politeness: ask_binary_choice("כן בבקשה|yes.please||כן בבקשה", "לא תודה|no.please||לא תודה")
- Object choice: binary_choice("אני רוצה את התפוח|🍎||תפוח", "אני רוצה את הבננה|🍌||בננה")
- Activity choice: ask_binary_choice("אני רוצה לשחק|play||לשחק", "אני רוצה לקרוא|📖||לקרוא")
- Place choice: ask_binary_choice("בחוץ|🌳||בחוץ", "להישאר בפנים|🏠||בפנים")`,
  },

  // ── tool: add_buttons / rebuild_board inline example lists ───────────────
  //
  // These ship inside the tool descriptions delivered to the model at
  // session-init. Same language-mixing pressure as the system prompt —
  // localizing keeps the model's audio output in the student's language.

  "tool.button_format_add_example": {
    en: `Example: "I want a red apple|i_me+want+🍎.color_red||Red apple, Pizza, please|🍕.please||Pizza, A big hug|i_me+want+🤗.big||Big hug, I'm tired|😴||Tired, Tell me about Mars|you+say+generate:planet_mars|you+say+🌑.color_red|Mars"`,
    he: {
      m: `Example: "אני רוצה תפוח אדום|i_me+want+🍎.color_red||תפוח אדום, פיצה בבקשה|🍕.please||פיצה, חיבוק גדול|i_me+want+🤗.big||חיבוק גדול, אני עייף|😴||עייף, ספר לי על מאדים|you+say+generate:planet_mars|you+say+🌑.color_red|מאדים"`,
      f: `Example: "אני רוצה תפוח אדום|i_me+want+🍎.color_red||תפוח אדום, פיצה בבקשה|🍕.please||פיצה, חיבוק גדול|i_me+want+🤗.big||חיבוק גדול, אני עייפה|😴||עייפה, ספר לי על מאדים|you+say+generate:planet_mars|you+say+🌑.color_red|מאדים"`,
    },
  },

  // Single-glyph variant: every SENTENCE is one GLYPH (head + optional
  // modifiers). No `+`-joined heads.
  "tool.button_format_add_example_sg": {
    en: `Example: "A red apple|🍎.color_red||Red apple, Pizza, please|🍕.please||Pizza, A big hug|🤗.big||Big hug, I'm tired|😴||Tired, Tell me about Mars|generate:planet_mars|🌑.color_red|Mars"`,
    he: {
      m: `Example: "תפוח אדום|🍎.color_red||תפוח אדום, פיצה בבקשה|🍕.please||פיצה, חיבוק גדול|🤗.big||חיבוק גדול, אני עייף|😴||עייף, ספר לי על מאדים|generate:planet_mars|🌑.color_red|מאדים"`,
      f: `Example: "תפוח אדום|🍎.color_red||תפוח אדום, פיצה בבקשה|🍕.please||פיצה, חיבוק גדול|🤗.big||חיבוק גדול, אני עייפה|😴||עייפה, ספר לי על מאדים|generate:planet_mars|🌑.color_red|מאדים"`,
    },
  },

  "tool.button_format_rebuild_example": {
    en: `Example: "I want to play|i_me+want+play||Play, Let's listen to music|i_me+want+🎵||Music, I want a cookie|i_me+want+🍪||Cookie, Two cookies|🍪.two||Two cookies, Outside|i_me+want+🌳||Outside, I'm hungry|🤤||Hungry, A big hug|i_me+want+🤗.big||Hug, Did we go to the park yesterday?|we+go+🛝#past#question||Park yesterday"`,
    he: {
      m: `Example: "אני רוצה לשחק|i_me+want+play||לשחק, בוא נשמע מוזיקה|i_me+want+🎵||מוזיקה, אני רוצה עוגייה|i_me+want+🍪||עוגייה, שתי עוגיות|🍪.two||שתי עוגיות, בחוץ|i_me+want+🌳||בחוץ, אני רעב|🤤||רעב, חיבוק גדול|i_me+want+🤗.big||חיבוק, האם הלכנו אתמול לפארק?|we+go+🛝#past#question||פארק אתמול"`,
      f: `Example: "אני רוצה לשחק|i_me+want+play||לשחק, בוא נשמע מוזיקה|i_me+want+🎵||מוזיקה, אני רוצה עוגייה|i_me+want+🍪||עוגייה, שתי עוגיות|🍪.two||שתי עוגיות, בחוץ|i_me+want+🌳||בחוץ, אני רעבה|🤤||רעבה, חיבוק גדול|i_me+want+🤗.big||חיבוק, האם הלכנו אתמול לפארק?|we+go+🛝#past#question||פארק אתמול"`,
    },
  },

  // Single-glyph variant: every SENTENCE is one GLYPH. Operators still apply
  // sentence-level (#past#question on a single-GLYPH SENTENCE).
  "tool.button_format_rebuild_example_sg": {
    en: `Example: "Play|play||Play, Music|🎵||Music, Cookie|🍪||Cookie, Two cookies|🍪.two||Two cookies, Outside|🌳||Outside, I'm hungry|🤤||Hungry, A big hug|🤗.big||Hug, Did we go to the park yesterday?|🛝#past#question||Park yesterday"`,
    he: {
      m: `Example: "לשחק|play||לשחק, מוזיקה|🎵||מוזיקה, עוגייה|🍪||עוגייה, שתי עוגיות|🍪.two||שתי עוגיות, בחוץ|🌳||בחוץ, אני רעב|🤤||רעב, חיבוק גדול|🤗.big||חיבוק, האם הלכנו אתמול לפארק?|🛝#past#question||פארק אתמול"`,
      f: `Example: "לשחק|play||לשחק, מוזיקה|🎵||מוזיקה, עוגייה|🍪||עוגייה, שתי עוגיות|🍪.two||שתי עוגיות, בחוץ|🌳||בחוץ, אני רעבה|🤤||רעבה, חיבוק גדול|🤗.big||חיבוק, האם הלכנו אתמול לפארק?|🛝#past#question||פארק אתמול"`,
    },
  },

  // ── tool: short inline phrases inside SENTENCE_BUTTON_FORMAT ─────────────
  //
  // These are the throwaway examples sprinkled inside the format
  // description (e.g. `"I want water"`, `"I'm tired"`). Small individually
  // but together they're a meaningful chunk of English priming if left
  // untranslated.

  "tool.sbf_speech_water": {
    en: `speech: "I want water"`,
    he: `speech: "אני רוצה מים"`,
  },
  // Updated to the structured-array glyph form the schema actually
  // declares. The prior `"i_me+want+🍌"` pipe encoding was the legacy
  // string format; the structured `glyph: [...]` array is what
  // rebuild_board now expects and what the parser sees in successful
  // calls. Showing the legacy form was teaching the model the wrong
  // shape — a likely contributor to MALFORMED_FUNCTION_CALL.
  "tool.sbf_speech_three_glyph_banana": {
    en: `speech: "I want a banana", glyph: [{sym:"i_me"},{sym:"want"},{sym:"🍌"}]`,
    he: `speech: "אני רוצה בננה", glyph: [{sym:"i_me"},{sym:"want"},{sym:"🍌"}]`,
  },
  "tool.sbf_speech_one_glyph_tired": {
    en: `speech: "I'm tired", glyph: [{sym:"😴"}]`,
    he: {
      m: `speech: "אני עייף", glyph: [{sym:"😴"}]`,
      f: `speech: "אני עייפה", glyph: [{sym:"😴"}]`,
    },
  },

  // ── tool: BINARY_CHOICE_OPTION_FORMAT inline examples ────────────────────

  "tool.binary_choice_inline_examples": {
    en: `Examples: "Yes|yes||Yes", "No, thank you|no.please||No thanks", "I want the apple|i_me+want+🍎||Apple", "I want to play outside|i_me+want+play+🌳||Outside".`,
    he: `Examples: "כן|yes||כן", "לא תודה|no.please||לא תודה", "אני רוצה את התפוח|i_me+want+🍎||תפוח", "אני רוצה לשחק בחוץ|i_me+want+play+🌳||בחוץ".`,
  },

  // Single-glyph variant: each example is a single GLYPH.
  "tool.binary_choice_inline_examples_sg": {
    en: `Examples: "Yes|yes||Yes", "No, thank you|no.please||No thanks", "I want the apple|🍎||Apple", "Outside|🌳||Outside".`,
    he: `Examples: "כן|yes||כן", "לא תודה|no.please||לא תודה", "אני רוצה את התפוח|🍎||תפוח", "בחוץ|🌳||בחוץ".`,
  },

  // ── <sentence_interpretation> worked examples ────────────────────────────
  //
  // The `speak()` / "speak aloud" branch is rendered by the prompt builder
  // (because it depends on useDirectAudio). The translation provides the
  // matching natural-language interpret() arguments — those are what the AI
  // is supposed to voice in the student's own language.
  "sentence_interpretation.worked_examples": {
    en: `- \`i_me+want+💧\` → interpret("I want some water") then $SPEAK_VERB$ + rebuild_board() about getting water.
- \`talk+shoe+ball\` → interpret("I want to talk about football") — shoe+ball compound matches interest; subject defaults to user.
- \`go+park+🐕\` → interpret("I want to go to the park with the dog") — companion, not two destinations.
- \`mom+give+📖\` → interpret("I want Mom to give me the book") — recipient (me) is implied when omitted.
- \`tired+i_me\` → interpret("I'm tired") — feeling + subject; no verb needed.
- \`📖.your\` → interpret("Do you have the book?") — 1-glyph SENTENCE with possession modifier.
- \`i_me+eat+🍌#past\` → interpret("I ate a banana") — operator-driven past tense.
- \`i_me+go+park#future\` → interpret("I will go to the park").
- \`mom+give+📖#past#question\` → interpret("Did Mom give me the book?") — operators stack on a 3-glyph SENTENCE.`,
    he: {
      m: `- \`i_me+want+💧\` → interpret("אני רוצה קצת מים") then $SPEAK_VERB$ + rebuild_board() about getting water.
- \`talk+shoe+ball\` → interpret("אני רוצה לדבר על כדורגל") — shoe+ball compound matches interest; subject defaults to user.
- \`go+park+🐕\` → interpret("אני רוצה ללכת לפארק עם הכלב") — companion, not two destinations.
- \`mom+give+📖\` → interpret("אני רוצה שאמא תיתן לי את הספר") — recipient (me) is implied when omitted.
- \`tired+i_me\` → interpret("אני עייף") — feeling + subject; no verb needed.
- \`📖.your\` → interpret("יש לך את הספר?") — 1-glyph SENTENCE with possession modifier.
- \`i_me+eat+🍌#past\` → interpret("אכלתי בננה") — operator-driven past tense.
- \`i_me+go+park#future\` → interpret("אני אלך לפארק").
- \`mom+give+📖#past#question\` → interpret("האם אמא נתנה לי את הספר?") — operators stack on a 3-glyph SENTENCE.`,
      f: `- \`i_me+want+💧\` → interpret("אני רוצה קצת מים") then $SPEAK_VERB$ + rebuild_board() about getting water.
- \`talk+shoe+ball\` → interpret("אני רוצה לדבר על כדורגל") — shoe+ball compound matches interest; subject defaults to user.
- \`go+park+🐕\` → interpret("אני רוצה ללכת לפארק עם הכלב") — companion, not two destinations.
- \`mom+give+📖\` → interpret("אני רוצה שאמא תיתן לי את הספר") — recipient (me) is implied when omitted.
- \`tired+i_me\` → interpret("אני עייפה") — feeling + subject; no verb needed.
- \`📖.your\` → interpret("יש לך את הספר?") — 1-glyph SENTENCE with possession modifier.
- \`i_me+eat+🍌#past\` → interpret("אכלתי בננה") — operator-driven past tense.
- \`i_me+go+park#future\` → interpret("אני אלך לפארק").
- \`mom+give+📖#past#question\` → interpret("האם אמא נתנה לי את הספר?") — operators stack on a 3-glyph SENTENCE.`,
    },
  },
};
