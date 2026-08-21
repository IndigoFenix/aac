/**
 * DB-free tests for scripts/lib/migration-closure.ts — the staging→prod copy
 * closure. Fixture mirrors the real shape: licenses → institutes → users /
 * students → boards, with an admin author, a SIM student and a skipped table.
 */
import {
  classifyTables,
  computeClosure,
  topoOrderTables,
  orderRowsBySelfFk,
  SOFT_FK_CONVENTION,
  type FkEdge,
  type TableMeta,
  type Row,
} from "../../scripts/lib/migration-closure";

const T = (name: string, cols: string[], nullable: string[] = []): TableMeta => ({
  name,
  pk: ["id"],
  columns: cols.map((c) => ({ name: c, nullable: nullable.includes(c) })),
});

const tables: TableMeta[] = [
  T("licenses", ["id", "institute_id", "user_id"], ["institute_id", "user_id"]),
  T("institutes", ["id", "name"]),
  T("users", ["id", "email", "is_admin", "referred_by_id"], ["referred_by_id"]),
  T("students", ["id", "name", "biometric_data_id"], ["biometric_data_id"]),
  T("institute_users", ["id", "institute_id", "user_id"]),
  T("institute_students", ["id", "institute_id", "student_id"]),
  T("user_students", ["id", "user_id", "student_id"]),
  T("boards", ["id", "student_id", "user_id", "created_by_user_id"], ["student_id", "user_id", "created_by_user_id"]),
  T("biometric_data", ["id"]),
  T("chat_sessions", ["id", "student_id"]),
  T("deep_analyses", ["id", "student_id", "session_id"], ["session_id"]),
  T("system_settings", ["id", "value"]),
  T("personas", ["id", "institute_id"], ["institute_id"]),
  T("topics", ["id", "parent_id"], ["parent_id"]),
];

const fk = (table: string, column: string, refTable: string, nullable: boolean, soft = false): FkEdge =>
  ({ table, column, refTable, refColumn: "id", nullable, soft });

const fks: FkEdge[] = [
  fk("licenses", "institute_id", "institutes", true),
  fk("licenses", "user_id", "users", true),
  fk("users", "referred_by_id", "users", true),
  fk("students", "biometric_data_id", "biometric_data", true, true),
  fk("institute_users", "institute_id", "institutes", false),
  fk("institute_users", "user_id", "users", false),
  fk("institute_students", "student_id", "students", false),
  fk("institute_students", "institute_id", "institutes", false, true),
  fk("user_students", "user_id", "users", false),
  fk("user_students", "student_id", "students", false),
  fk("boards", "student_id", "students", true),
  fk("boards", "user_id", "users", true),
  fk("boards", "created_by_user_id", "users", true, true),
  fk("chat_sessions", "student_id", "students", false),
  fk("deep_analyses", "student_id", "students", false),
  fk("deep_analyses", "session_id", "chat_sessions", true, true),
  fk("personas", "institute_id", "institutes", true),
  fk("topics", "parent_id", "topics", true),
];

const classes = classifyTables(tables.map((t) => t.name), {
  seed: ["licenses", "institutes", "users", "students"],
  global: ["system_settings", "topics"],
  globalInsertOnly: ["personas"],
  pull: ["biometric_data"],
  skip: ["chat_sessions"],
});

const rows = new Map<string, Row[]>([
  ["licenses", [
    { id: "L1", institute_id: "I1", user_id: null },
    { id: "L-test", institute_id: "I-test", user_id: "U-fenix" },
  ]],
  ["institutes", [{ id: "I1", name: "Clinic" }, { id: "I-test", name: "Indigo" }, { id: "I-orphan", name: "Sandbox" }]],
  ["users", [
    { id: "U1", email: "raz@x.com", is_admin: false, referred_by_id: "U-admin" },
    { id: "U-admin", email: "daniel@aivota.ai", is_admin: true, referred_by_id: null },
    { id: "U-fenix", email: "indigofenix00@gmail.com", is_admin: false, referred_by_id: null },
  ]],
  ["students", [
    { id: "S1", name: "Noa", biometric_data_id: "B1" },
    { id: "S2", name: "Uri", biometric_data_id: null },
    { id: "S-sim", name: "[SIM] fluent-reader", biometric_data_id: null },
    { id: "S-test", name: "Gal Nolan", biometric_data_id: null },
  ]],
  ["institute_users", [
    { id: "IU1", institute_id: "I1", user_id: "U1" },
    { id: "IU2", institute_id: "I1", user_id: "U-admin" },
    { id: "IU3", institute_id: "I-test", user_id: "U-fenix" },
  ]],
  ["institute_students", [
    { id: "IS1", institute_id: "I1", student_id: "S1" },
    { id: "IS2", institute_id: "I-orphan", student_id: "S1" }, // S1 also enrolled in a non-copied institute
    { id: "IS3", institute_id: "I-test", student_id: "S-test" },
  ]],
  ["user_students", [
    { id: "US1", user_id: "U1", student_id: "S2" },        // pulls S2 in via its owner
    { id: "US2", user_id: "U-admin", student_id: "S1" },   // admin link → dropped
    { id: "US3", user_id: "U1", student_id: "S-sim" },     // sim → dropped
    { id: "US4", user_id: "U-fenix", student_id: "S-test" },
  ]],
  ["boards", [
    { id: "B-s1", student_id: "S1", user_id: null, created_by_user_id: "U-admin" }, // keep, author nulled
    { id: "B-test", student_id: "S-test", user_id: null, created_by_user_id: "U-fenix" },
    { id: "B-u1", student_id: null, user_id: "U1", created_by_user_id: "U1" },
  ]],
  ["biometric_data", [{ id: "B1" }, { id: "B-unused" }]],
  ["deep_analyses", [{ id: "D1", student_id: "S1", session_id: "CS1" }]],
  ["system_settings", [{ id: "llm_clinician", value: "{}" }]],
  ["personas", [{ id: "P-global", institute_id: null }, { id: "P-test", institute_id: "I-test" }]],
  ["topics", [{ id: "T2", parent_id: "T1" }, { id: "T1", parent_id: null }]],
]);

const run = () =>
  computeClosure({
    tables,
    classes,
    fks,
    rows,
    seedLicenseIds: new Set(["L1"]),
    excludeUser: (u) => u.is_admin === true || /^indigofenix0\d@/.test(String(u.email)),
    excludeStudent: (s) => String(s.name).startsWith("[SIM] "),
  });

const ids = (r: ReturnType<typeof run>, t: string) => r.included.get(t)!.map((x) => x.id).sort();

describe("classifyTables", () => {
  it("defaults unlisted tables to tenant and rejects unknown names", () => {
    expect(classes.get("boards")).toBe("tenant");
    expect(() => classifyTables(["a"], { seed: [], global: ["nope"], globalInsertOnly: [], pull: [], skip: [] }))
      .toThrow(/not in schema/);
  });
});

describe("SOFT_FK_CONVENTION", () => {
  it("maps exact and suffixed columns", () => {
    expect(SOFT_FK_CONVENTION("student_id")).toBe("students");
    expect(SOFT_FK_CONVENTION("created_by_user_id")).toBe("users");
    expect(SOFT_FK_CONVENTION("source_institute_id")).toBe("institutes");
    expect(SOFT_FK_CONVENTION("attendee_id")).toBeNull(); // polymorphic — left alone
    expect(SOFT_FK_CONVENTION("revenuecat_app_user_id")).toBeNull(); // external id, not ours
  });
});

describe("computeClosure", () => {
  it("copies only the seeded license's institute, its non-excluded users and students", () => {
    const r = run();
    expect(ids(r, "licenses")).toEqual(["L1"]);
    expect(ids(r, "institutes")).toEqual(["I1"]);
    expect(ids(r, "users")).toEqual(["U1"]);
    expect(ids(r, "students")).toEqual(["S1", "S2"]);
  });

  it("drops links to excluded users/students and to non-copied institutes (NOT NULL FKs)", () => {
    const r = run();
    expect(ids(r, "institute_users")).toEqual(["IU1"]);
    expect(ids(r, "institute_students")).toEqual(["IS1"]);
    expect(ids(r, "user_students")).toEqual(["US1"]);
    const drops = r.fixups.filter((f) => f.action === "drop").map((f) => `${f.table}:${f.rowId}`).sort();
    expect(drops).toEqual(["institute_students:IS2", "institute_users:IU2", "user_students:US2", "user_students:US3"]);
  });

  it("keeps a board authored by an admin and nulls the author", () => {
    const r = run();
    expect(ids(r, "boards")).toEqual(["B-s1", "B-u1"]);
    const b = r.included.get("boards")!.find((x) => x.id === "B-s1")!;
    expect(b.created_by_user_id).toBeNull();
    expect(r.fixups).toContainEqual(expect.objectContaining({ table: "boards", rowId: "B-s1", column: "created_by_user_id", action: "null" }));
    // the source row is untouched (we write to a clone)
    expect(rows.get("boards")![0].created_by_user_id).toBe("U-admin");
  });

  it("nulls a self-reference to an excluded user", () => {
    const u = run().included.get("users")![0];
    expect(u.referred_by_id).toBeNull();
  });

  it("pulls referenced pull-class rows on demand only", () => {
    expect(ids(run(), "biometric_data")).toEqual(["B1"]);
  });

  it("nulls references into skipped tables", () => {
    const d = run().included.get("deep_analyses")![0];
    expect(d.session_id).toBeNull();
  });

  it("includes globals wholesale, including personas of non-copied institutes (author nulled)", () => {
    const r = run();
    expect(ids(r, "system_settings")).toEqual(["llm_clinician"]);
    expect(ids(r, "topics")).toEqual(["T1", "T2"]);
    expect(ids(r, "personas")).toEqual(["P-global", "P-test"]);
    expect(r.included.get("personas")!.find((p) => p.id === "P-test")!.institute_id).toBeNull();
  });

  it("copies nothing tenant-side when no license matches", () => {
    const r = computeClosure({ tables, classes, fks, rows, seedLicenseIds: new Set(["nope"]), excludeUser: () => false, excludeStudent: () => false });
    expect(ids(r, "institutes")).toEqual([]);
    expect(ids(r, "boards")).toEqual([]);
    expect(ids(r, "system_settings")).toEqual(["llm_clinician"]);
  });
});

describe("ordering", () => {
  it("orders tables parents-first over real FKs", () => {
    const order = topoOrderTables(["boards", "students", "users", "institutes", "licenses"], fks.filter((f) => !f.soft));
    expect(order.indexOf("users")).toBeLessThan(order.indexOf("boards"));
    expect(order.indexOf("students")).toBeLessThan(order.indexOf("boards"));
    expect(order.indexOf("institutes")).toBeLessThan(order.indexOf("licenses"));
  });

  it("detects FK cycles", () => {
    expect(() => topoOrderTables(["a", "b"], [fk("a", "b_id", "b", false), fk("b", "a_id", "a", false)])).toThrow(/cycle/);
  });

  it("orders self-referencing rows parents-first", () => {
    const out = orderRowsBySelfFk(rows.get("topics")!, "id", "parent_id").map((r) => r.id);
    expect(out).toEqual(["T1", "T2"]);
  });
});
