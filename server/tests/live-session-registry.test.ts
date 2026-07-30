// Unit tests for the per-student live-session registry and its steal policy.
// Pure-logic, no DB / no LLM — safe in the default `npm test` run.
//
// Regression context (07-20 Auerhahn runaway): two live sessions for one
// student ran — and billed — concurrently for 7 hours because registration was
// silent latest-wins: the displaced session was never told and kept running.

import {
  registerLiveSession,
  unregisterLiveSession,
  getLiveSession,
  shouldStealFrom,
  type LiveSessionHandle,
} from "../services/dual-agent/live-session-registry";

const makeHandle = (isClassroom = false): LiveSessionHandle => ({
  requestReload: () => {},
  supersede: () => {},
  isClassroom,
});

describe("live-session registry", () => {
  it("returns the displaced handle when a second session registers for the same student", () => {
    const a = makeHandle();
    const b = makeHandle();
    expect(registerLiveSession("s1", a)).toBeNull();
    expect(registerLiveSession("s1", b)).toBe(a);
    expect(getLiveSession("s1")).toBe(b);
    unregisterLiveSession("s1", b);
  });

  it("re-registering the same handle displaces nothing", () => {
    const a = makeHandle();
    registerLiveSession("s2", a);
    expect(registerLiveSession("s2", a)).toBeNull();
    unregisterLiveSession("s2", a);
  });

  it("a stale old session unregistering cannot evict the newer session", () => {
    const oldH = makeHandle();
    const newH = makeHandle();
    registerLiveSession("s3", oldH);
    registerLiveSession("s3", newH);
    unregisterLiveSession("s3", oldH); // old session tearing down late
    expect(getLiveSession("s3")).toBe(newH);
    unregisterLiveSession("s3", newH);
    expect(getLiveSession("s3")).toBeNull();
  });
});

describe("shouldStealFrom", () => {
  it("no displaced session → nothing to steal", () => {
    expect(shouldStealFrom(null, { isClassroom: false })).toBe(false);
  });

  it("two personal-device sessions → steal (newest wins)", () => {
    expect(shouldStealFrom(makeHandle(false), { isClassroom: false })).toBe(true);
  });

  it("classroom sessions are exempt in both directions", () => {
    expect(shouldStealFrom(makeHandle(true), { isClassroom: false })).toBe(false);
    expect(shouldStealFrom(makeHandle(false), { isClassroom: true })).toBe(false);
    expect(shouldStealFrom(makeHandle(true), { isClassroom: true })).toBe(false);
  });
});
