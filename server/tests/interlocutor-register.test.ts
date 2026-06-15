// server/tests/interlocutor-register.test.ts
//
// Unit coverage for classifyContactRegister — the deterministic peer-vs-helper
// classifier that (together with Observer inference) drives the BoardManager's
// palette. Pure module; runs in the standard jest environment.

import { classifyContactRegister } from "@shared/interlocutor-register";

describe("classifyContactRegister", () => {
  it("treats a contact linked to another student as a peer (highest priority)", () => {
    // Even with a helper-sounding relationship, a student link means peer.
    expect(classifyContactRegister({ linkedStudentId: "stu_1", relationship: "helper" })).toBe("peer");
  });

  it("treats a formal team-member role as a helper", () => {
    expect(classifyContactRegister({ role: "therapist" })).toBe("helper");
    expect(classifyContactRegister({ role: "teacher", relationship: "friend" })).toBe("helper");
  });

  it("classifies caretaker/professional relationships as helper", () => {
    for (const rel of ["Mom", "dad", "Grandma", "teacher", "speech therapist", "nurse", "aide", "babysitter"]) {
      expect(classifyContactRegister({ relationship: rel })).toBe("helper");
    }
  });

  it("classifies friends and child relations as peer", () => {
    for (const rel of ["friend", "best friend", "classmate", "buddy", "her brother", "cousin", "twin sister"]) {
      expect(classifyContactRegister({ relationship: rel })).toBe("peer");
    }
  });

  it("falls back to helper when a relationship mixes peer + helper terms (needs-safe)", () => {
    expect(classifyContactRegister({ relationship: "older sister, his carer" })).toBe("helper");
  });

  it("returns unknown when there is no usable signal", () => {
    for (const c of [{}, { relationship: "" }, { relationship: "someone" }, { customRole: "  " }]) {
      expect(classifyContactRegister(c)).toBe("unknown");
    }
  });
});
