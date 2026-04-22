/**
 * i18n Consistency Validator
 *
 * Checks that all language files within each i18n directory have:
 * - Identical key structures (same keys in the same order)
 * - Keys on the same line numbers
 * - No missing or extra keys
 *
 * Usage: npx tsx scripts/validate-i18n.ts [--fix]
 *
 * With --fix, the script will reorder non-English files to match the English
 * file's key order (preserving translated values).
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath, pathToFileURL } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");

const I18N_DIRS = [
  path.join(ROOT, "client", "src", "i18n"),
  path.join(ROOT, "client-aac", "src", "i18n"),
];

interface KeyInfo {
  line: number;
  key: string;
  fullPath: string; // dot-separated path like "common.save"
  depth: number;
  type: "key-value" | "section-open" | "section-close" | "comment" | "blank" | "other";
  raw: string; // the raw line content
}

/** Extract structural lines from a translation file */
function parseTranslationFile(filePath: string): KeyInfo[] {
  const content = fs.readFileSync(filePath, "utf-8");
  const lines = content.split("\n");
  const result: KeyInfo[] = [];
  const pathStack: string[] = [];
  let depth = 0;
  let insideExport = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    const lineNum = i + 1;

    // Skip lines before the export object starts
    if (!insideExport) {
      if (trimmed.match(/^export\s+const\s+\w+/)) {
        insideExport = true;
      }
      continue;
    }

    // Skip the final closing };
    if (trimmed === "};" && depth === 0) {
      break;
    }

    // Comment line
    if (trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*")) {
      result.push({
        line: lineNum,
        key: "",
        fullPath: pathStack.join("."),
        depth,
        type: "comment",
        raw: trimmed,
      });
      continue;
    }

    // Blank line
    if (trimmed === "") {
      result.push({
        line: lineNum,
        key: "",
        fullPath: pathStack.join("."),
        depth,
        type: "blank",
        raw: "",
      });
      continue;
    }

    // Section open: "keyName: {"
    const sectionOpen = trimmed.match(/^(\w+)\s*:\s*\{/);
    if (sectionOpen) {
      const key = sectionOpen[1];
      pathStack.push(key);
      result.push({
        line: lineNum,
        key,
        fullPath: pathStack.join("."),
        depth,
        type: "section-open",
        raw: trimmed,
      });
      depth++;
      continue;
    }

    // Closing brace: "}" or "},"
    if (trimmed === "}" || trimmed === "},") {
      depth--;
      result.push({
        line: lineNum,
        key: "",
        fullPath: pathStack.join("."),
        depth,
        type: "section-close",
        raw: trimmed,
      });
      pathStack.pop();
      continue;
    }

    // Key-value pair: "keyName: "value"," or "keyName: `value`,"
    const keyValue = trimmed.match(/^(\w+)\s*:/);
    if (keyValue) {
      const key = keyValue[1];
      result.push({
        line: lineNum,
        key,
        fullPath: [...pathStack, key].join("."),
        depth,
        type: "key-value",
        raw: trimmed,
      });
      continue;
    }

    // Other line (e.g., continuation of a multi-line string)
    result.push({
      line: lineNum,
      key: "",
      fullPath: pathStack.join("."),
      depth,
      type: "other",
      raw: trimmed,
    });
  }

  return result;
}

/** Extract only structural entries (keys and sections, not comments/blanks) */
function getStructuralKeys(entries: KeyInfo[]): KeyInfo[] {
  return entries.filter(
    (e) => e.type === "key-value" || e.type === "section-open" || e.type === "section-close"
  );
}

interface Issue {
  severity: "error" | "warning";
  file: string;
  line?: number;
  message: string;
}

/**
 * Dynamically import the file and confirm it exports a plain object.
 * Catches unterminated string literals, trailing content outside the export,
 * and other syntactic corruption that the regex parser happily ignores.
 */
async function validateFileParses(filePath: string, dirName: string, file: string): Promise<Issue[]> {
  try {
    const url = pathToFileURL(filePath).href + `?t=${Date.now()}`; // bust tsx's import cache
    const mod = await import(url);
    const exportName = file.replace(/\.ts$/, "");
    const candidate = (mod as Record<string, unknown>)[exportName] ?? mod.default;
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      return [{
        severity: "error",
        file: `${dirName}/${file}`,
        message: `Export '${exportName}' is missing or is not a plain object — the translation map isn't structured correctly`,
      }];
    }
    // Ensure nothing leaked outside the object: check for other non-type exports.
    const otherExports = Object.keys(mod).filter((k) => k !== exportName && k !== "default" && typeof (mod as any)[k] !== "function");
    if (otherExports.length > 0) {
      return [{
        severity: "warning",
        file: `${dirName}/${file}`,
        message: `Unexpected extra exports alongside '${exportName}': ${otherExports.join(", ")}`,
      }];
    }
    return [];
  } catch (err: any) {
    // Pull a file:line:col out of the stack if tsx/esbuild gave us one
    const msg = err?.message || String(err);
    const locMatch = typeof err?.stack === "string"
      ? err.stack.match(/:(\d+):(\d+)/)
      : null;
    return [{
      severity: "error",
      file: `${dirName}/${file}`,
      line: locMatch ? Number(locMatch[1]) : undefined,
      message: `Syntax / parse error: ${msg.split("\n")[0]}`,
    }];
  }
}

async function validateDirectory(dir: string): Promise<Issue[]> {
  const issues: Issue[] = [];
  const dirName = path.relative(ROOT, dir);

  // Find all translation .ts files (exclude index.ts)
  const tsFiles = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".ts") && f !== "index.ts")
    .sort();

  if (tsFiles.length < 2) {
    issues.push({
      severity: "warning",
      file: dirName,
      message: `Only ${tsFiles.length} translation file(s) found, nothing to compare`,
    });
    return issues;
  }

  console.log(`\n=== Validating ${dirName} ===`);
  console.log(`Found ${tsFiles.length} translation files: ${tsFiles.join(", ")}`);

  // Parse-validate every file first — catch syntactic errors before the structural check.
  // If ANY file fails to parse we skip the structural comparison (it would be meaningless).
  let anyParseError = false;
  for (const file of tsFiles) {
    const parseIssues = await validateFileParses(path.join(dir, file), dirName, file);
    for (const issue of parseIssues) {
      if (issue.severity === "error") anyParseError = true;
      issues.push(issue);
    }
  }
  if (anyParseError) {
    issues.push({
      severity: "warning",
      file: dirName,
      message: "Skipping structural comparison because one or more files failed to parse",
    });
    return issues;
  }

  // Duplicate-key detection — two sibling entries with the same dotted path.
  // JS parses this silently (last wins), but it's almost always a bug.
  for (const file of tsFiles) {
    const entries = parseTranslationFile(path.join(dir, file));
    const seen = new Map<string, number>();
    for (const entry of entries) {
      if (entry.type !== "key-value") continue;
      const prev = seen.get(entry.fullPath);
      if (prev !== undefined) {
        issues.push({
          severity: "error",
          file: `${dirName}/${file}`,
          line: entry.line,
          message: `Duplicate key "${entry.fullPath}" — first seen at line ${prev}`,
        });
      } else {
        seen.set(entry.fullPath, entry.line);
      }
    }
  }

  // Use English as the reference
  const enFile = tsFiles.find((f) => f === "en.ts");
  if (!enFile) {
    issues.push({
      severity: "error",
      file: dirName,
      message: "No en.ts file found to use as reference",
    });
    return issues;
  }

  const refPath = path.join(dir, enFile);
  const refEntries = parseTranslationFile(refPath);
  const refStructural = getStructuralKeys(refEntries);

  const otherFiles = tsFiles.filter((f) => f !== "en.ts");

  for (const file of otherFiles) {
    const filePath = path.join(dir, file);
    const entries = parseTranslationFile(filePath);
    const structural = getStructuralKeys(entries);

    // Compare structural keys
    const maxLen = Math.max(refStructural.length, structural.length);

    for (let i = 0; i < maxLen; i++) {
      const ref = refStructural[i];
      const cur = structural[i];

      if (!ref && cur) {
        issues.push({
          severity: "error",
          file: `${dirName}/${file}`,
          line: cur.line,
          message: `Extra key "${cur.fullPath}" not in en.ts`,
        });
        continue;
      }

      if (ref && !cur) {
        issues.push({
          severity: "error",
          file: `${dirName}/${file}`,
          line: ref.line,
          message: `Missing key "${ref.fullPath}" (present in en.ts at line ${ref.line})`,
        });
        continue;
      }

      if (ref!.type !== cur!.type || ref!.key !== cur!.key || ref!.fullPath !== cur!.fullPath) {
        issues.push({
          severity: "error",
          file: `${dirName}/${file}`,
          line: cur!.line,
          message: `Key mismatch at position ${i + 1}: en.ts has "${ref!.fullPath}" (${ref!.type}) but ${file} has "${cur!.fullPath}" (${cur!.type})`,
        });
      } else if (ref!.line !== cur!.line) {
        issues.push({
          severity: "warning",
          file: `${dirName}/${file}`,
          line: cur!.line,
          message: `Line mismatch for "${ref!.fullPath}": en.ts line ${ref!.line}, ${file} line ${cur!.line}`,
        });
      }
    }

    // Also check for keys in this file not in English
    const refKeyPaths = new Set(refStructural.filter((e) => e.type === "key-value").map((e) => e.fullPath));
    const curKeyPaths = structural.filter((e) => e.type === "key-value").map((e) => e.fullPath);

    for (const kp of curKeyPaths) {
      if (!refKeyPaths.has(kp)) {
        issues.push({
          severity: "error",
          file: `${dirName}/${file}`,
          message: `Key "${kp}" exists in ${file} but not in en.ts`,
        });
      }
    }

    const curKeySet = new Set(curKeyPaths);
    for (const kp of refKeyPaths) {
      if (!curKeySet.has(kp)) {
        issues.push({
          severity: "error",
          file: `${dirName}/${file}`,
          message: `Key "${kp}" exists in en.ts but not in ${file}`,
        });
      }
    }
  }

  return issues;
}

// ============================================================================
// Main
// ============================================================================
async function main() {
  let totalIssues = 0;
  let totalErrors = 0;
  let totalWarnings = 0;

  for (const dir of I18N_DIRS) {
    if (!fs.existsSync(dir)) {
      console.log(`Skipping ${dir} (not found)`);
      continue;
    }

    const issues = await validateDirectory(dir);

    if (issues.length === 0) {
      console.log("  All files are consistent!");
    } else {
      for (const issue of issues) {
        const lineStr = issue.line ? `:${issue.line}` : "";
        const prefix = issue.severity === "error" ? "ERROR" : "WARN ";
        console.log(`  ${prefix} ${issue.file}${lineStr}: ${issue.message}`);
      }
    }

    const errors = issues.filter((i) => i.severity === "error").length;
    const warnings = issues.filter((i) => i.severity === "warning").length;
    totalErrors += errors;
    totalWarnings += warnings;
    totalIssues += issues.length;
  }

  console.log(`\n=== Summary ===`);
  console.log(`Total: ${totalErrors} errors, ${totalWarnings} warnings`);

  if (totalErrors > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Validator crashed:", err);
  process.exit(1);
});
