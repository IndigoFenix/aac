/**
 * One-off: relabel quickActions.guess "Find word" across all client-aac locales.
 * `guess:` is unique per locale file, so a line-targeted replace is safe.
 * Usage: npx tsx scripts/gen-findword-i18n.ts
 */
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const I18N_DIR = path.resolve(__dirname, "..", "client-aac", "src", "i18n");

const FIND_WORD: Record<string, string> = {
  en: "Find word",
  he: "מצא מילה",
  es: "Buscar palabra",
  pt: "Achar palavra",
  fr: "Trouver un mot",
  ru: "Найти слово",
  de: "Wort finden",
  ar: "إيجاد كلمة",
  zh: "找词",
  yue: "搵字",
  ko: "단어 찾기",
};

for (const [locale, label] of Object.entries(FIND_WORD)) {
  const file = path.join(I18N_DIR, `${locale}.ts`);
  let content = fs.readFileSync(file, "utf-8");
  const re = /(\n\s*guess:\s*)"[^"]*"/;
  if (!re.test(content)) {
    console.error(`!! ${locale}.ts — quickActions 'guess' key not found`);
    continue;
  }
  content = content.replace(re, (_m, pre) => `${pre}${JSON.stringify(label)}`);
  fs.writeFileSync(file, content, "utf-8");
  console.log(`updated ${locale}.ts → guess: ${JSON.stringify(label)}`);
}
console.log("Done.");
