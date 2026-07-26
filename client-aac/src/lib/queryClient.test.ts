// client-aac/src/lib/queryClient.test.ts
//
// Guards the CapacitorHttp → Response adapter used to fix the iPad cookie bug.
// A defect here silently re-breaks auth (callers do res.ok / res.json()), and
// it can't be exercised on the device from here — so pin its behaviour.

import { toResponse } from "./queryClient";

describe("toResponse (CapacitorHttp adapter)", () => {
  it("round-trips a parsed-JSON body so res.json() returns the object", async () => {
    // CapacitorHttp auto-parses JSON responses into objects; the caller then
    // calls res.json(), so the object must survive the round-trip.
    const res = toResponse({
      status: 200,
      data: { success: true, user: { id: "u1" } },
      headers: { "content-type": "application/json" },
    });
    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ success: true, user: { id: "u1" } });
  });

  it("preserves a string body verbatim for res.text()", async () => {
    const res = toResponse({ status: 500, data: "Internal Error", headers: {} });
    expect(res.ok).toBe(false);
    await expect(res.text()).resolves.toBe("Internal Error");
  });

  it("marks a 401 as not-ok so the auth guard sees it", () => {
    // The exact status that was silently produced by the missing iPad cookie.
    const res = toResponse({ status: 401, data: { message: "Unauthorized" }, headers: {} });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(401);
  });

  it("builds a null-body Response for 204/304 without throwing", () => {
    // `new Response(body, { status })` throws if a null-body status carries a
    // body — the adapter must pass null there.
    for (const status of [204, 205, 304]) {
      expect(() => toResponse({ status, data: "", headers: {} })).not.toThrow();
      expect(toResponse({ status, data: "", headers: {} }).status).toBe(status);
    }
  });

  it("copies headers through", () => {
    const res = toResponse({ status: 200, data: {}, headers: { "x-trace": "abc" } });
    expect(res.headers.get("x-trace")).toBe("abc");
  });

  it("tolerates a null/undefined data payload", async () => {
    const res = toResponse({ status: 200, data: undefined as unknown as null, headers: {} });
    expect(res.status).toBe(200);
    await expect(res.text()).resolves.toBe("");
  });
});
