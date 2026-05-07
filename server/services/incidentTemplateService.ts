// Incident-response notification template service.
//
// Loads pre-approved breach-notification templates from
// `server/services/incident-templates/` and fills them with the
// incident-specific facts the duty engineer collects. The templates
// themselves are reviewed once by counsel; this service is the
// fill-in mechanism. See `incident-templates/README.md`.
//
// Why a service rather than ad-hoc string-templating: the GDPR / IL /
// HIPAA windows make incident response time-critical. The duty engineer
// should not be drafting wording at 2am; they should be filling
// `{placeholder}` tokens in a reviewed document.

import { promises as fs } from "node:fs";
import * as path from "node:path";

// Use cwd-based path so the same code works under Jest's CJS runtime and the
// production ESM build (mirrors `mfaService.ts` / `symbolService.ts`).
const TEMPLATES_DIR = path.join(process.cwd(), "server", "services", "incident-templates");

export type IncidentTemplateType =
  | "phi-breach"
  | "security-breach"
  | "vendor-incident";

export type IncidentTemplateLocale = "en" | "he";

/** Result of filling a template — ready for `emailService.sendEmail()`. */
export interface FilledIncidentTemplate {
  type: IncidentTemplateType;
  locale: IncidentTemplateLocale;
  /** Subject line, lifted from the `SUBJECT: ...` first line of the template. */
  subject: string;
  /** Plain-text body with all `{placeholder}` tokens substituted. */
  text: string;
  /** Tokens we couldn't substitute (caller passed nothing). Useful for QA. */
  missingTokens: string[];
}

/** Read a template file into memory. Caches per (type, locale) for the
 *  process lifetime — templates are static. */
const cache = new Map<string, string>();

async function readTemplate(
  type: IncidentTemplateType,
  locale: IncidentTemplateLocale,
): Promise<string> {
  const key = `${type}.${locale}`;
  if (cache.has(key)) return cache.get(key)!;
  const file = path.join(TEMPLATES_DIR, `${type}.${locale}.md`);
  const raw = await fs.readFile(file, "utf8");
  cache.set(key, raw);
  return raw;
}

/** Test helper. */
export function clearIncidentTemplateCache(): void {
  cache.clear();
}

/**
 * Fill an incident template with the supplied variables.
 *
 * - Tokens are `{snake_case}` literals in the template. Any token without
 *   a value in `vars` is left in place and reported in `missingTokens`,
 *   so QA can spot incomplete fill-ins before sending.
 * - The locale falls back to English if the requested file is missing.
 * - Template values are inserted as plain text (no HTML escaping needed
 *   since the body is plain-text email; see `emailService.sendEmail`).
 */
export async function fillIncidentTemplate(
  type: IncidentTemplateType,
  locale: IncidentTemplateLocale,
  vars: Record<string, string>,
): Promise<FilledIncidentTemplate> {
  let raw: string;
  let actualLocale: IncidentTemplateLocale = locale;
  try {
    raw = await readTemplate(type, locale);
  } catch {
    if (locale !== "en") {
      raw = await readTemplate(type, "en");
      actualLocale = "en";
    } else {
      throw new Error(`Incident template not found: ${type}.${locale}.md`);
    }
  }

  // Pull SUBJECT line off the top.
  const lines = raw.split(/\r?\n/);
  const subjectIdx = lines.findIndex((l) => l.startsWith("SUBJECT:"));
  if (subjectIdx === -1) {
    throw new Error(`Template ${type}.${actualLocale}.md is missing a SUBJECT: header`);
  }
  let subject = lines[subjectIdx].replace(/^SUBJECT:\s*/, "");
  // Drop the SUBJECT line + any trailing blank line so the body doesn't
  // start with a stray newline.
  let body = lines.slice(subjectIdx + 1).join("\n").replace(/^\s*\n/, "");

  const missing = new Set<string>();
  const seen = new Set<string>();
  const replace = (s: string) =>
    s.replace(/\{([a-z][a-z0-9_]*)\}/gi, (match, key) => {
      seen.add(key);
      if (Object.prototype.hasOwnProperty.call(vars, key)) {
        return vars[key];
      }
      missing.add(key);
      return match;
    });

  subject = replace(subject);
  body = replace(body);

  return {
    type,
    locale: actualLocale,
    subject,
    text: body,
    missingTokens: Array.from(missing).sort(),
  };
}

/**
 * Lower-level helper for callers that want to preview a template
 * without filling it. Returns the raw text including SUBJECT line.
 */
export async function getIncidentTemplate(
  type: IncidentTemplateType,
  locale: IncidentTemplateLocale,
): Promise<string> {
  return readTemplate(type, locale);
}
