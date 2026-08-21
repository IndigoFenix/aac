/**
 * Pure logic for scripts/migrate-staging-to-prod.ts: table classification,
 * FK-driven closure of the copied row set, dangling-FK fix-ups and insert order.
 * DB-free so it can be unit-tested (server/tests/migration-closure.test.ts).
 */

export type TableClass = "seed" | "global" | "globalInsertOnly" | "pull" | "tenant" | "skip";

export interface FkEdge {
  table: string;
  column: string;
  refTable: string;
  refColumn: string;
  nullable: boolean;
  /** true = inferred from the column-name convention, no SQL constraint */
  soft: boolean;
}

export interface TableMeta {
  name: string;
  pk: string[];
  columns: { name: string; nullable: boolean }[];
}

export type Row = Record<string, unknown>;

export interface Fixup {
  table: string;
  rowId: string;
  column: string;
  refTable: string;
  refId: string;
  action: "null" | "drop";
  reason: string;
}

export interface ClosureInput {
  tables: TableMeta[];
  classes: Map<string, TableClass>;
  fks: FkEdge[];
  /** every non-skipped table, all rows, from staging */
  rows: Map<string, Row[]>;
  seedLicenseIds: Set<string>;
  excludeUser: (u: Row) => boolean;
  excludeStudent: (s: Row) => boolean;
}

export interface ClosureResult {
  /** table → rows to write (already fixed up) */
  included: Map<string, Row[]>;
  fixups: Fixup[];
}

/**
 * Soft-FK naming convention used across shared/schema*.ts where Drizzle has no
 * `.references()` (cross-schema columns). Returns the referenced table or null.
 */
export function SOFT_FK_CONVENTION(column: string): string | null {
  const exact: Record<string, string> = {
    student_id: "students",
    user_id: "users",
    institute_id: "institutes",
    classroom_id: "classrooms",
    program_id: "programs",
    board_id: "boards",
    symbol_id: "custom_symbols",
    venue_id: "venues",
    package_id: "packages",
    app_id: "custom_apps",
    goal_id: "goals",
    objective_id: "objectives",
    service_id: "services",
    contact_id: "student_contacts",
    person_id: "persons",
    room_id: "person_chat_rooms",
    photo_id: "photos",
    biometric_data_id: "biometric_data",
    chat_session_id: "chat_sessions",
    session_id: "chat_sessions",
    grant_id: "account_link_grants",
    event_id: "calendar_events",
    location_id: "locations",
    profile_domain_id: "profile_domains",
    progress_report_id: "progress_reports",
    transition_plan_id: "transition_plans",
    share_invite_id: "student_share_invites",
    invite_code_id: "invite_codes",
    provider_id: "identity_providers",
    user_student_id: "user_students",
    crm_potential_customer_id: "crm_potential_customers",
    institute_user_id: "institute_users",
    signed_consent_id: "student_consent_records",
    goal_progress_entry_id: "goal_progress_entries",
  };
  if (exact[column]) return exact[column];
  // external identifiers that merely END in a conventional suffix
  if (column === "revenuecat_app_user_id") return null;
  // suffix forms: created_by_user_id, linked_student_id, source_institute_id, provider_contact_id …
  const m = /_(user|student|institute|contact|person|classroom|program|board)_id$/.exec(column);
  if (m) return exact[`${m[1]}_id`];
  return null;
}

export function classifyTables(
  all: string[],
  lists: Record<Exclude<TableClass, "tenant">, string[]>,
): Map<string, TableClass> {
  const out = new Map<string, TableClass>();
  for (const [cls, names] of Object.entries(lists) as [TableClass, string[]][]) {
    for (const n of names) {
      if (out.has(n)) throw new Error(`Table ${n} listed twice (${out.get(n)} and ${cls})`);
      out.set(n, cls);
    }
  }
  const missing = [...out.keys()].filter((n) => !all.includes(n));
  if (missing.length) throw new Error(`Classified tables not in schema: ${missing.join(", ")}`);
  for (const t of all) if (!out.has(t)) out.set(t, "tenant");
  return out;
}

const key = (v: unknown) => String(v);

export function computeClosure(input: ClosureInput): ClosureResult {
  const { tables, classes, fks, rows } = input;
  const meta = new Map(tables.map((t) => [t.name, t]));
  const pkOf = (t: string) => {
    const pk = meta.get(t)?.pk ?? [];
    if (pk.length !== 1) throw new Error(`Table ${t} needs a single-column PK (has ${pk.length})`);
    return pk[0];
  };
  const idOf = (t: string, r: Row) => key(r[pkOf(t)]);
  const byId = new Map<string, Map<string, Row>>();
  for (const [t, list] of rows) byId.set(t, new Map(list.map((r) => [idOf(t, r), r])));

  /** table → set of included ids */
  const inc = new Map<string, Set<string>>();
  for (const t of classes.keys()) inc.set(t, new Set());
  const has = (t: string, id: string) => inc.get(t)?.has(id) ?? false;
  const add = (t: string, id: string) => inc.get(t)!.add(id);

  // --- globals: everything
  for (const [t, cls] of classes) {
    if (cls === "global" || cls === "globalInsertOnly") for (const id of byId.get(t)!.keys()) add(t, id);
  }

  // --- seeds
  const licenses = rows.get("licenses")!.filter((l) => input.seedLicenseIds.has(key(l.id)));
  for (const l of licenses) {
    add("licenses", key(l.id));
    if (l.institute_id != null) add("institutes", key(l.institute_id));
  }
  const userOk = (id: string) => {
    const u = byId.get("users")!.get(id);
    return !!u && !input.excludeUser(u);
  };
  const studentOk = (id: string) => {
    const s = byId.get("students")!.get(id);
    return !!s && !input.excludeStudent(s);
  };
  for (const l of licenses) if (l.user_id != null && userOk(key(l.user_id))) add("users", key(l.user_id));
  for (const iu of rows.get("institute_users") ?? []) {
    if (has("institutes", key(iu.institute_id)) && userOk(key(iu.user_id))) add("users", key(iu.user_id));
  }
  for (const cu of rows.get("classroom_users") ?? []) {
    const c = byId.get("classrooms")?.get(key(cu.classroom_id));
    if (c && has("institutes", key(c.institute_id)) && userOk(key(cu.user_id))) add("users", key(cu.user_id));
  }
  for (const is of rows.get("institute_students") ?? []) {
    if (has("institutes", key(is.institute_id)) && studentOk(key(is.student_id))) add("students", key(is.student_id));
  }
  for (const us of rows.get("user_students") ?? []) {
    if (has("users", key(us.user_id)) && studentOk(key(us.student_id))) add("students", key(us.student_id));
  }

  // --- tenant expansion: a tenant row joins when ANY of its FKs points at an included row.
  // Seed tables are closed (never expanded into); pull tables are pulled on demand below.
  const fksByTable = new Map<string, FkEdge[]>();
  for (const f of fks) fksByTable.set(f.table, [...(fksByTable.get(f.table) ?? []), f]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [t, cls] of classes) {
      if (cls !== "tenant") continue;
      const edges = (fksByTable.get(t) ?? []).filter((f) => classes.get(f.refTable) !== "skip");
      for (const r of rows.get(t)!) {
        const id = idOf(t, r);
        if (has(t, id)) continue;
        if (edges.some((f) => r[f.column] != null && has(f.refTable, key(r[f.column])))) {
          add(t, id);
          changed = true;
        }
      }
    }
  }

  // --- integrity: resolve every FK of every included row; pull / null / drop to a fixpoint
  const fixups: Fixup[] = [];
  const dropped = new Map<string, Set<string>>();
  for (const t of classes.keys()) dropped.set(t, new Set());
  const patched = new Map<string, Map<string, Row>>(); // t → id → cloned row with nulls applied
  const rowFor = (t: string, id: string) => {
    let m = patched.get(t);
    if (!m) patched.set(t, (m = new Map()));
    let r = m.get(id);
    if (!r) m.set(id, (r = { ...byId.get(t)!.get(id)! }));
    return r;
  };

  changed = true;
  while (changed) {
    changed = false;
    for (const [t, cls] of classes) {
      if (cls === "skip") continue;
      const edges = fksByTable.get(t) ?? [];
      for (const id of [...inc.get(t)!]) {
        if (dropped.get(t)!.has(id)) continue;
        const r = rowFor(t, id);
        for (const f of edges) {
          const ref = r[f.column];
          if (ref == null) continue;
          const refId = key(ref);
          const refCls = classes.get(f.refTable);
          const resolved = refCls !== "skip" && has(f.refTable, refId) && !dropped.get(f.refTable)!.has(refId);
          if (resolved) continue;
          if (refCls === "pull" && byId.get(f.refTable)!.has(refId) && !dropped.get(f.refTable)!.has(refId)) {
            add(f.refTable, refId);
            changed = true;
            continue;
          }
          const reason = refCls === "skip" ? `${f.refTable} not migrated` : `${f.refTable}#${refId} not in copied set`;
          if (f.nullable) {
            r[f.column] = null;
            fixups.push({ table: t, rowId: id, column: f.column, refTable: f.refTable, refId, action: "null", reason });
          } else {
            dropped.get(t)!.add(id);
            fixups.push({ table: t, rowId: id, column: f.column, refTable: f.refTable, refId, action: "drop", reason: `${reason} (NOT NULL)` });
            changed = true;
            break;
          }
        }
      }
    }
  }

  const included = new Map<string, Row[]>();
  for (const [t, ids] of inc) {
    if (classes.get(t) === "skip") continue;
    included.set(t, [...ids].filter((id) => !dropped.get(t)!.has(id)).map((id) => rowFor(t, id)));
  }
  return { included, fixups };
}

/** Parent-before-child order over real FK edges (self-edges ignored). Throws on a cycle. */
export function topoOrderTables(names: string[], fks: FkEdge[]): string[] {
  const set = new Set(names);
  const deps = new Map<string, Set<string>>();
  for (const n of names) deps.set(n, new Set());
  for (const f of fks) if (set.has(f.table) && set.has(f.refTable) && f.table !== f.refTable) deps.get(f.table)!.add(f.refTable);
  const out: string[] = [];
  const done = new Set<string>();
  while (done.size < names.length) {
    const ready = names.filter((n) => !done.has(n) && [...deps.get(n)!].every((d) => done.has(d))).sort();
    if (!ready.length) throw new Error(`FK cycle among: ${names.filter((n) => !done.has(n)).join(", ")}`);
    for (const n of ready) { out.push(n); done.add(n); }
  }
  return out;
}

/** Rows with a self-FK: parents first. */
export function orderRowsBySelfFk(list: Row[], pk: string, parentCol: string): Row[] {
  const ids = new Set(list.map((r) => key(r[pk])));
  const out: Row[] = [];
  const placed = new Set<string>();
  let remaining = list;
  while (remaining.length) {
    const ready = remaining.filter((r) => r[parentCol] == null || !ids.has(key(r[parentCol])) || placed.has(key(r[parentCol])));
    if (!ready.length) throw new Error(`Self-FK cycle in rows: ${remaining.map((r) => r[pk]).join(", ")}`);
    for (const r of ready) { out.push(r); placed.add(key(r[pk])); }
    remaining = remaining.filter((r) => !placed.has(key(r[pk])));
  }
  return out;
}
