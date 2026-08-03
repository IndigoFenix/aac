// server/services/packages/symbolImageAccess.ts
//
// Access gate for custom-symbol IMAGES.
//
// `GET /api/custom-symbols/:id/image` used to be `requireAuth` with no
// ownership check at all: any authenticated user could fetch any symbol image
// by id. That is what made "staff portraits stay inside the institute" untrue
// in practice, and it is the reason class B needs a gate rather than just a
// validator. See planning-docs/aac-packages-plan.md §3.4.
//
// Ordered cheapest-first so the overwhelmingly common case — public art, or
// non-person imagery — costs no joins and stays publicly cacheable.

import { and, eq } from "drizzle-orm";
import {
  customSymbols,
  instituteStudents,
  instituteSymbolAssociations,
  instituteUsers,
  packageAssignments,
  packageBoards,
  studentSymbolAssociations,
  userStudents,
  userSymbolAssociations,
  boards,
} from "@shared/schema";
import { db } from "../../db";

export type SymbolImageDecision =
  | { allowed: true; cache: "public" | "private" }
  | { allowed: false };

/**
 * May `userId` fetch this symbol's image bytes?
 *
 * Allowed when ANY of:
 *   1. the symbol is public + approved            → freely cacheable
 *   2. it does not depict a person                → existing behaviour
 *   3. the user holds it directly                 → their own upload
 *   4. an institute they belong to holds it       → e.g. a staff portrait
 *   5. a student they are linked to holds it
 *   6. a student they are linked to has a package containing a board that
 *      references it                              → the package case
 *
 * (6) is what lets a package's staff portraits render on the AAC device.
 */
export async function canReadSymbolImage(
  symbolId: string,
  userId: string | undefined,
): Promise<SymbolImageDecision> {
  const [symbol] = await db
    .select({
      id: customSymbols.id,
      isPublic: customSymbols.isPublic,
      isApproved: customSymbols.isApproved,
      personImage: customSymbols.personImage,
    })
    .from(customSymbols)
    .where(eq(customSymbols.id, symbolId))
    .limit(1);
  if (!symbol) return { allowed: false };

  // 1 — public art. No joins, long cache.
  if (symbol.isPublic && symbol.isApproved) return { allowed: true, cache: "public" };

  // 2 — not a person. Preserves the previous behaviour for ordinary symbols,
  // which are the vast majority and carry no personal data.
  if (!symbol.personImage) return { allowed: true, cache: "public" };

  if (!userId) return { allowed: false };

  // 3 — the user's own association.
  const [own] = await db
    .select({ id: userSymbolAssociations.id })
    .from(userSymbolAssociations)
    .where(
      and(eq(userSymbolAssociations.symbolId, symbolId), eq(userSymbolAssociations.userId, userId)),
    )
    .limit(1);
  if (own) return { allowed: true, cache: "private" };

  // 4 — an institute the user belongs to holds it.
  const [viaInstitute] = await db
    .select({ id: instituteSymbolAssociations.id })
    .from(instituteSymbolAssociations)
    .innerJoin(
      instituteUsers,
      eq(instituteUsers.instituteId, instituteSymbolAssociations.instituteId),
    )
    .where(
      and(
        eq(instituteSymbolAssociations.symbolId, symbolId),
        eq(instituteUsers.userId, userId),
        eq(instituteUsers.isActive, true),
      ),
    )
    .limit(1);
  if (viaInstitute) return { allowed: true, cache: "private" };

  // 5 — a student the user is linked to holds it.
  const [viaStudent] = await db
    .select({ id: studentSymbolAssociations.id })
    .from(studentSymbolAssociations)
    .innerJoin(userStudents, eq(userStudents.studentId, studentSymbolAssociations.studentId))
    .where(
      and(
        eq(studentSymbolAssociations.symbolId, symbolId),
        eq(userStudents.userId, userId),
        eq(userStudents.isActive, true),
      ),
    )
    .limit(1);
  if (viaStudent) return { allowed: true, cache: "private" };

  // 6 — reachable through a package attached to one of the user's students.
  // The symbol ref lives inside the board IR, so this is a containment test on
  // the serialised JSON rather than a join on a ref table.
  const candidates = await db
    .select({ irData: boards.irData })
    .from(userStudents)
    .innerJoin(packageAssignments, eq(packageAssignments.studentId, userStudents.studentId))
    .innerJoin(packageBoards, eq(packageBoards.packageId, packageAssignments.packageId))
    .innerJoin(boards, eq(boards.id, packageBoards.boardId))
    .where(and(eq(userStudents.userId, userId), eq(userStudents.isActive, true)));
  const needle = `symbol:${symbolId}`;
  for (const row of candidates) {
    if (row.irData && JSON.stringify(row.irData).includes(needle)) {
      return { allowed: true, cache: "private" };
    }
  }

  // Also allow when the student is reached through institute enrolment rather
  // than a direct user link (an institute admin viewing a device's board).
  const enrolled = await db
    .select({ irData: boards.irData })
    .from(instituteUsers)
    .innerJoin(instituteStudents, eq(instituteStudents.instituteId, instituteUsers.instituteId))
    .innerJoin(packageAssignments, eq(packageAssignments.studentId, instituteStudents.studentId))
    .innerJoin(packageBoards, eq(packageBoards.packageId, packageAssignments.packageId))
    .innerJoin(boards, eq(boards.id, packageBoards.boardId))
    .where(
      and(
        eq(instituteUsers.userId, userId),
        eq(instituteUsers.isActive, true),
        eq(instituteStudents.isActive, true),
      ),
    );
  for (const row of enrolled) {
    if (row.irData && JSON.stringify(row.irData).includes(needle)) {
      return { allowed: true, cache: "private" };
    }
  }

  return { allowed: false };
}
