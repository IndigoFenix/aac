/**
 * package-validation.ts
 *
 * Content gate for boards entering a package. Shared so the clinician client
 * can pre-flight before submitting and the server can enforce on write.
 *
 * Three content classes (see planning-docs/aac-packages-plan.md §3):
 *
 *   A — Neutral            emoji, generated symbols, uploaded non-person art
 *                          → allowed everywhere
 *   B — Institute person    staff portraits, photos of identifiable adults
 *                          → institute-visible packages only, never public
 *   C — Student-linked      face: refs to student contacts, student photos
 *                          → barred from packages entirely
 *
 * SHIPPED (P2): class C. `face:` refs resolve to `studentContacts` — that
 * student's PHI — and would not resolve for anyone else in any case.
 *
 * PENDING (P5): class B, which needs `customSymbols.personImage` to exist
 * before there is anything to check. The `personImageSymbolIds` option and the
 * `visibility` discriminator are already threaded through so P5 is an addition
 * here rather than a change at every call site.
 */

export type PackageVisibilityForValidation = "institute" | "public";

export interface PackageValidationFinding {
  /** Button id when the problem is localised to one button; null for board-level. */
  buttonId: string | null;
  /** Page id the button lives on, when known. */
  pageId: string | null;
  /** Machine-readable reason, for i18n on the client. */
  reason:
    | "student_face_ref"
    | "person_image_in_public"
    | "dangling_board_link";
  /** The offending value, for pointing the user at it. */
  detail: string;
}

export interface PackageValidationOptions {
  visibility: PackageVisibilityForValidation;
  /** P5: ids of customSymbols flagged `personImage`. Unused until then. */
  personImageSymbolIds?: ReadonlySet<string>;
  /**
   * Board ids that are also in this package. When supplied, a button linking
   * to a board OUTSIDE the package is reported as dangling — it would not
   * resolve for anyone who only has the package.
   */
  siblingBoardIds?: ReadonlySet<string>;
}

export type PackageValidationResult =
  | { ok: true; findings: [] }
  | { ok: false; findings: PackageValidationFinding[] };

/** Every string field on a button that can carry a symbol/face reference. */
const REF_FIELDS = ["glyph", "glyphFallback", "symbolPath", "iconRef", "imageKey"] as const;

/** `face:<contactId>` — a reference to a student contact. Always class C. */
const FACE_REF = /face:([A-Za-z0-9_-]+)/g;

/** `symbol:<id>` — a custom symbol reference. Class A or B depending on the symbol. */
const SYMBOL_REF = /symbol:([A-Za-z0-9_-]+)/g;

function matchAll(value: unknown, re: RegExp): string[] {
  if (typeof value !== "string" || !value) return [];
  // Fresh lastIndex per call — the regexes are module-level and /g is stateful.
  re.lastIndex = 0;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(value)) !== null) out.push(m[1]);
  return out;
}

/**
 * Check one board's IR for content that may not enter a package.
 *
 * Tolerant of malformed IR: anything it cannot understand is skipped rather
 * than thrown on. A validator that crashes on a weird board would block the
 * whole feature; the worst case of skipping is that P5's attestation catches it.
 */
export function validateBoardForPackage(
  irData: unknown,
  opts: PackageValidationOptions,
): PackageValidationResult {
  const findings: PackageValidationFinding[] = [];
  const pages = (irData as any)?.pages;
  if (!Array.isArray(pages)) return { ok: true, findings: [] };

  for (const page of pages) {
    const pageId = typeof page?.id === "string" ? page.id : null;
    const buttons = Array.isArray(page?.buttons) ? page.buttons : [];

    for (const button of buttons) {
      const buttonId = typeof button?.id === "string" ? button.id : null;

      for (const field of REF_FIELDS) {
        const value = button?.[field];

        // Class C — a student contact's face. Barred at every visibility.
        for (const contactId of matchAll(value, FACE_REF)) {
          findings.push({
            buttonId,
            pageId,
            reason: "student_face_ref",
            detail: `face:${contactId}`,
          });
        }

        // Class B — person imagery. Institute-visible packages may carry staff
        // portraits; public ones may not. Inert until P5 supplies the ids.
        if (opts.visibility === "public" && opts.personImageSymbolIds?.size) {
          for (const symbolId of matchAll(value, SYMBOL_REF)) {
            if (opts.personImageSymbolIds.has(symbolId)) {
              findings.push({
                buttonId,
                pageId,
                reason: "person_image_in_public",
                detail: `symbol:${symbolId}`,
              });
            }
          }
        }
      }

      // A board-to-board link pointing outside the package dangles for anyone
      // who only has the package.
      const toBoardId = button?.action?.toBoardId;
      if (
        typeof toBoardId === "string" &&
        toBoardId &&
        opts.siblingBoardIds &&
        !opts.siblingBoardIds.has(toBoardId)
      ) {
        findings.push({
          buttonId,
          pageId,
          reason: "dangling_board_link",
          detail: toBoardId,
        });
      }
    }
  }

  return findings.length === 0
    ? { ok: true, findings: [] }
    : { ok: false, findings };
}

/** Human-readable one-liner for logs and error messages (NOT for the UI — the UI translates `reason`). */
export function describePackageFindings(findings: readonly PackageValidationFinding[]): string {
  return findings
    .map((f) => {
      const where = f.buttonId ? `button "${f.buttonId}"` : "the board";
      switch (f.reason) {
        case "student_face_ref":
          return `${where} shows a person from the student's contacts (${f.detail})`;
        case "person_image_in_public":
          return `${where} uses an image of a real person (${f.detail}), which cannot be public`;
        case "dangling_board_link":
          return `${where} links to a board that is not in this package (${f.detail})`;
      }
    })
    .join("; ");
}
