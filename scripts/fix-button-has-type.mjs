// One-shot codemod: add `type="button"` to every <button> tag flagged by
// react/button-has-type. We pick "button" because every flagged site is an
// onClick handler outside a form, and the default ("submit") would cause
// surprise form submissions if the button later ends up inside a form.
//
// Conservative algorithm: read each line ESLint flagged, find the `<button`
// opening on that line, walk forward to the closing `>` of the opening tag
// (respecting JSX-expression braces), and insert `type="button"` after
// `<button` IF no `type=` is already present in the captured attribute
// list. Skips files / lines that don't match the expected shape.
//
// Usage:
//   node scripts/fix-button-has-type.mjs

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

console.log("[fix-button-has-type] Collecting ESLint findings…");
const eslintJson = execSync(
  'npx eslint client/src client-aac/src --format json',
  { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
);
const reports = JSON.parse(eslintJson);

// Map<filePath, Set<lineNumber>>
const targets = new Map();
for (const f of reports) {
  for (const m of f.messages) {
    if (m.ruleId !== "react/button-has-type") continue;
    if (!targets.has(f.filePath)) targets.set(f.filePath, new Set());
    targets.get(f.filePath).add(m.line);
  }
}

if (targets.size === 0) {
  console.log("[fix-button-has-type] Nothing to do.");
  process.exit(0);
}

// For each file, walk lines and rewrite each flagged <button tag.
let totalFixed = 0;
let totalSkipped = 0;
for (const [filePath, lineSet] of targets) {
  const original = fs.readFileSync(filePath, "utf8");
  const lines = original.split("\n");
  let modified = false;

  for (const line of [...lineSet].sort((a, b) => a - b)) {
    const idx = line - 1;
    if (idx < 0 || idx >= lines.length) continue;
    const text = lines[idx];

    // Find an opening `<button` on this line (lowercase HTML element).
    // Word boundary handles both `<button>`, `<button ...`, and `<button\n`.
    const m = text.match(/<button\b/);
    if (!m) {
      totalSkipped++;
      continue;
    }
    const startCol = m.index;

    // Walk forward across (potentially multiple) lines to find the matching
    // `>` of the opening tag, respecting curly-brace expressions.
    let scanLine = idx;
    let scanCol = startCol + "<button".length;
    let depth = 0;
    let endLine = -1;
    let endCol = -1;
    outer: while (scanLine < lines.length) {
      const src = lines[scanLine];
      while (scanCol < src.length) {
        const ch = src[scanCol];
        if (ch === "{") depth++;
        else if (ch === "}") depth--;
        else if (ch === ">" && depth === 0) {
          endLine = scanLine;
          endCol = scanCol;
          break outer;
        }
        scanCol++;
      }
      scanLine++;
      scanCol = 0;
    }
    if (endLine === -1) {
      totalSkipped++;
      continue;
    }

    // Reconstruct the attribute span.
    let attrs;
    if (scanLine === idx) {
      attrs = lines[idx].slice(startCol + "<button".length, endCol);
    } else {
      attrs =
        lines[idx].slice(startCol + "<button".length) +
        "\n" +
        lines.slice(idx + 1, endLine).join("\n") +
        "\n" +
        lines[endLine].slice(0, endCol);
    }

    // If `type=` is already present in attrs, skip (rule should not have fired
    // but safest to verify before mutating).
    if (/\btype\s*=/.test(attrs)) {
      totalSkipped++;
      continue;
    }

    // Insert ` type="button"` immediately after `<button` on the start line.
    const before = lines[idx].slice(0, startCol + "<button".length);
    const after = lines[idx].slice(startCol + "<button".length);
    lines[idx] = before + ' type="button"' + after;
    modified = true;
    totalFixed++;
  }

  if (modified) {
    fs.writeFileSync(filePath, lines.join("\n"), "utf8");
    console.log(`  ✓ ${path.relative(process.cwd(), filePath).replace(/\\/g, "/")}`);
  }
}

console.log("");
console.log(`[fix-button-has-type] Fixed ${totalFixed}; skipped ${totalSkipped}.`);
