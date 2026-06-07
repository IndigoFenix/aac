/**
 * sanitizeDbError — never surface raw SQL or bound parameter VALUES to the LLM /
 * persisted debug log. Drizzle errors read "Failed query: <SQL>\nparams: <values>"
 * which leaks the schema and PHI (patient names, dates, ids). We surface only the
 * underlying param-free reason.
 */

import { describe, it, expect } from "@jest/globals";
import { sanitizeDbError } from "../services/chat/memory-db-bridge.js";

describe("sanitizeDbError", () => {
  it("returns the param-free driver reason, not the SQL/params, for a Drizzle wrapper", () => {
    // Shape of the real hila error: Drizzle wrapper message + pg cause.
    const err: any = new Error(
      'Failed query: insert into "students" ("id","first_name","birth_date") values (default,$1,$2)\n' +
        "params: מיכאל,1984",
    );
    err.cause = { message: 'invalid input syntax for type date: "1984"', code: "22007" };

    const msg = sanitizeDbError(err);

    expect(msg).toBe('invalid input syntax for type date: "1984"');
    // Crucially: no SQL, no params, no PHI.
    expect(msg).not.toMatch(/Failed query/i);
    expect(msg).not.toMatch(/insert into/i);
    expect(msg).not.toMatch(/params:/i);
    expect(msg).not.toContain("מיכאל");
  });

  it("falls back to a generic message when only the SQL wrapper is available (no cause)", () => {
    const err = new Error(
      'Failed query: insert into "students" (...) values (...)\nparams: מיכאל רוזנר,secret@example.com',
    );

    const msg = sanitizeDbError(err);

    expect(msg).toBe("database operation failed");
    expect(msg).not.toContain("מיכאל");
    expect(msg).not.toContain("secret@example.com");
    expect(msg).not.toMatch(/Failed query/i);
  });

  it("uses a custom fallback when provided", () => {
    const err = new Error("Failed query: update ...\nparams: x");
    expect(sanitizeDbError(err, "DB write failed")).toBe("DB write failed");
  });

  it("returns the first line of a plain (non-wrapper) error", () => {
    const err = new Error("permission denied for table students\n    at Object.<anonymous>");
    expect(sanitizeDbError(err)).toBe("permission denied for table students");
  });

  it("handles non-Error throwables", () => {
    expect(sanitizeDbError("boom")).toBe("boom");
    expect(sanitizeDbError(undefined)).toBe("database operation failed");
  });
});
