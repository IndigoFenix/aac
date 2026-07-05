/**
 * i18n consistency validator.
 *
 * Compares every locale file in `src/ui/app/i18n/` against `en.ts`, ensuring:
 *   - identical key paths
 *   - identical key order (and same line numbers, as a soft check)
 *   - no syntax errors / missing exports
 *   - no duplicate sibling keys (which JS silently last-wins)
 *
 * Run: `npm run validate-i18n`
 *
 * Adapted from a similar validator in another project. Two notable changes:
 *   1. Pointed at `src/ui/app/i18n/` (single tree, not two).
 *   2. The expected export name follows the locale key, e.g. `en.ts` exports
 *      `export const en = { ... }`. The legacy validator inferred the export
 *      name from the filename without the `.ts` — same convention works here.
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..', '..');

const I18N_DIRS = [path.join(ROOT, 'src', 'ui', 'app', 'i18n')];

interface KeyInfo {
	line: number;
	key: string;
	fullPath: string;
	depth: number;
	type: 'key-value' | 'section-open' | 'section-close' | 'comment' | 'blank' | 'other';
	raw: string;
}

interface Issue {
	severity: 'error' | 'warning';
	file: string;
	line?: number;
	message: string;
}

function parseTranslationFile(filePath: string): KeyInfo[] {
	const content = fs.readFileSync(filePath, 'utf-8');
	const lines = content.split('\n');
	const result: KeyInfo[] = [];
	const pathStack: string[] = [];
	let depth = 0;
	let insideExport = false;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const trimmed = line.trim();
		const lineNum = i + 1;

		if (!insideExport) {
			if (trimmed.match(/^export\s+const\s+\w+/)) {
				insideExport = true;
			}
			continue;
		}

		if (trimmed === '};' && depth === 0) {
			break;
		}

		if (trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) {
			result.push({ line: lineNum, key: '', fullPath: pathStack.join('.'), depth, type: 'comment', raw: trimmed });
			continue;
		}

		if (trimmed === '') {
			result.push({ line: lineNum, key: '', fullPath: pathStack.join('.'), depth, type: 'blank', raw: '' });
			continue;
		}

		const sectionOpen = trimmed.match(/^(\w+)\s*:\s*\{/);
		if (sectionOpen) {
			const key = sectionOpen[1];
			pathStack.push(key);
			result.push({ line: lineNum, key, fullPath: pathStack.join('.'), depth, type: 'section-open', raw: trimmed });
			depth++;
			continue;
		}

		if (trimmed === '}' || trimmed === '},') {
			depth--;
			result.push({ line: lineNum, key: '', fullPath: pathStack.join('.'), depth, type: 'section-close', raw: trimmed });
			pathStack.pop();
			continue;
		}

		const keyValue = trimmed.match(/^(\w+)\s*:/);
		if (keyValue) {
			const key = keyValue[1];
			result.push({
				line: lineNum,
				key,
				fullPath: [...pathStack, key].join('.'),
				depth,
				type: 'key-value',
				raw: trimmed,
			});
			continue;
		}

		result.push({ line: lineNum, key: '', fullPath: pathStack.join('.'), depth, type: 'other', raw: trimmed });
	}

	return result;
}

function getStructuralKeys(entries: KeyInfo[]): KeyInfo[] {
	return entries.filter(
		(e) => e.type === 'key-value' || e.type === 'section-open' || e.type === 'section-close',
	);
}

async function validateFileParses(filePath: string, dirName: string, file: string): Promise<Issue[]> {
	try {
		const url = pathToFileURL(filePath).href + `?t=${Date.now()}`;
		const mod = await import(url);
		const exportName = file.replace(/\.ts$/, '');
		const candidate = (mod as Record<string, unknown>)[exportName] ?? (mod as Record<string, unknown>).default;
		if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
			return [{
				severity: 'error',
				file: `${dirName}/${file}`,
				message: `Export '${exportName}' is missing or is not a plain object — the translation map isn't structured correctly`,
			}];
		}
		const otherExports = Object.keys(mod).filter(
			(k) => k !== exportName && k !== 'default' && typeof (mod as Record<string, unknown>)[k] !== 'function',
		);
		if (otherExports.length > 0) {
			return [{
				severity: 'warning',
				file: `${dirName}/${file}`,
				message: `Unexpected extra exports alongside '${exportName}': ${otherExports.join(', ')}`,
			}];
		}
		return [];
	} catch (err) {
		const e = err as { message?: string; stack?: string };
		const msg = e?.message || String(err);
		const locMatch = typeof e?.stack === 'string' ? e.stack.match(/:(\d+):(\d+)/) : null;
		return [{
			severity: 'error',
			file: `${dirName}/${file}`,
			line: locMatch ? Number(locMatch[1]) : undefined,
			message: `Syntax / parse error: ${msg.split('\n')[0]}`,
		}];
	}
}

async function validateDirectory(dir: string): Promise<Issue[]> {
	const issues: Issue[] = [];
	const dirName = path.relative(ROOT, dir);

	const tsFiles = fs
		.readdirSync(dir)
		.filter((f) => f.endsWith('.ts') && f !== 'index.ts' && f !== 'types.ts')
		.sort();

	if (tsFiles.length < 2) {
		issues.push({
			severity: 'warning',
			file: dirName,
			message: `Only ${tsFiles.length} translation file(s) found, nothing to compare`,
		});
		return issues;
	}

	console.log(`\n=== Validating ${dirName} ===`);
	console.log(`Found ${tsFiles.length} translation files: ${tsFiles.join(', ')}`);

	let anyParseError = false;
	for (const file of tsFiles) {
		const parseIssues = await validateFileParses(path.join(dir, file), dirName, file);
		for (const issue of parseIssues) {
			if (issue.severity === 'error') anyParseError = true;
			issues.push(issue);
		}
	}
	if (anyParseError) {
		issues.push({
			severity: 'warning',
			file: dirName,
			message: 'Skipping structural comparison because one or more files failed to parse',
		});
		return issues;
	}

	for (const file of tsFiles) {
		const entries = parseTranslationFile(path.join(dir, file));
		const seen = new Map<string, number>();
		for (const entry of entries) {
			if (entry.type !== 'key-value') continue;
			const prev = seen.get(entry.fullPath);
			if (prev !== undefined) {
				issues.push({
					severity: 'error',
					file: `${dirName}/${file}`,
					line: entry.line,
					message: `Duplicate key "${entry.fullPath}" — first seen at line ${prev}`,
				});
			} else {
				seen.set(entry.fullPath, entry.line);
			}
		}
	}

	const enFile = tsFiles.find((f) => f === 'en.ts');
	if (!enFile) {
		issues.push({ severity: 'error', file: dirName, message: 'No en.ts file found to use as reference' });
		return issues;
	}

	const refPath = path.join(dir, enFile);
	const refEntries = parseTranslationFile(refPath);
	const refStructural = getStructuralKeys(refEntries);
	const otherFiles = tsFiles.filter((f) => f !== 'en.ts');

	for (const file of otherFiles) {
		const filePath = path.join(dir, file);
		const entries = parseTranslationFile(filePath);
		const structural = getStructuralKeys(entries);

		const maxLen = Math.max(refStructural.length, structural.length);

		for (let i = 0; i < maxLen; i++) {
			const ref = refStructural[i];
			const cur = structural[i];

			if (!ref && cur) {
				issues.push({
					severity: 'error',
					file: `${dirName}/${file}`,
					line: cur.line,
					message: `Extra key "${cur.fullPath}" not in en.ts`,
				});
				continue;
			}

			if (ref && !cur) {
				issues.push({
					severity: 'error',
					file: `${dirName}/${file}`,
					line: ref.line,
					message: `Missing key "${ref.fullPath}" (present in en.ts at line ${ref.line})`,
				});
				continue;
			}

			if (ref!.type !== cur!.type || ref!.key !== cur!.key || ref!.fullPath !== cur!.fullPath) {
				issues.push({
					severity: 'error',
					file: `${dirName}/${file}`,
					line: cur!.line,
					message: `Key mismatch at position ${i + 1}: en.ts has "${ref!.fullPath}" (${ref!.type}) but ${file} has "${cur!.fullPath}" (${cur!.type})`,
				});
			} else if (ref!.line !== cur!.line) {
				issues.push({
					severity: 'warning',
					file: `${dirName}/${file}`,
					line: cur!.line,
					message: `Line mismatch for "${ref!.fullPath}": en.ts line ${ref!.line}, ${file} line ${cur!.line}`,
				});
			}
		}

		const refKeyPaths = new Set(refStructural.filter((e) => e.type === 'key-value').map((e) => e.fullPath));
		const curKeyPaths = structural.filter((e) => e.type === 'key-value').map((e) => e.fullPath);

		for (const kp of curKeyPaths) {
			if (!refKeyPaths.has(kp)) {
				issues.push({
					severity: 'error',
					file: `${dirName}/${file}`,
					message: `Key "${kp}" exists in ${file} but not in en.ts`,
				});
			}
		}

		const curKeySet = new Set(curKeyPaths);
		for (const kp of refKeyPaths) {
			if (!curKeySet.has(kp)) {
				issues.push({
					severity: 'error',
					file: `${dirName}/${file}`,
					message: `Key "${kp}" exists in en.ts but not in ${file}`,
				});
			}
		}
	}

	return issues;
}

async function main() {
	let totalErrors = 0;
	let totalWarnings = 0;

	for (const dir of I18N_DIRS) {
		if (!fs.existsSync(dir)) {
			console.log(`Skipping ${dir} (not found)`);
			continue;
		}

		const issues = await validateDirectory(dir);

		if (issues.length === 0) {
			console.log('  All files are consistent!');
		} else {
			for (const issue of issues) {
				const lineStr = issue.line ? `:${issue.line}` : '';
				const prefix = issue.severity === 'error' ? 'ERROR' : 'WARN ';
				console.log(`  ${prefix} ${issue.file}${lineStr}: ${issue.message}`);
			}
		}

		totalErrors += issues.filter((i) => i.severity === 'error').length;
		totalWarnings += issues.filter((i) => i.severity === 'warning').length;
	}

	console.log(`\n=== Summary ===`);
	console.log(`Total: ${totalErrors} errors, ${totalWarnings} warnings`);

	if (totalErrors > 0) {
		process.exit(1);
	}
}

main().catch((err) => {
	console.error('Validator crashed:', err);
	process.exit(1);
});
