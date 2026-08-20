/**
 * institute-ref.ts
 *
 * Resolves an institute reference sitting inside a tool PAYLOAD to an institute id.
 *
 * The chat memory surface is name-addressed: Context_Institutes sets
 * displayKey: "name", renderMap (chat/memory-system.ts) prints that name INSTEAD
 * of the raw uuid key, and the institute's own `id` property is not `opened` — so
 * an agent reading its context has never seen an institute uuid. resolveDisplayKeyPath
 * bridges name -> id for PATHS, but a name sitting in a VALUE
 * (student.instituteIds, package.instituteId, location.instituteId) used to reach
 * the membership check verbatim and be rejected with "you are not a member of
 * institute <name>" — the agent doing exactly what the schema told it to do and
 * being denied for it.
 *
 * These helpers accept whichever token the agent actually has (uuid OR display
 * name) and map it onto an institute the user is an active member of. They are a
 * LOOKUP, not an authorization gate: the candidate list is the user's own active
 * memberships, and callers keep their existing permission checks on the result.
 */

import { instituteService } from "../instituteService";

export interface InstituteRefResolution {
  /** Resolved institute ids, de-duplicated, in the order the refs were given. */
  ids: string[];
  /** Refs that matched no institute the user belongs to (original spelling). */
  unresolved: string[];
  /** Names of the institutes the user is a member of — for error messages. */
  available: string[];
}

/** Trim + case-fold + collapse inner whitespace, so " My  Clinic " matches "My Clinic". */
function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Resolves a list of institute refs (ids and/or display names) against the
 * institutes the user is an active member of.
 */
export async function resolveInstituteRefs(
  refs: unknown[],
  userId: string,
): Promise<InstituteRefResolution> {
  const memberships = await instituteService.getUserInstitutesWithMembership(userId);

  const ids = new Set<string>();
  const byName = new Map<string, string>();
  for (const { institute } of memberships) {
    ids.add(institute.id);
    const name = typeof institute.name === "string" ? normalizeName(institute.name) : "";
    // First match wins if two of the user's institutes share a name — the ref is
    // genuinely ambiguous, and refusing it would block a name the user sees as unique.
    if (name && !byName.has(name)) byName.set(name, institute.id);
  }

  const resolved: string[] = [];
  const unresolved: string[] = [];
  for (const raw of refs) {
    if (typeof raw !== "string" || !raw.trim()) {
      unresolved.push(typeof raw === "string" ? raw : String(raw));
      continue;
    }
    const ref = raw.trim();
    const hit = ids.has(ref) ? ref : byName.get(normalizeName(ref));
    if (!hit) {
      unresolved.push(ref);
      continue;
    }
    if (!resolved.includes(hit)) resolved.push(hit);
  }

  return {
    ids: resolved,
    unresolved,
    available: memberships
      .map(({ institute }) => institute.name)
      .filter((n): n is string => typeof n === "string" && n.length > 0),
  };
}

/**
 * Single-ref convenience for scalar `instituteId` fields. Throws the same
 * self-correcting message the list form uses when the ref matches nothing.
 */
export async function resolveInstituteRefOrThrow(
  ref: unknown,
  userId: string,
): Promise<string> {
  const { ids, unresolved, available } = await resolveInstituteRefs([ref], userId);
  if (ids.length === 0) throw new Error(instituteRefError(unresolved, available));
  return ids[0];
}

/**
 * Single-line (sanitizeDbError truncates at the first newline) message naming
 * what the agent can actually pick from.
 */
export function instituteRefError(
  unresolved: string[],
  available: string[],
): string {
  const asked = unresolved.map((u) => `"${u}"`).join(", ");
  const known = available.length
    ? `You are a member of: ${available.join(", ")}.`
    : "You are not a member of any organization.";
  return `No organization matching ${asked}. ${known} Use the organization's name exactly as it appears in Context_Institutes, or omit the field to use the currently selected one.`;
}
