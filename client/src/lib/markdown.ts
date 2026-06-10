// Safe Markdown rendering for untrusted / LLM-generated content.
//
// `marked` does NOT strip raw inline HTML, so rendering its output directly into
// dangerouslySetInnerHTML lets an injected <img onerror=...> / <iframe> / <svg
// onload=...> execute in the page. Every LLM-output sink must pass through the
// DOMPurify sanitizer here before injection.

import { marked } from "marked";
import DOMPurify from "dompurify";

/** Sanitize an already-rendered HTML string for dangerouslySetInnerHTML. */
export function sanitizeHtml(html: string): string {
  return DOMPurify.sanitize(html ?? "");
}

/**
 * Render untrusted Markdown to sanitized HTML safe for dangerouslySetInnerHTML.
 * Use this for any model-generated or user-influenced markdown.
 */
export function renderMarkdownSafe(md: string | null | undefined): string {
  const html = marked.parse(md ?? "", { async: false }) as string;
  return sanitizeHtml(html);
}
