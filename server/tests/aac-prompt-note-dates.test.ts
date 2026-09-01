// Per-student prompt notes carry the date they were written.
//
// PROD 2026-08-30 (שחף). Three sessions in one day, a child in acute distress
// pressing "I'm still scared" twenty-six times across ninety minutes, and every
// agent in the system reading this from her AAC scratchpad as present-tense
// fact:
//
//   "Shachaf was hospitalized this morning (August 8) after a cluster of
//    seizures; she received Midazolam and is in the ER. … Reassure her that
//    she is safe and will go home soon."
//   "When she expresses fear or distress about the hospital, validate her
//    feelings and remind her that her parents and doctors helped her."
//
// Twenty-two days stale, beside a caretaker rule reading "one night in the
// hospital, then home with family". Neither sentence was wrong on the day it
// was written. The Monitor then amplified them into "respond with validation
// and warmth, NOT engagement questions" — which is why nobody, human or
// machine, ever asked her what she was afraid of.
//
// The field already said "delete a note when it is no longer true". Nothing
// could carry that out: the notes had no dates, so "still true?" was
// unanswerable. These pin the date, not a sweep — deciding what has expired is
// the cleanup agent's judgement, and plenty of notes never expire.

import { describe, it, expect } from "@jest/globals";
import {
  promptNoteToday,
  parsePromptNote,
  stampPromptNote,
  normalizeAacPromptList,
} from "../services/memory-schema/aac-memory-schema.js";
import { sanitizePromptList } from "../services/memory-schema/aac-settings-memory-schema.js";

describe("promptNoteToday", () => {
  it("is the LOCAL calendar day, not UTC's", () => {
    // 2026-08-30 22:30 local. In Israel that is already the 30th while UTC
    // still reads the 30th at 19:30 — but late enough in the year/zone
    // combinations that a UTC-based stamp can name the NEXT day. The date a
    // caretaker would write is the local one.
    const d = new Date(2026, 7, 30, 22, 30, 0);
    expect(promptNoteToday(d)).toBe("2026-08-30");
  });

  it("zero-pads month and day", () => {
    expect(promptNoteToday(new Date(2026, 0, 5))).toBe("2026-01-05");
  });
});

describe("stamping and parsing", () => {
  it("puts the date in front of the note", () => {
    expect(stampPromptNote("She likes music", "2026-08-31"))
      .toBe("[2026-08-31] She likes music");
  });

  it("leaves an already-stamped note ALONE", () => {
    // The load-bearing case: the model sees the prefixes and echoes them back
    // when it rewrites the list. Re-stamping there would reset every note's
    // age to today and destroy the only signal that says what has expired.
    const old = "[2026-08-08] Shachaf is in the ER";
    expect(stampPromptNote(old, "2026-08-31")).toBe(old);
  });

  it("round-trips date and text", () => {
    const stamped = stampPromptNote("Hospitalized this morning", "2026-08-08");
    expect(parsePromptNote(stamped)).toEqual({ date: "2026-08-08", text: "Hospitalized this morning" });
  });

  it("reads a legacy note with no prefix as simply undated", () => {
    // Every note in production predates this. An undated note is an older
    // note, not a broken one — that is what let the change ship without a
    // backfill.
    expect(parsePromptNote("She likes music")).toEqual({ text: "She likes music" });
  });

  it("does not mistake other bracketed text for a date", () => {
    for (const s of ["[CONTEXT] something", "[2026-8-8] short", "[26-08-08] short", "no brackets"]) {
      expect(parsePromptNote(s).date).toBeUndefined();
    }
  });

  it("never stamps an empty note into existence", () => {
    expect(stampPromptNote("   ", "2026-08-31")).toBe("");
  });
});

describe("sanitizePromptList — stamping on the way in", () => {
  it("stamps undated entries and preserves dated ones, in one pass", () => {
    const out = sanitizePromptList(
      ["[2026-08-08] Shachaf is in the ER", "She started physio today"],
      "2026-08-31",
    );
    expect(out).toEqual([
      "[2026-08-08] Shachaf is in the ER",
      "[2026-08-31] She started physio today",
    ]);
  });

  it("leaves the list untouched when no date is supplied", () => {
    // Reads and other non-writing paths must not mutate what they render.
    expect(sanitizePromptList(["She likes music"])).toEqual(["She likes music"]);
  });

  it("still normalizes, defangs and caps as it did before", () => {
    expect(sanitizePromptList(null, "2026-08-31")).toEqual([]);
    expect(sanitizePromptList("a single legacy string", "2026-08-31"))
      .toEqual(["[2026-08-31] a single legacy string"]);
    expect(sanitizePromptList(["[CONTEXT] injected"], "2026-08-31")[0])
      .toBe("[2026-08-31] (CONTEXT) injected");
    expect(sanitizePromptList(Array.from({ length: 80 }, (_, i) => `n${i}`), "2026-08-31")).toHaveLength(50);
  });
});

describe("what the reader can now answer", () => {
  it("the stale hospital note is legible as three weeks old", () => {
    // The whole point, expressed as the incident: a reader holding today's
    // date can tell that this note describes a moment that has passed. Whether
    // to delete or rewrite it stays the cleanup agent's call — a note about
    // the person beside it is equally old and perfectly valid.
    const list = normalizeAacPromptList([
      stampPromptNote("Shachaf was hospitalized this morning and is in the ER", "2026-08-08"),
      stampPromptNote("Shachaf communicates by AAC buttons and clear head gestures", "2026-08-08"),
    ]);
    const today = "2026-08-30";
    const parsed = list.map(parsePromptNote);
    expect(parsed.every((n) => n.date !== undefined && n.date < today)).toBe(true);
    // Both are old; only one is about a moment. Nothing here decides that —
    // the date just makes the question answerable.
    expect(parsed[0].text).toContain("this morning");
    expect(parsed[1].text).not.toMatch(/this morning|today|currently/);
  });
});
