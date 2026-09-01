/**
 * Holding `open_app`'s functionResponse until the server has decided.
 *
 * THE FAILURE THIS REPLACES (observed live 2026-08-24, 07:51). The Speaker
 * called `open_app("restaurant", "pizza")`. We answered `{output:"ok"}` 8ms
 * later, before anything had been decided. 1.2s after that it said
 * "פיצה במסעדה? אני פותחת לך" — "Pizza at a restaurant? I'm opening it for
 * you." 2.7s after the tool call the server refused the open (the child was in
 * his bedroom and browsing was off), and the refusal arrived as a context
 * injection, which by contract provokes no reply. So the child was promised an
 * app, got nothing, and was never told otherwise. The Board Manager, triggered
 * by the promise, then spent the next minute building restaurant follow-ups.
 *
 * The fix rests on a measured property of the API: Gemini Live BLOCKS
 * generation while a functionResponse is outstanding. Verified 2026-08-24
 * against the Speaker's own config — see scripts/test-live-toolcall-blocking.ts
 * for the 2x2 and its numbers. So withholding the ack until routeAppOpen
 * settles means the model composes its sentence already knowing the verdict; in
 * that experiment a refusal turned "Opening YouTube for you!" into "I can't
 * open YouTube right now. Is there another app you'd like to use?".
 *
 * Two properties are load-bearing and both are pinned below:
 *
 *   1. IT MUST ALWAYS SETTLE. A hold that never resolves is a Speaker that
 *      never speaks again — strictly worse than the false promise. Hence the
 *      backstop, and hence routeAppOpen's `finally`.
 *   2. IT MUST USE sendToolResponse, NOT sendToolResponseAsContent. The
 *      as-content path resolves the call without triggering generation. That is
 *      fine for a 1ms ack that beats the model's own turn end, but after a hold
 *      the model has already closed its turn: in testing, as-content produced
 *      total silence — the session never spoke again — while sendToolResponse
 *      resumed correctly. Getting this backwards trades a broken promise for a
 *      dead device, so it is asserted explicitly.
 */

import { describe, test, expect, jest, beforeEach, afterEach } from "@jest/globals";
import { SpeakerAgent, APP_OPEN_ACK_TIMEOUT_MS } from "../services/dual-agent/speaker-agent";
import type { AppOpenRequestedEvent } from "../services/dual-agent/agent-events";

type Sent = { via: "tool-response" | "as-content"; responses: Array<{ id?: string; name: string; response: any }> };

/** Minimal provider double: records which wire each response went out on. */
function makeProvider() {
  const sent: Sent[] = [];
  const injected: string[] = [];
  return {
    sent,
    injected,
    sendToolResponse: (responses: any[]) => { sent.push({ via: "tool-response", responses }); },
    sendToolResponseAsContent: (responses: any[]) => { sent.push({ via: "as-content", responses }); },
    sendContextInjection: (text: string) => { injected.push(text); },
    close: () => {},
  };
}

/** Drive handleToolCalls without opening a real Live session. */
function makeSpeaker() {
  const events: any[] = [];
  const agent = new SpeakerAgent("gemini" as any, {
    onEvent: (e) => events.push(e),
    onError: () => {},
  });
  const provider = makeProvider();
  (agent as any).provider = provider;
  const handle = (calls: any[]) => (agent as any).handleToolCalls(calls);
  return { agent, provider, events, handle };
}

const OPEN_APP = { id: "call-1", name: "open_app", args: { app_id: "restaurant", data: "pizza" } };

beforeEach(() => { jest.useFakeTimers(); });
afterEach(() => { jest.useRealTimers(); });

describe("what gets held", () => {
  test("open_app is NOT acked when the tool call arrives", () => {
    const { provider, handle } = makeSpeaker();
    handle([OPEN_APP]);
    expect(provider.sent).toHaveLength(0);
  });

  test("every other tool is still acked immediately", () => {
    // Only open_app can be refused. Holding anything else would stall turns for
    // no reason — emote changes and private notes have no verdict to wait for.
    const { provider, handle } = makeSpeaker();
    handle([{ id: "c2", name: "emote_change", args: { emote: "happy" } }]);
    expect(provider.sent).toHaveLength(1);
    expect(provider.sent[0].via).toBe("as-content");
  });

  test("a mixed batch acks the others and holds only open_app", () => {
    const { provider, handle } = makeSpeaker();
    handle([{ id: "c2", name: "emote_change", args: { emote: "happy" } }, OPEN_APP]);
    expect(provider.sent).toHaveLength(1);
    expect(provider.sent[0].responses.map((r) => r.name)).toEqual(["emote_change"]);
  });

  test("the event carries the tool-call id so the server can settle it", () => {
    const { events, handle } = makeSpeaker();
    handle([OPEN_APP]);
    const event = events.find((e) => e.type === "app_open_requested") as AppOpenRequestedEvent;
    expect(event.toolCallId).toBe("call-1");
    expect(event.appId).toBe("restaurant");
  });

  test("an open_app with no app_id releases its ack instead of stalling", () => {
    // Nothing downstream will ever settle this one — no event is emitted at all.
    const { provider, events, handle } = makeSpeaker();
    handle([{ id: "c9", name: "open_app", args: {} }]);
    expect(events.filter((e) => e.type === "app_open_requested")).toHaveLength(0);
    expect(provider.sent).toHaveLength(1);
  });

  test("a call with no id takes the immediate-ack path", () => {
    // Without an id there is no way to answer it later, so holding it would
    // block generation until the backstop with nothing able to release it.
    const { provider, handle } = makeSpeaker();
    handle([{ name: "open_app", args: { app_id: "drawing" } }]);
    expect(provider.sent).toHaveLength(1);
  });
});

describe("settling", () => {
  test("an allowed open answers `opened` — on the generation-triggering wire", () => {
    const { agent, provider, handle } = makeSpeaker();
    handle([OPEN_APP]);
    agent.resolveAppOpen("call-1", { opened: true, note: "[APP OPEN] restaurant (pizza)" });

    expect(provider.sent).toHaveLength(1);
    // 🚨 as-content resolves the call WITHOUT resuming generation — after a hold
    // that means the model never speaks again. See the file header.
    expect(provider.sent[0].via).toBe("tool-response");
    expect(provider.sent[0].responses[0].response.output).toBe("opened");
  });

  test("a refusal answers `refused` and carries the reason the model must act on", () => {
    const { agent, provider, handle } = makeSpeaker();
    handle([OPEN_APP]);
    agent.resolveAppOpen("call-1", {
      opened: false,
      note: "[APP OPEN BLOCKED] The restaurant app has nothing to show the user right now.",
    });

    expect(provider.sent[0].responses[0].response.output).toBe("refused");
    expect(String(provider.sent[0].responses[0].response.detail)).toContain("nothing to show");
  });

  test("the response is addressed to the right call", () => {
    const { agent, provider, handle } = makeSpeaker();
    handle([OPEN_APP]);
    agent.resolveAppOpen("call-1", { opened: true });
    expect(provider.sent[0].responses[0].id).toBe("call-1");
    expect(provider.sent[0].responses[0].name).toBe("open_app");
  });

  test("settling twice sends exactly one response", () => {
    // routeAppOpen's `finally` settles unconditionally, so a tagged path plus
    // the fallback both fire on every open. The second must be a no-op.
    const { agent, provider, handle } = makeSpeaker();
    handle([OPEN_APP]);
    agent.resolveAppOpen("call-1", { opened: false, note: "refused" });
    agent.resolveAppOpen("call-1", { opened: true });
    expect(provider.sent).toHaveLength(1);
    expect(provider.sent[0].responses[0].response.output).toBe("refused");
  });

  test("settling an unknown id does nothing", () => {
    const { agent, provider, handle } = makeSpeaker();
    handle([OPEN_APP]);
    agent.resolveAppOpen("some-other-call", { opened: true });
    expect(provider.sent).toHaveLength(0);
  });

  test("an undefined id is a no-op — student presses hold nothing", () => {
    const { agent, provider } = makeSpeaker();
    agent.resolveAppOpen(undefined, { opened: true });
    expect(provider.sent).toHaveLength(0);
  });
});

describe("the backstop", () => {
  test("an open that never settles is force-answered", () => {
    // The whole safety case. Live blocks generation for as long as the response
    // is outstanding, so a coordinator path that forgets to settle would
    // otherwise silence the Speaker permanently.
    const { provider, handle } = makeSpeaker();
    handle([OPEN_APP]);
    expect(provider.sent).toHaveLength(0);

    jest.advanceTimersByTime(APP_OPEN_ACK_TIMEOUT_MS);
    expect(provider.sent).toHaveLength(1);
  });

  test("it fails OPEN — a timeout must not read as a refusal", () => {
    // A resolver outage should degrade to today's behaviour (the app opens),
    // never to an AAC device that has quietly stopped opening apps.
    const { provider, handle } = makeSpeaker();
    handle([OPEN_APP]);
    jest.advanceTimersByTime(APP_OPEN_ACK_TIMEOUT_MS);
    expect(provider.sent[0].responses[0].response.output).not.toBe("refused");
  });

  test("settling first cancels the backstop", () => {
    const { agent, provider, handle } = makeSpeaker();
    handle([OPEN_APP]);
    agent.resolveAppOpen("call-1", { opened: true });
    jest.advanceTimersByTime(APP_OPEN_ACK_TIMEOUT_MS * 4);
    expect(provider.sent).toHaveLength(1);
  });

  test("a late settle after the backstop fired sends nothing more", () => {
    const { agent, provider, handle } = makeSpeaker();
    handle([OPEN_APP]);
    jest.advanceTimersByTime(APP_OPEN_ACK_TIMEOUT_MS);
    agent.resolveAppOpen("call-1", { opened: false, note: "too late" });
    expect(provider.sent).toHaveLength(1);
  });

  test("but the NOTE still reaches the model, as a context injection", () => {
    // 🚨 The backstop used to swallow it. `resolveAppOpen` returned early on
    // "already settled", so the one thing that tells the Speaker what is
    // actually on screen was dropped — precisely in the case where the model
    // had already been handed "ok" and most needed correcting. Observed live
    // 2026-09-01: three restaurant opens, every note lost, the Speaker never
    // told that the search had found nothing.
    //
    // An injection is safe HERE and nowhere else in this flow: the backstop
    // already answered the functionResponse, so nothing is outstanding and
    // pushing content cannot strand generation.
    const { agent, provider, handle } = makeSpeaker();
    handle([OPEN_APP]);
    jest.advanceTimersByTime(APP_OPEN_ACK_TIMEOUT_MS);
    agent.resolveAppOpen("call-1", { opened: false, note: "[APP OPEN BLOCKED] nothing to show" });
    expect(provider.injected).toEqual(["[APP OPEN BLOCKED] nothing to show"]);
  });

  test("the recovered note is sent ONCE, however many times the server settles", () => {
    // routeAppOpen's `finally` settles unconditionally on every open, so a
    // tagged path plus the fallback both fire. A repeated injection would read
    // to the model as the app having opened twice.
    const { agent, provider, handle } = makeSpeaker();
    handle([OPEN_APP]);
    jest.advanceTimersByTime(APP_OPEN_ACK_TIMEOUT_MS);
    agent.resolveAppOpen("call-1", { opened: true, note: "[APP OPEN] restaurant" });
    agent.resolveAppOpen("call-1", { opened: true, note: "[APP OPEN] restaurant" });
    expect(provider.injected).toHaveLength(1);
  });

  test("a settle that BEATS the backstop injects nothing — the ack carried it", () => {
    const { agent, provider, handle } = makeSpeaker();
    handle([OPEN_APP]);
    agent.resolveAppOpen("call-1", { opened: true, note: "[APP OPEN] restaurant" });
    jest.advanceTimersByTime(APP_OPEN_ACK_TIMEOUT_MS * 4);
    expect(provider.injected).toHaveLength(0);
    expect(String(provider.sent[0].responses[0].response.detail)).toContain("restaurant");
  });

  test("a verdict with no note injects nothing", () => {
    const { agent, provider, handle } = makeSpeaker();
    handle([OPEN_APP]);
    jest.advanceTimersByTime(APP_OPEN_ACK_TIMEOUT_MS);
    agent.resolveAppOpen("call-1", { opened: true });
    expect(provider.injected).toHaveLength(0);
  });

  test("it covers a REAL routeAppOpen, measured — a backstop that always fires is not a backstop", () => {
    // 2026-08-27: three consecutive restaurant opens took 2.84s, 3.95s and
    // 3.91s end to end (AI-open decision ~2.4s, then the app's own resolution).
    // At the old 2500ms every single one timed out, so the model was handed
    // "ok" before the verdict existed and promised a child an app that never
    // opened. The lower bound here is the measured worst case.
    expect(APP_OPEN_ACK_TIMEOUT_MS).toBeGreaterThanOrEqual(4000);
    // And still short enough that the silence reads as work, not a dead device.
    expect(APP_OPEN_ACK_TIMEOUT_MS).toBeLessThanOrEqual(6000);
  });

  test("closing the session cancels held timers", () => {
    const { agent, provider, handle } = makeSpeaker();
    handle([OPEN_APP]);
    agent.close();
    jest.advanceTimersByTime(APP_OPEN_ACK_TIMEOUT_MS * 4);
    expect(provider.sent).toHaveLength(0);
  });
});

describe("concurrent opens", () => {
  test("two held calls settle independently", () => {
    const { agent, provider, handle } = makeSpeaker();
    handle([OPEN_APP]);
    handle([{ id: "call-2", name: "open_app", args: { app_id: "drawing" } }]);
    expect(provider.sent).toHaveLength(0);

    agent.resolveAppOpen("call-2", { opened: true });
    expect(provider.sent).toHaveLength(1);
    expect(provider.sent[0].responses[0].id).toBe("call-2");

    agent.resolveAppOpen("call-1", { opened: false, note: "no" });
    expect(provider.sent).toHaveLength(2);
    expect(provider.sent[1].responses[0].id).toBe("call-1");
  });
});
