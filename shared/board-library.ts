// shared/board-library.ts
//
// The shape of GET /api/boards/library — the board picker's whole content,
// grouped and permission-resolved on the server.
//
// This lives in shared/ because the grouping IS the contract: the client must
// not re-derive "which section does this board belong to" or "may I edit it"
// from row fields, which is exactly how the picker ended up showing a
// colleague's board under the wrong heading and offering Save on package
// content it could not write.

/** One board as the picker lists it — metadata only, never `irData`. */
export interface BoardLibraryEntry {
  id: string;
  name: string;
  studentId?: string | null;
  instituteId?: string | null;
  scope?: string;
  automaticSelection?: boolean | null;
  automaticSelectionHint?: string | null;
  isGenerated?: boolean | null;
  /** Set on boards listed under a package section, for the editor's badge. */
  packageName?: string;
  /**
   * May THIS caller save changes to this board? The server enforces the same
   * answer on PATCH /api/boards/:id — this field only spares the user a
   * round-trip to find out.
   */
  canEdit?: boolean;
  loadedAt?: string | Date;
}

export type BoardLibraryGroupKind = "unassigned" | "package" | "student";

export interface BoardLibraryGroup {
  kind: BoardLibraryGroupKind;
  /** Package id / student id. Null for the "Not assigned" section. */
  id: string | null;
  /** Package or student name. Empty for "Not assigned" — the client labels it. */
  name: string;
  /** For a package section: may the caller edit this package's content? */
  canEdit: boolean;
  boards: BoardLibraryEntry[];
}

export interface BoardLibraryResponse {
  /**
   * False when no institute is selected. Every board must belong to a student
   * or an institute, so with neither there is nothing a new board could be
   * saved to.
   */
  canCreate: boolean;
  /** Ordered — the order is part of the answer, not a client preference. */
  groups: BoardLibraryGroup[];
}
