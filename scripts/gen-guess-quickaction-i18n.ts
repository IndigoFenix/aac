/**
 * One-off: insert `quickActions.guess` into every client-aac locale file,
 * right after the existing `neither` key (keeps identical key ordering).
 * Idempotent. Usage: npx tsx scripts/gen-guess-quickaction-i18n.ts
 */
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const I18N_DIR = path.resolve(__dirname, "..", "client-aac", "src", "i18n");

// locale → "Guess" button label (aligned with board.guessingMode phrasing)
const GUESS: Record<string, string> = {
  en: "Guess",
  he: "ניחוש",
  es: "Adivinar",
  pt: "Adivinhar",
  fr: "Deviner",
  ru: "Угадать",
  de: "Raten",
  ar: "تخمين",
  zh: "猜一猜",
  yue: "估下",
  ko: "추측",
};

for (const [locale, label] of Object.entries(GUESS)) {
  const file = path.join(I18N_DIR, `${locale}.ts`);
  let content = fs.readFileSync(file, "utf-8");
  if (/\n\s*guess\s*:/.test(content) && /quickActions/.test(content.slice(0, content.indexOf("guess:")))) {
    // crude guard; rely on the precise neither-line match below for safety
  }
  // Match the neither line inside quickActions and append a guess line after it.
  const re = /(\n(\s*)neither:\s*"[^"]*",)/;
  if (!re.test(content)) {
    console.error(`!! ${locale}.ts — could not find quickActions 'neither' key`);
    continue;
  }
  if (content.includes(`\n    guess: `)) {
    console.log(`skip ${locale}.ts — guess already present`);
    continue;
  }
  content = content.replace(re, (_m, line, indent) => `${line}\n${indent}guess: ${JSON.stringify(label)},`);
  fs.writeFileSync(file, content, "utf-8");
  console.log(`updated ${locale}.ts`);
}
console.log("Done.");
