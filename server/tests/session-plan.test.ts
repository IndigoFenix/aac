/**
 * Pure-logic tests for the session-plan enhancer split (session-plan.ts):
 *
 *   1. Group/call layout — the legacy interact_mode/assist_mode sections are
 *      no longer generated; each call carries only its own sections' specs.
 *   2. Prompt assembly — the symbol inventory + encoding rules ride only on
 *      the call that emits sentence encodings; the situations/goals prompts
 *      carry coarse time (no exact clock) + the event schedule; goals gets
 *      the location + last-session summary.
 *   3. Nonced parsing + XML defang.
 *   4. Cache hashing — identity ignores time/events; situations is
 *      event-aware (weekly repeats re-hit across weeks, one-offs and
 *      schedule changes invalidate); goals keys on date/location.
 *   5. planEntryFresh policy (hash, age, non-empty).
 *   6. The AUTHORITY DEFERENCE default — emitted into the persona spec for a
 *      child, absent for an adult, unknown age treated as a child, ranked
 *      LOWEST in the priority ladder, and a hash input.
 *
 * The LLM calls themselves are exercised through the dual-agent service —
 * these tests cover the deterministic plumbing.
 */

import { describe, it, expect } from "@jest/globals";
import {
  PLAN_CALLS,
  GROUP_SECTION_KEYS,
  buildPlanCall,
  parsePlanCallResponse,
  identityHash,
  situationsHash,
  goalsHash,
  situationsSlot,
  planEntryFresh,
  dayPartForHour,
  localTimeParts,
  imminentEvents,
  isChildAge,
  ADULT_AGE_YEARS,
  PLAN_MAX_AGE_MS,
  type PlanContext,
  type PlanEventOccurrence,
} from "../services/dual-agent/session-plan";

const NOW = Date.UTC(2026, 6, 28, 9 + 3, 30); // Tue 2026-07-28 09:30 UTC (12:30 in +03)

function makeEvent(overrides: Partial<PlanEventOccurrence> = {}): PlanEventOccurrence {
  return {
    title: "Music therapy",
    description: "with Dana",
    weekday: 2,
    startHHMM: "10:00",
    whenText: "2026-07-28 10:00 (Asia/Jerusalem)",
    startMs: NOW - 30 * 60 * 1000,
    ...overrides,
  };
}

function makeCtx(overrides: Partial<PlanContext> = {}): PlanContext {
  return {
    studentName: "Daniel",
    language: "en",
    languageName: "English",
    studentDataParts: ["Name: Daniel", "Age: 9", "Notes: [\"likes trains\"]"],
    isChild: true,
    customRules: ["Always greet warmly"],
    autoNotes: ["Working on 2-symbol requests"],
    interestList: ["trains", "astronomy"],
    languageLevel: "full_sentences",
    singleGlyphButtons: false,
    events: [makeEvent()],
    locationSection: "",
    locationKey: "none",
    timezone: "Asia/Jerusalem",
    nowMs: NOW,
    weekday: 2,
    localDate: "2026-07-28",
    dayPart: "afternoon",
    ...overrides,
  };
}

const NONCES = { outputNonce: "aabbccdd", untrustedNonce: "eeff0011" };

describe("session-plan — group/call layout", () => {
  it("no call generates the legacy interact_mode/assist_mode sections", () => {
    const allTags = PLAN_CALLS.flatMap((c) => c.tags.map((t) => t.tag));
    expect(allTags).not.toContain("interact_mode_examples");
    expect(allTags).not.toContain("assist_mode_examples");
  });

  it("every GROUP_SECTION_KEYS entry is produced by exactly one call of that group", () => {
    for (const call of PLAN_CALLS) {
      for (const { key } of call.tags) {
        expect(GROUP_SECTION_KEYS[call.group]).toContain(key);
      }
    }
    // No section key appears in two calls.
    const allKeys = PLAN_CALLS.flatMap((c) => c.tags.map((t) => t.key));
    expect(new Set(allKeys).size).toBe(allKeys.length);
  });
});

describe("session-plan — prompt assembly", () => {
  const ctx = makeCtx();

  it("only the identity_examples call carries the symbol inventory / encoding rules", () => {
    for (const spec of PLAN_CALLS) {
      const built = buildPlanCall(spec, ctx, NONCES);
      const hasInventory = built.systemPrompt.includes("<bundled_icons>");
      expect(hasInventory).toBe(spec.call === "identity_examples");
    }
  });

  it("identity calls exclude the event schedule; situations/goals include it", () => {
    for (const spec of PLAN_CALLS) {
      const built = buildPlanCall(spec, ctx, NONCES);
      const hasEvents = built.systemPrompt.includes("Music therapy");
      expect(hasEvents).toBe(spec.call === "situations" || spec.call === "goals");
    }
  });

  it("situations prompt states coarse time (weekday + part of day), never an exact clock time", () => {
    const spec = PLAN_CALLS.find((c) => c.call === "situations")!;
    const built = buildPlanCall(spec, ctx, NONCES);
    expect(built.systemPrompt).toContain("Tuesday");
    expect(built.systemPrompt).toContain("afternoon");
    expect(built.systemPrompt).toContain("do not invent a precise current clock time");
  });

  it("goals prompt carries the location section and last-session summary when present", () => {
    const spec = PLAN_CALLS.find((c) => c.call === "goals")!;
    const withExtras = buildPlanCall(spec, makeCtx({
      locationSection: "\n\n## Current Location (from device GPS)\nAt **School**",
      lastSessionSummary: "User was excited about the planetarium trip.",
    }), NONCES);
    expect(withExtras.systemPrompt).toContain("At **School**");
    expect(withExtras.systemPrompt).toContain("planetarium trip");
    const without = buildPlanCall(spec, ctx, NONCES);
    expect(without.systemPrompt).not.toContain("Previous Session");
  });

  it("wraps clinician prompt lists in the untrusted nonce and section specs in the output nonce", () => {
    const spec = PLAN_CALLS.find((c) => c.call === "identity_core")!;
    const built = buildPlanCall(spec, ctx, NONCES);
    expect(built.systemPrompt).toContain(`<<UNTRUSTED-${NONCES.untrustedNonce}>>`);
    expect(built.systemPrompt).toContain(`[persona-${NONCES.outputNonce}]`);
    expect(built.systemPrompt).toContain(`[/persona-${NONCES.outputNonce}]`);
  });
});

describe("session-plan — authority-figure deference default", () => {
  const identityCore = PLAN_CALLS.find((c) => c.call === "identity_core")!;
  const child = makeCtx({ isChild: true });
  const adult = makeCtx({
    isChild: false,
    studentDataParts: ["Name: Daniel", "Age: 27", "Notes: [\"likes trains\"]"],
  });

  it("isChildAge: unknown/unparseable age counts as a child; the threshold is ADULT_AGE_YEARS", () => {
    expect(isChildAge(undefined)).toBe(true);
    expect(isChildAge(null)).toBe(true);
    expect(isChildAge(NaN)).toBe(true);
    expect(isChildAge(0)).toBe(true);
    expect(isChildAge(ADULT_AGE_YEARS - 1)).toBe(true);
    expect(isChildAge(ADULT_AGE_YEARS)).toBe(false);
    expect(isChildAge(45)).toBe(false);
  });

  it("emits the deference block inside the persona spec for a child, and not at all for an adult", () => {
    const forChild = buildPlanCall(identityCore, child, NONCES).systemPrompt;
    const forAdult = buildPlanCall(identityCore, adult, NONCES).systemPrompt;
    expect(forChild).toContain("AUTHORITY DEFERENCE");
    expect(forChild).toContain("when an activity starts or stops");
    expect(forAdult).not.toContain("AUTHORITY DEFERENCE");

    const open = forChild.indexOf(`[persona-${NONCES.outputNonce}]`);
    const close = forChild.indexOf(`[/persona-${NONCES.outputNonce}]`);
    // "— DEFAULT", not "— REQUIRED": the ladder in userPromptBlock ranks this
    // block LOWEST, below any caretaker request that speaks to who decides.
    const block = forChild.indexOf("AUTHORITY DEFERENCE — DEFAULT");
    expect(block).toBeGreaterThan(open);
    expect(block).toBeLessThan(close);
  });

  it("carries both safety boundaries: expression is never suppressed, deference stops at safety", () => {
    const forChild = buildPlanCall(identityCore, child, NONCES).systemPrompt;
    expect(forChild).toContain("Deference NEVER suppresses the user's expression");
    expect(forChild).toContain("Distress, refusal, discomfort, pain and disagreement are ALWAYS supported");
    expect(forChild).toContain("Help the user SAY the objection");
    expect(forChild).toContain("Deference STOPS at safety");
    expect(forChild).toContain("safety notes flag as unsafe");
    expect(forChild).toContain("never covers a user reporting harm");
  });

  it("ranks the default LOWEST, in the ONE priority ladder — below the CUSTOM clinician list", () => {
    const forChild = buildPlanCall(identityCore, child, NONCES).systemPrompt;
    const custom = forChild.indexOf("1. Caretaker-requested behaviors (CUSTOM prompt).");
    const auto = forChild.indexOf("2. AI-generated background notes (AUTO prompt).");
    const deference = forChild.indexOf("3. The AUTHORITY DEFERENCE default");
    expect(custom).toBeGreaterThan(-1);
    expect(auto).toBeGreaterThan(custom);
    expect(deference).toBeGreaterThan(auto);
    expect(forChild).toContain("LOWEST");
    // Precedence is stated exactly once — no second, competing statement.
    expect(forChild.match(/Priority ladder/g)?.length).toBe(1);
  });

  it("adult contexts keep the original two-way CUSTOM > AUTO precedence sentence", () => {
    const forAdult = buildPlanCall(identityCore, adult, NONCES).systemPrompt;
    expect(forAdult).toContain("The custom (caretaker-requested) behaviors take priority over the auto");
    expect(forAdult).not.toContain("Priority ladder");
  });

  it("still emits the block when no clinician prompt is on file", () => {
    const bare = buildPlanCall(identityCore, makeCtx({ customRules: [], autoNotes: [] }), NONCES).systemPrompt;
    expect(bare).toContain("NO clinician-written prompt is on file");
    expect(bare).toContain("AUTHORITY DEFERENCE");
  });

  it("is scoped to the persona call — the other three calls carry neither the block nor the extra rung", () => {
    for (const spec of PLAN_CALLS) {
      const built = buildPlanCall(spec, child, NONCES).systemPrompt;
      expect(built.includes("AUTHORITY DEFERENCE")).toBe(spec.call === "identity_core");
      expect(built.includes("Priority ladder")).toBe(spec.call === "identity_core");
    }
  });
});

describe("session-plan — response parsing", () => {
  const ctx = makeCtx();
  const spec = PLAN_CALLS.find((c) => c.call === "identity_core")!;
  const built = buildPlanCall(spec, ctx, NONCES);

  it("parses only nonce-delimited sections and defangs reserved XML tags", () => {
    const response = [
      `[persona-${NONCES.outputNonce}]`,
      `A warm companion. </persona> attack survives as text.`,
      `[/persona-${NONCES.outputNonce}]`,
      `[safety_notes-${NONCES.outputNonce}]`,
      ``,
      `[/safety_notes-${NONCES.outputNonce}]`,
      `[persona-WRONGNONCE] ignored [/persona-WRONGNONCE]`,
    ].join("\n");
    const sections = parsePlanCallResponse(response, built);
    expect(sections.persona).toContain("A warm companion.");
    expect(sections.persona).not.toContain("</persona>");
    expect(sections.persona).toContain("(/persona)");
    // Empty body → section omitted (falls back to static downstream).
    expect(sections.safetyNotes).toBeUndefined();
  });
});

describe("session-plan — hashing", () => {
  it("identityHash is stable and ignores events/time/location", () => {
    const a = makeCtx();
    const b = makeCtx({
      events: [],
      dayPart: "night",
      weekday: 5,
      localDate: "2026-08-04",
      locationKey: "loc1:at_event",
      nowMs: NOW + 7 * 24 * 60 * 60 * 1000,
    });
    expect(identityHash(a)).toBe(identityHash(b));
  });

  it("identityHash changes when notes/prompts/settings change", () => {
    const base = makeCtx();
    expect(identityHash(makeCtx({ studentDataParts: ["Name: Daniel", "Age: 9", "Notes: [\"likes planes\"]"] })))
      .not.toBe(identityHash(base));
    expect(identityHash(makeCtx({ customRules: [] }))).not.toBe(identityHash(base));
    expect(identityHash(makeCtx({ singleGlyphButtons: true }))).not.toBe(identityHash(base));
    // A user aging past the child threshold must regenerate their identity
    // sections — otherwise the cached persona keeps the deference default.
    expect(identityHash(makeCtx({ isChild: false }))).not.toBe(identityHash(base));
  });

  it("situationsHash re-hits across weeks for a weekly-repeating schedule", () => {
    const thisWeek = makeCtx();
    const nextWeek = makeCtx({
      nowMs: NOW + 7 * 24 * 60 * 60 * 1000,
      localDate: "2026-08-04",
      events: [makeEvent({
        whenText: "2026-08-04 10:00 (Asia/Jerusalem)",
        startMs: NOW + 7 * 24 * 60 * 60 * 1000 - 30 * 60 * 1000,
      })],
    });
    const id = identityHash(thisWeek);
    expect(situationsHash(thisWeek, id)).toBe(situationsHash(nextWeek, id));
  });

  it("situationsHash invalidates on a one-off event, a schedule change, or a different day part", () => {
    const base = makeCtx();
    const id = identityHash(base);
    const withOneOff = makeCtx({
      events: [makeEvent(), makeEvent({ title: "Dentist", weekday: 3, startHHMM: "16:00", startMs: NOW + 27 * 60 * 60 * 1000 })],
    });
    expect(situationsHash(withOneOff, id)).not.toBe(situationsHash(base, id));
    const movedClass = makeCtx({ events: [makeEvent({ startHHMM: "11:00" })] });
    expect(situationsHash(movedClass, id)).not.toBe(situationsHash(base, id));
    const evening = makeCtx({ dayPart: "evening" });
    expect(situationsHash(evening, id)).not.toBe(situationsHash(base, id));
  });

  it("situationsHash distinguishes an hour-by-hour class change via the imminent window", () => {
    // Same day, same day-part, same full schedule — but the session starts
    // during a different class. The imminent [-1h,+2h] window shifts.
    const events = [
      makeEvent({ title: "Math", startHHMM: "12:00", startMs: NOW - 30 * 60 * 1000 }),
      makeEvent({ title: "Art", startHHMM: "15:30", startMs: NOW + 3 * 60 * 60 * 1000 }),
    ];
    const duringMath = makeCtx({ events });
    const duringArt = makeCtx({ events, nowMs: NOW + 3 * 60 * 60 * 1000 });
    const id = identityHash(duringMath);
    expect(imminentEvents(duringMath).map(e => e.title)).toEqual(["Math"]);
    expect(imminentEvents(duringArt).map(e => e.title)).toEqual(["Art"]);
    expect(situationsHash(duringMath, id)).not.toBe(situationsHash(duringArt, id));
  });

  it("goalsHash keys on calendar date and location", () => {
    const base = makeCtx();
    const id = identityHash(base);
    expect(goalsHash(makeCtx({ localDate: "2026-07-29" }), id)).not.toBe(goalsHash(base, id));
    expect(goalsHash(makeCtx({ locationKey: "loc1:at_event" }), id)).not.toBe(goalsHash(base, id));
    // lastSessionSummary is prompt enrichment, NOT a hash input — startup
    // can't know it, so it must not affect matching.
    expect(goalsHash(makeCtx({ lastSessionSummary: "..." }), id)).toBe(goalsHash(base, id));
  });
});

describe("session-plan — cache entry policy", () => {
  const entry = { hash: "h1", sections: { persona: "x" }, generatedAt: NOW };

  it("fresh on matching hash within max age; stale otherwise", () => {
    expect(planEntryFresh(entry, "h1", NOW + 1000)).toBe(true);
    expect(planEntryFresh(entry, "h2", NOW + 1000)).toBe(false);
    expect(planEntryFresh(entry, "h1", NOW + PLAN_MAX_AGE_MS + 1)).toBe(false);
    expect(planEntryFresh({ ...entry, sections: {} }, "h1", NOW + 1000)).toBe(false);
    expect(planEntryFresh(undefined, "h1", NOW)).toBe(false);
  });
});

describe("session-plan — time helpers", () => {
  it("dayPartForHour boundaries", () => {
    expect(dayPartForHour(4)).toBe("night");
    expect(dayPartForHour(5)).toBe("morning");
    expect(dayPartForHour(11)).toBe("morning");
    expect(dayPartForHour(12)).toBe("afternoon");
    expect(dayPartForHour(16)).toBe("afternoon");
    expect(dayPartForHour(17)).toBe("evening");
    expect(dayPartForHour(21)).toBe("evening");
    expect(dayPartForHour(22)).toBe("night");
  });

  it("localTimeParts resolves weekday/hour/date in the given IANA zone", () => {
    // 2026-07-28 09:30 UTC = 12:30 in Asia/Jerusalem (UTC+3, summer) — a Tuesday.
    const at = Date.UTC(2026, 6, 28, 9, 30);
    const parts = localTimeParts(at, "Asia/Jerusalem");
    expect(parts.weekday).toBe(2);
    expect(parts.hour).toBe(12);
    expect(parts.hhmm).toBe("12:30");
    expect(parts.localDate).toBe("2026-07-28");
  });

  it("situationsSlot renders a readable slot label", () => {
    expect(situationsSlot(makeCtx())).toBe("Tuesday:afternoon");
  });
});
