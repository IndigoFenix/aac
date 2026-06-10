/**
 * Institute records must be read-only for the AI.
 *
 * Institutes are provisioned together with licenses by administrators; the
 * AI must not create, modify, or delete them (incident: session c2061a41
 * renamed a real institute "My Clinic" → "בית ספר אגם" from chat). The ops
 * throw — rather than being omitted — so the memory-db-bridge surfaces an
 * explicit ok:false tool error to the AI instead of silently keeping the
 * change in-memory only.
 *
 * Sub-collections (members, students, classrooms, invites) keep their own
 * writable ops and are NOT covered by this lockdown.
 */

import { describe, it, expect } from "@jest/globals";
import {
  INSTITUTE_INSTITUTES_FIELD,
  INSTITUTE_SYSTEM_PROMPT,
} from "../services/memory-schema/institute-memory-schema";
import type { DBOperationContext } from "../services/chat/memory-types";

const ctx: DBOperationContext = { all: { userId: "test-user" } } as DBOperationContext;
const READONLY = /read-only/i;

describe("Context_Institutes is read-only for the AI", () => {
  const ops = INSTITUTE_INSTITUTES_FIELD.db!;

  it("rejects creating an institute", async () => {
    await expect(
      ops.add!(ctx, { name: "בית ספר אגם", type: "school" }, {}),
    ).rejects.toThrow(READONLY);
  });

  it("rejects updating institute details (e.g. rename)", async () => {
    await expect(
      ops.update!(ctx, "some-institute-id", { name: "בית ספר אגם" }),
    ).rejects.toThrow(READONLY);
  });

  it("rejects deleting an institute", async () => {
    await expect(ops.delete!(ctx, "some-institute-id")).rejects.toThrow(READONLY);
  });

  it("error message stays single-line so sanitizeDbError surfaces it whole", async () => {
    const err = await ops.update!(ctx, "id", {}).then(
      () => { throw new Error("expected rejection"); },
      (e: Error) => e,
    );
    expect(err.message).not.toContain("\n");
  });

  it("still allows reading (list/get ops remain defined)", () => {
    expect(ops.list).toBeDefined();
    expect(ops.get).toBeDefined();
  });

  it("sub-collections remain writable", () => {
    const props = (INSTITUTE_INSTITUTES_FIELD.values as any).properties;
    for (const key of ["members", "students", "classrooms"]) {
      expect(props[key].db.add ?? props[key].db.update).toBeDefined();
    }
  });
});

describe("institute system prompt", () => {
  it("tells the AI institutes are read-only instead of offering create/delete", () => {
    expect(INSTITUTE_SYSTEM_PROMPT).toMatch(/READ-ONLY/);
    expect(INSTITUTE_SYSTEM_PROMPT).not.toMatch(/Create, update, and delete institutes/);
  });
});
