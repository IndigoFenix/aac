// Audit script: list registry items where the closest emoji is either
// weak (semantically inaccurate) OR directional (must flip in RTL but
// emojis can't be flipped). Run with `npx tsx scripts/bundled-icon-priorities.ts`.

import { listAllVocabulary } from "../shared/glyph-registry";

const directionalEmojiOnly = listAllVocabulary().filter(
  (v) => v.directional && !v.imagePath
);
const everyDirectional = listAllVocabulary().filter((v) => v.directional);

console.log("=== Directional items lacking bundled artwork ===");
console.log("(emojis can't be flipped in RTL — these render incorrectly for Hebrew / Arabic)");
console.log("");
for (const v of directionalEmojiOnly) {
  console.log(`  ${v.key.padEnd(15)} ${v.emoji ?? ""}`);
}
console.log("");
console.log(`Total directional items: ${everyDirectional.length}`);
console.log(`  With bundled artwork (flips OK): ${everyDirectional.length - directionalEmojiOnly.length}`);
console.log(`  Emoji-only (RTL broken):         ${directionalEmojiOnly.length}`);
