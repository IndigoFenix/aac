/**
 * Utilities for multilingual text fields stored as either
 * a plain string or a JSON object like {"en": "...", "he": "..."}.
 */

export type MultilingualText = string; // plain string OR JSON {"en":"...", "he":"..."}

/**
 * Resolve a multilingual text field to a single string for the given language.
 * Falls back to English, then to the first available value, then to the raw string.
 */
export function resolveLocalizedText(value: string | null | undefined, language: string): string {
  if (!value) return '';
  try {
    const parsed = JSON.parse(value);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed[language] || parsed['en'] || Object.values(parsed)[0] as string || value;
    }
  } catch {
    // Not JSON, return as-is
  }
  return value;
}

/**
 * Check if a text field contains multilingual JSON.
 */
export function isMultilingual(value: string | null | undefined): boolean {
  if (!value) return false;
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

/**
 * Parse a multilingual text field into its language map, or null if it's a plain string.
 */
export function parseMultilingual(value: string | null | undefined): Record<string, string> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, string>;
    }
  } catch {
    // plain string
  }
  return null;
}

/**
 * Serialize a language map back to a JSON string, or return a plain string if only one language.
 */
export function serializeMultilingual(map: Record<string, string>): string {
  return JSON.stringify(map);
}
