/**
 * Admin section registry.
 *
 * Each section corresponds to a top-level page inside the backoffice
 * (`AdminDashboard`). An admin's `permissions` array is a list of these
 * keys, with the wildcard `"*"` granting access to every section.
 *
 * Client and server both import this registry so the gate is identical on
 * both sides: the server enforces it via `requireAdminSection(key)`, and the
 * client filters the sidebar with `hasAdminSection(permissions, key)`.
 */

export const ADMIN_SECTIONS = [
  "personas",
  "library",
  "voices",
  "models",
  "sessions",
  "contacts",
  "licenses",
  "identity-providers",
  "activity-log",
  "deep-analyses",
  "public-symbols",
  "crm",
  "admins",
] as const;

export type AdminSection = (typeof ADMIN_SECTIONS)[number];

export const ADMIN_WILDCARD_PERMISSION = "*" as const;

/**
 * Returns true if the admin's permission list grants access to the given
 * section. `"*"` matches anything.
 */
export function hasAdminSection(
  permissions: readonly string[] | null | undefined,
  section: AdminSection,
): boolean {
  if (!permissions) return false;
  if (permissions.includes(ADMIN_WILDCARD_PERMISSION)) return true;
  return permissions.includes(section);
}

/**
 * Coerces a raw permissions value (e.g. from form input) into a clean,
 * validated list. Unknown keys are dropped; `"*"` is preserved.
 */
export function sanitizeAdminPermissions(input: unknown): AdminSection[] | ["*"] {
  if (!Array.isArray(input)) return [];
  const out = new Set<string>();
  for (const raw of input) {
    if (typeof raw !== "string") continue;
    if (raw === ADMIN_WILDCARD_PERMISSION) return [ADMIN_WILDCARD_PERMISSION];
    if ((ADMIN_SECTIONS as readonly string[]).includes(raw)) out.add(raw);
  }
  return Array.from(out) as AdminSection[];
}
