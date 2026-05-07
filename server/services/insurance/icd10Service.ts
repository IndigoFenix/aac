import { readFileSync } from "fs";
import { resolve } from "path";

export interface IcdCode {
  code: string;
  description: string;
  category: string;
  /** Marked when the code is the "unspecified" tail of its parent — payers reject these for AAC LMNs. */
  unspecified: boolean;
  /** Billing regimes this code is curated for. */
  regimes: string[];
}

// Resolve relative to the repo root. Both `tsx` (production), `jest`, and
// the build pipeline run with cwd set to the project root, so this is
// portable without depending on `import.meta.url` (which ts-jest's CJS
// transform clashes with — it emits a `__filename` redeclaration).
const SEED_PATH = resolve(process.cwd(), "server/data/icd10-aac.json");

let CODES: IcdCode[] | null = null;
let CODE_INDEX: Map<string, IcdCode> | null = null;

function load(): IcdCode[] {
  if (CODES) return CODES;
  try {
    const raw = readFileSync(SEED_PATH, "utf-8");
    const parsed = JSON.parse(raw) as IcdCode[];
    CODES = parsed;
    CODE_INDEX = new Map(parsed.map((c) => [c.code.toUpperCase(), c]));
    return parsed;
  } catch (err) {
    console.error("[icd10Service] Failed to load seed:", err);
    CODES = [];
    CODE_INDEX = new Map();
    return [];
  }
}

/**
 * Get a single curated code by exact (case-insensitive) match. Returns null
 * for free-text codes not in the curated set — callers should treat that as
 * "no specificity guidance available, accept as-is".
 */
export function getIcdCode(code: string): IcdCode | null {
  load();
  return CODE_INDEX!.get(code.toUpperCase()) ?? null;
}

interface SearchOpts {
  q: string;
  regime?: string;
  limit?: number;
}

/**
 * Substring/prefix search across code + description. Code-prefix matches rank
 * highest, followed by code-substring, then description-substring. Limit
 * defaults to 25 — UI shows a dropdown, not a full list.
 */
export function searchIcdCodes(opts: SearchOpts): IcdCode[] {
  const all = load();
  const q = opts.q.trim().toUpperCase();
  const limit = Math.min(Math.max(opts.limit ?? 25, 1), 100);

  const filteredByRegime = opts.regime
    ? all.filter((c) => c.regimes.includes(opts.regime!))
    : all;

  if (!q) return filteredByRegime.slice(0, limit);

  const codePrefix: IcdCode[] = [];
  const codeSubstring: IcdCode[] = [];
  const descSubstring: IcdCode[] = [];

  for (const c of filteredByRegime) {
    const code = c.code.toUpperCase();
    const desc = c.description.toUpperCase();
    if (code.startsWith(q)) {
      codePrefix.push(c);
    } else if (code.includes(q)) {
      codeSubstring.push(c);
    } else if (desc.includes(q)) {
      descSubstring.push(c);
    }
  }

  return [...codePrefix, ...codeSubstring, ...descSubstring].slice(0, limit);
}
