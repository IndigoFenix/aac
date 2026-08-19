/**
 * Cap arithmetic for the family-photo library.
 *
 * The caps are a promise made to a caretaker in the UI ("47 / 100"), so the
 * off-by-ones matter: they decide whether a selection is silently truncated,
 * wholly rejected, or allowed to overrun.
 *
 * See planning-docs/aac-photos-plan.md §2.
 */

import { describe, it, expect } from "@jest/globals";
import {
  PHOTO_CAP_PER_STUDENT,
  PHOTO_CAP_PER_INSTITUTE,
  capForScope,
  remainingCapacity,
  planIngestBatch,
} from "../services/photos/photo-caps.js";

describe("capForScope", () => {
  it("gives each scope its own allowance", () => {
    expect(capForScope({ kind: "student", studentId: "s1" })).toBe(PHOTO_CAP_PER_STUDENT);
    expect(capForScope({ kind: "institute", instituteId: "i1" })).toBe(PHOTO_CAP_PER_INSTITUTE);
  });

  it("caps are independent, so a student's view can reach their sum", () => {
    // A student sees their own library UNIONED with their institute's, so the
    // most photos ever on one student's board is the two caps added together.
    expect(PHOTO_CAP_PER_STUDENT + PHOTO_CAP_PER_INSTITUTE).toBe(200);
  });
});

describe("remainingCapacity", () => {
  it("counts down to the cap", () => {
    expect(remainingCapacity(0, 100)).toBe(100);
    expect(remainingCapacity(47, 100)).toBe(53);
    expect(remainingCapacity(99, 100)).toBe(1);
    expect(remainingCapacity(100, 100)).toBe(0);
  });

  it("never goes negative when a library already exceeds the cap", () => {
    // Lowering a cap below an existing library must not produce a negative
    // capacity, which would make planIngestBatch slice from the end.
    expect(remainingCapacity(150, 100)).toBe(0);
  });
});

describe("planIngestBatch", () => {
  const batch = (n: number) => Array.from({ length: n }, (_, i) => `photo-${i}`);

  it("accepts a batch that fits entirely", () => {
    const plan = planIngestBatch(batch(10), 0, 100);
    expect(plan.accepted).toHaveLength(10);
    expect(plan.rejected).toHaveLength(0);
    expect(plan.atCap).toBe(false);
  });

  it("splits a batch that overruns, preserving order", () => {
    // The documented case: 40 selected, 25 slots free.
    const plan = planIngestBatch(batch(40), 75, 100);
    expect(plan.accepted).toHaveLength(25);
    expect(plan.rejected).toHaveLength(15);
    expect(plan.accepted[0]).toBe("photo-0");
    expect(plan.accepted[24]).toBe("photo-24");
    expect(plan.rejected[0]).toBe("photo-25");
    expect(plan.atCap).toBe(false);
  });

  it("flags a full scope rather than reporting a successful import of zero", () => {
    const plan = planIngestBatch(batch(5), 100, 100);
    expect(plan.accepted).toHaveLength(0);
    expect(plan.rejected).toHaveLength(5);
    expect(plan.atCap).toBe(true);
  });

  it("fills the last free slot exactly", () => {
    const plan = planIngestBatch(batch(3), 99, 100);
    expect(plan.accepted).toHaveLength(1);
    expect(plan.rejected).toHaveLength(2);
    expect(plan.atCap).toBe(false);
  });

  it("treats an empty selection as a no-op, not as being at cap", () => {
    const plan = planIngestBatch([], 10, 100);
    expect(plan.accepted).toHaveLength(0);
    expect(plan.rejected).toHaveLength(0);
    expect(plan.atCap).toBe(false);
  });

  it("is at cap for an empty selection into a full scope", () => {
    // Ordering matters here: capacity is what decides `atCap`, not batch size.
    expect(planIngestBatch([], 100, 100).atCap).toBe(true);
  });
});
