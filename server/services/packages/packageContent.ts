// server/services/packages/packageContent.ts
//
// The content gate: what may be inside a package, at what visibility.
//
// `shared/package-validation.ts` holds the pure walker; this module supplies it
// with the data it cannot see from the client — chiefly WHICH custom symbols
// depict identifiable people (`customSymbols.personImage`).
//
// Class B (staff portraits, photos of real adults) is allowed inside an
// institute-visible package and barred from a public one. Class C (a student's
// contacts) is barred everywhere. See planning-docs/aac-packages-plan.md §3.

import { inArray } from "drizzle-orm";
import { customSymbols, type Board } from "@shared/schema";
import { db } from "../../db";
import {
  validateBoardForPackage,
  type PackageValidationFinding,
  type PackageVisibilityForValidation,
} from "@shared/package-validation";
import { packageRepository } from "../../repositories/packageRepository";
import { boardRepository } from "../../repositories/boardRepository";

/** `symbol:<id>` occurrences anywhere in a board's IR. */
const SYMBOL_REF = /symbol:([A-Za-z0-9_-]+)/g;

/** Pull every custom-symbol id referenced by these boards' IR. */
function collectSymbolIds(irDatas: readonly unknown[]): string[] {
  const ids = new Set<string>();
  for (const ir of irDatas) {
    if (!ir) continue;
    // Cheap and complete: the refs are opaque tokens, so a text scan of the
    // serialised IR finds them wherever they sit (glyph, fallback, symbolPath).
    const json = JSON.stringify(ir);
    SYMBOL_REF.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = SYMBOL_REF.exec(json)) !== null) ids.add(m[1]);
  }
  return Array.from(ids);
}

/**
 * Which of these symbol ids depict identifiable people?
 *
 * Returns an empty set for an empty input without touching the DB — the common
 * case is a board of emoji and generated art.
 */
export async function findPersonImageSymbolIds(
  symbolIds: readonly string[],
): Promise<Set<string>> {
  if (symbolIds.length === 0) return new Set();
  const rows = await db
    .select({ id: customSymbols.id, personImage: customSymbols.personImage })
    .from(customSymbols)
    .where(inArray(customSymbols.id, symbolIds as string[]));
  return new Set(rows.filter((r) => r.personImage).map((r) => r.id));
}

/** Validate ONE board against a target visibility, with class-B data loaded. */
export async function checkBoardForPackage(
  board: Pick<Board, "id" | "irData">,
  visibility: PackageVisibilityForValidation,
  siblingBoardIds?: ReadonlySet<string>,
): Promise<PackageValidationFinding[]> {
  const personImageSymbolIds =
    visibility === "public"
      ? await findPersonImageSymbolIds(collectSymbolIds([board.irData]))
      : new Set<string>();

  const result = validateBoardForPackage(board.irData, {
    visibility,
    personImageSymbolIds,
    siblingBoardIds,
  });
  return result.ok ? [] : result.findings;
}

export interface PublishCheckFinding extends PackageValidationFinding {
  boardId: string;
  boardName: string;
}

/**
 * Validate EVERY board in a package against a target visibility.
 *
 * This is the pre-flight for publishing: flipping institute → public is the one
 * moment class-B content changes legal status, so the whole package is
 * re-checked rather than trusting per-add validation done at the old visibility.
 */
export async function checkPackageForVisibility(
  packageId: string,
  visibility: PackageVisibilityForValidation,
): Promise<PublishCheckFinding[]> {
  const members = await packageRepository.listBoards(packageId);
  if (members.length === 0) return [];

  const full = await Promise.all(members.map((m) => boardRepository.getBoard(m.id)));
  const boards = full.filter((b): b is Board => Boolean(b));
  const siblingIds = new Set(boards.map((b) => b.id));

  const personImageSymbolIds =
    visibility === "public"
      ? await findPersonImageSymbolIds(collectSymbolIds(boards.map((b) => b.irData)))
      : new Set<string>();

  const findings: PublishCheckFinding[] = [];
  for (const board of boards) {
    const result = validateBoardForPackage(board.irData, {
      visibility,
      personImageSymbolIds,
      siblingBoardIds: siblingIds,
    });
    if (!result.ok) {
      for (const f of result.findings) {
        findings.push({ ...f, boardId: board.id, boardName: board.name });
      }
    }
  }
  return findings;
}
