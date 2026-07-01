// server/tests/admin-budget-fields.test.ts
//
// Guards the source-of-truth list of admin-managed ("Token Budget") AAC-settings
// fields. These are writable ONLY through the admin budget endpoint; the normal
// clinician student-update path strips exactly this set (studentService), and
// the AAC Settings page renders them read-only. If this list drifts, a cost
// control silently becomes clinician-editable — so pin it down.

import {
  ADMIN_ONLY_AAC_FIELDS,
  ADMIN_ONLY_AAC_FIELD_SET,
} from "@shared/aac/admin-budget-fields";

describe("admin-budget-fields", () => {
  it("is exactly the four Token Budget controls", () => {
    expect([...ADMIN_ONLY_AAC_FIELDS].sort()).toEqual(
      [
        "allowFacilitatorControl",
        "boardManagerLiveModel",
        "budgetTier",
        "fullAttentionMode",
      ].sort(),
    );
  });

  it("has no duplicates", () => {
    expect(new Set(ADMIN_ONLY_AAC_FIELDS).size).toBe(ADMIN_ONLY_AAC_FIELDS.length);
  });

  it("exposes a membership set covering every listed field", () => {
    for (const field of ADMIN_ONLY_AAC_FIELDS) {
      expect(ADMIN_ONLY_AAC_FIELD_SET.has(field)).toBe(true);
    }
    expect(ADMIN_ONLY_AAC_FIELD_SET.has("liveAudioSpeaker")).toBe(false);
    expect(ADMIN_ONLY_AAC_FIELD_SET.size).toBe(ADMIN_ONLY_AAC_FIELDS.length);
  });

  it("mirrors the strip loop's contract: deleting these keys from an update body clears the admin-managed fields and nothing else", () => {
    const body: Record<string, unknown> = {
      budgetTier: "premium",
      fullAttentionMode: true,
      boardManagerLiveModel: true,
      allowFacilitatorControl: true,
      // A non-budget AAC field that must survive the strip.
      languageLevel: 3,
    };
    for (const field of ADMIN_ONLY_AAC_FIELDS) delete body[field];
    expect(body).toEqual({ languageLevel: 3 });
  });
});
