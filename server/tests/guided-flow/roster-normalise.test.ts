/**
 * The roster normaliser is the only thing standing between a model's reading of
 * a spreadsheet and thirty real children's records. It runs TWICE — once to
 * build the proposal, once again on confirm over the rows the client sent back
 * — and the second run is the one that matters: the client is a text editor,
 * not an authority.
 *
 * The failures worth a test are the quiet ones:
 *   - `03/04/2018` is a real date under BOTH readings. Nothing throws, nothing
 *     warns; the child simply has the wrong birthday, and the consent notice is
 *     picked from it. The tie is broken by the institute's COUNTRY, so that
 *     rule is pinned here rather than left to whoever edits the regex next.
 *   - A duplicate is a second record for a child who already exists — invisible
 *     until two clinicians are writing reports about "the same" student.
 *   - The license cap has to be spent IN ORDER and the overflow UNCHECKED, or
 *     the batch half-succeeds and nobody can tell which half.
 *
 * `normaliseRoster` is pure on purpose (its DB reads are its arguments), so
 * every one of those lives in this DB-free suite.
 */

import { describe, it, expect } from "@jest/globals";

import {
  normaliseBirthDate,
  normaliseGender,
  normaliseGrade,
  normaliseRoster,
  type ExistingStudent,
} from "../../services/guided-setup/roster-import.js";

type Row = Parameters<typeof normaliseRoster>[0]["rows"][number];

function run(
  rows: Row[],
  over: Partial<{ country: string | null; existing: ExistingStudent[]; remainingSeats: number }> = {},
) {
  return normaliseRoster({
    rows,
    country: over.country ?? "IL",
    existing: over.existing ?? [],
    remainingSeats: over.remainingSeats ?? -1,
  });
}

// ---------------------------------------------------------------------------

describe("normaliseBirthDate", () => {
  it("takes an ISO date as written", () => {
    expect(normaliseBirthDate("2018-01-09", "IL")).toBe("2018-01-09");
    expect(normaliseBirthDate("2018/01/09", "IL")).toBe("2018-01-09");
  });

  it("resolves the day/month tie by the institute's country", () => {
    // The same string, two real dates. Only the country decides.
    expect(normaliseBirthDate("03/04/2018", "IL")).toBe("2018-04-03");
    expect(normaliseBirthDate("03/04/2018", "US")).toBe("2018-03-04");
    expect(normaliseBirthDate("03.04.2018", null)).toBe("2018-04-03");
  });

  it("falls back to the other reading when the first is impossible", () => {
    // 13 is not a month: a US institute's `13/05/2018` can only be day-first.
    expect(normaliseBirthDate("13/05/2018", "US")).toBe("2018-05-13");
    // And the mirror: an IL institute's `05/13/2018` can only be month-first.
    expect(normaliseBirthDate("05/13/2018", "IL")).toBe("2018-05-13");
  });

  it("expands a two-digit year into a plausible birth year", () => {
    expect(normaliseBirthDate("01/02/08", "IL")).toBe("2008-02-01");
    expect(normaliseBirthDate("01/02/95", "IL")).toBe("1995-02-01");
  });

  it("returns null rather than guessing at anything else", () => {
    expect(normaliseBirthDate("last Tuesday", "IL")).toBeNull();
    expect(normaliseBirthDate("32/01/2018", "IL")).toBeNull();
    expect(normaliseBirthDate("2018-02-30", "IL")).toBeNull();
    expect(normaliseBirthDate("", "IL")).toBeNull();
    expect(normaliseBirthDate(null, "IL")).toBeNull();
  });
});

describe("normaliseGender", () => {
  it("maps what a roster column actually contains", () => {
    expect(normaliseGender("M")).toBe("male");
    expect(normaliseGender("female")).toBe("female");
    expect(normaliseGender("ז")).toBe("male");
    expect(normaliseGender("נקבה")).toBe("female");
    expect(normaliseGender("Other")).toBe("other");
  });

  it("returns null for anything it does not recognise", () => {
    expect(normaliseGender("yes")).toBeNull();
    expect(normaliseGender(null)).toBeNull();
  });
});

describe("normaliseGrade", () => {
  it("accepts the enum's own values and the ways people write them", () => {
    expect(normaliseGrade("3")).toBe("3");
    expect(normaliseGrade("3rd Grade")).toBe("3");
    expect(normaliseGrade("Grade 7")).toBe("7");
    expect(normaliseGrade("K")).toBe("k");
    expect(normaliseGrade("Kindergarten")).toBe("k");
    expect(normaliseGrade("Pre-K")).toBe("pre_k");
    expect(normaliseGrade("special_ed")).toBe("special_ed");
    expect(normaliseGrade("Special Education")).toBe("special_ed");
  });

  it("returns null for a value outside the enum", () => {
    // `grade` is a Postgres ENUM: writing free text there is not a bad value,
    // it is a failed INSERT that would take the whole row down with it.
    expect(normaliseGrade("Year 13")).toBeNull();
    expect(normaliseGrade("middle school")).toBeNull();
    expect(normaliseGrade(null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe("normaliseRoster — warnings", () => {
  it("includes a complete row and warns about nothing but the guardian", () => {
    const { rows } = run([
      {
        firstName: "Noa",
        lastName: "Levi",
        birthDate: "2018-01-01",
        guardianEmail: "p@example.com",
      },
    ]);
    expect(rows[0].include).toBe(true);
    expect(rows[0].warnings).toEqual([]);
    expect(rows[0].birthDate).toBe("2018-01-01");
  });

  it("unchecks a nameless row — there is nothing to create", () => {
    const { rows } = run([{ firstName: null, lastName: null, birthDate: "2018-01-01" }]);
    expect(rows[0].warnings).toContain("missingName");
    expect(rows[0].include).toBe(false);
  });

  it("tells a MISSING birth date apart from an unreadable one", () => {
    const { rows } = run([
      { firstName: "A", lastName: "B" },
      { firstName: "C", lastName: "D", birthDate: "sometime in 2018" },
    ]);
    expect(rows[0].warnings).toContain("missingBirthDate");
    expect(rows[0].warnings).not.toContain("badBirthDate");
    expect(rows[1].warnings).toContain("badBirthDate");
    expect(rows[1].warnings).not.toContain("missingBirthDate");
    // Neither is fatal: the user can type the date in the table.
    expect(rows[0].include).toBe(true);
    expect(rows[1].include).toBe(true);
  });

  it("flags a row that matches somebody already in the institute", () => {
    const { rows } = run(
      [{ firstName: "Noa", lastName: "Levi", birthDate: "2018-01-01" }],
      {
        existing: [
          { name: "noa   levi", firstName: "Noa", lastName: "Levi", birthDate: "2018-01-01" },
        ],
      },
    );
    expect(rows[0].warnings).toContain("duplicate");
    // Flagged, not blocked: two children CAN share a name and a birthday, and
    // only a human knows which case this is.
    expect(rows[0].include).toBe(true);
  });

  it("flags a row repeated inside the same upload", () => {
    const { rows } = run([
      { firstName: "Noa", lastName: "Levi", birthDate: "2018-01-01" },
      { firstName: "Noa", lastName: "Levi", birthDate: "2018-01-01" },
    ]);
    expect(rows[0].warnings).not.toContain("duplicate");
    expect(rows[1].warnings).toContain("duplicate");
  });

  it("does not call two nameless rows duplicates of each other", () => {
    const { rows } = run([{ birthDate: "2018-01-01" }, { birthDate: "2018-01-01" }]);
    expect(rows[1].warnings).not.toContain("duplicate");
  });

  it("warns when there is no way to reach a guardian", () => {
    const { rows } = run([
      { firstName: "A", lastName: "B", guardianName: "Parent" },
      { firstName: "C", lastName: "D", guardianPhone: "+972500000000" },
    ]);
    // A NAME is not a channel: consent goes out by email or SMS.
    expect(rows[0].warnings).toContain("noGuardianContact");
    expect(rows[1].warnings).not.toContain("noGuardianContact");
  });
});

describe("normaliseRoster — seats", () => {
  it("spends the licence head-room in order and unchecks the overflow", () => {
    const { rows } = run(
      [
        { firstName: "A", lastName: "One" },
        { firstName: "B", lastName: "Two" },
        { firstName: "C", lastName: "Three" },
      ],
      { remainingSeats: 2 },
    );
    expect(rows.map((r) => r.include)).toEqual([true, true, false]);
    expect(rows[2].warnings).toContain("overCap");
    expect(rows[0].warnings).not.toContain("overCap");
  });

  it("does not spend a seat on a row it would not create anyway", () => {
    const { rows } = run(
      [
        { firstName: null, lastName: null },
        { firstName: "B", lastName: "Two" },
      ],
      { remainingSeats: 1 },
    );
    // The nameless row must not eat the only seat left.
    expect(rows[1].include).toBe(true);
    expect(rows[1].warnings).not.toContain("overCap");
  });

  it("never flags overCap on an unlimited licence", () => {
    const { rows, remainingSeats } = run(
      Array.from({ length: 40 }, (_, i) => ({ firstName: `S${i}`, lastName: "X" })),
      { remainingSeats: -1 },
    );
    expect(remainingSeats).toBe(-1);
    expect(rows.every((r) => !r.warnings.includes("overCap"))).toBe(true);
    expect(rows.every((r) => r.include)).toBe(true);
  });

  it("refuses every row when the licence has no room at all", () => {
    const { rows } = run([{ firstName: "A", lastName: "One" }], { remainingSeats: 0 });
    expect(rows[0].include).toBe(false);
    expect(rows[0].warnings).toContain("overCap");
  });
});

describe("normaliseRoster — the confirm path", () => {
  it("honours a row the user unchecked", () => {
    const { rows } = run([
      { rowId: "r1", include: false, firstName: "A", lastName: "One" },
      { rowId: "r2", include: true, firstName: "B", lastName: "Two" },
    ]);
    expect(rows[0].include).toBe(false);
    expect(rows[1].include).toBe(true);
  });

  it("does NOT let a checked box override a server refusal", () => {
    // The client can send anything. `include: true` on a nameless row is either
    // a stale table or an attempt to skip the check; either way it loses.
    const { rows } = run([{ rowId: "r1", include: true, firstName: null, lastName: null }]);
    expect(rows[0].include).toBe(false);
  });

  it("re-derives warnings from the cells rather than trusting the ones sent", () => {
    const { rows } = run([
      {
        rowId: "r1",
        include: true,
        firstName: "Noa",
        lastName: "Levi",
        birthDate: "not a date",
        guardianEmail: "p@example.com",
      },
    ]);
    expect(rows[0].warnings).toEqual(["badBirthDate"]);
    expect(rows[0].birthDate).toBeNull();
  });

  it("keeps the row ids it was given so outcomes map back to the table", () => {
    const { rows } = run([{ rowId: "keep-me", firstName: "A", lastName: "One" }]);
    expect(rows[0].rowId).toBe("keep-me");
  });

  it("assigns an id to a row that arrived without one", () => {
    const { rows } = run([{ firstName: "A", lastName: "One" }]);
    expect(rows[0].rowId).toMatch(/^[0-9a-f-]{36}$/);
  });
});
