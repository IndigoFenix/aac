// Session-recording policy: the settings chokepoint and the disk-budget
// planner. Both are read by three separate processes (the clinician editor, the
// AAC renderer, the Electron main process), so a partial or unclamped object
// escaping here would be wrong in three places at once.

import {
  applySessionRecordingLicense,
  DEFAULT_SESSION_RECORDING,
  IDLE_TAIL_SECONDS_MAX,
  IDLE_TAIL_SECONDS_MIN,
  MAX_STORAGE_MB_MIN,
  PRE_ROLL_SECONDS_MAX,
  cameraBitrateFor,
  cameraConstraintsFor,
  normalizeSessionRecordingSettings,
  planEviction,
  planStudentPurge,
  type PurgeCandidate,
  type StoredClip,
} from "@shared/aac/session-recording.js";
import { AAC_SETTINGS_FIELDS } from "../services/studentService.js";
import { AAC_SETTINGS_FIELD } from "../services/memory-schema/aac-settings-memory-schema.js";

describe("normalizeSessionRecordingSettings", () => {
  it("returns the safe defaults for an absent column", () => {
    // Existing rows have `{}` from the migration default, and older rows null.
    for (const raw of [undefined, null, {}, "", 0]) {
      expect(normalizeSessionRecordingSettings(raw)).toEqual(DEFAULT_SESSION_RECORDING);
    }
  });

  it("is off by default", () => {
    // Recording a child is opt-in, always. A missing column must never read as
    // consent.
    expect(normalizeSessionRecordingSettings({}).enabled).toBe(false);
  });

  it("only treats a literal true as enabled", () => {
    // Truthy-but-not-true values ("false", 1, "yes") reaching this from a
    // hand-edited row must not switch a camera on.
    for (const enabled of ["true", 1, "yes", {}, []]) {
      expect(normalizeSessionRecordingSettings({ enabled }).enabled).toBe(false);
    }
    expect(normalizeSessionRecordingSettings({ enabled: true }).enabled).toBe(true);
  });

  it("clamps every numeric field into its documented range", () => {
    const low = normalizeSessionRecordingSettings({
      preRollSeconds: -50, idleTailSeconds: 0, maxClipMinutes: 0, maxStorageMb: 1,
    });
    expect(low.preRollSeconds).toBe(0);
    expect(low.idleTailSeconds).toBe(IDLE_TAIL_SECONDS_MIN);
    expect(low.maxClipMinutes).toBe(1);
    expect(low.maxStorageMb).toBe(MAX_STORAGE_MB_MIN);

    const high = normalizeSessionRecordingSettings({
      preRollSeconds: 9_999, idleTailSeconds: 9_999, maxClipMinutes: 9_999,
      maxStorageMb: 99_999_999,
    });
    expect(high.preRollSeconds).toBe(PRE_ROLL_SECONDS_MAX);
    expect(high.idleTailSeconds).toBe(IDLE_TAIL_SECONDS_MAX);
    expect(high.maxClipMinutes).toBe(60);
    expect(high.maxStorageMb).toBe(1024 * 500);
  });

  it("falls back rather than propagating a non-numeric duration", () => {
    const s = normalizeSessionRecordingSettings({
      preRollSeconds: "abc", idleTailSeconds: NaN, maxClipMinutes: undefined,
    });
    expect(s.preRollSeconds).toBe(DEFAULT_SESSION_RECORDING.preRollSeconds);
    expect(s.idleTailSeconds).toBe(DEFAULT_SESSION_RECORDING.idleTailSeconds);
    expect(s.maxClipMinutes).toBe(DEFAULT_SESSION_RECORDING.maxClipMinutes);
  });

  it("reads an ABSENT numeric field as its default, never as its minimum", () => {
    // Number(null) and Number("") are both 0, which is finite — coercing before
    // testing for absence would hand a half-written row the 1 GB floor and a
    // one-minute clip cap instead of the documented defaults.
    for (const absent of [null, undefined, "", "   ", false]) {
      const s = normalizeSessionRecordingSettings({
        maxStorageMb: absent, maxClipMinutes: absent, idleTailSeconds: absent,
        preRollSeconds: absent,
      });
      expect(s.maxStorageMb).toBe(DEFAULT_SESSION_RECORDING.maxStorageMb);
      expect(s.maxClipMinutes).toBe(DEFAULT_SESSION_RECORDING.maxClipMinutes);
      expect(s.idleTailSeconds).toBe(DEFAULT_SESSION_RECORDING.idleTailSeconds);
      expect(s.preRollSeconds).toBe(DEFAULT_SESSION_RECORDING.preRollSeconds);
    }
  });

  it("still honours an explicit zero pre-roll", () => {
    // Zero must survive the absence guard above — it is the "no idle encoders"
    // setting, not a missing value.
    expect(normalizeSessionRecordingSettings({ preRollSeconds: 0 }).preRollSeconds).toBe(0);
    expect(normalizeSessionRecordingSettings({ preRollSeconds: "0" }).preRollSeconds).toBe(0);
  });

  it("accepts a numeric string, which is what a form control sends", () => {
    expect(normalizeSessionRecordingSettings({ idleTailSeconds: "45" }).idleTailSeconds).toBe(45);
  });

  it("rounds fractional durations to whole units", () => {
    expect(normalizeSessionRecordingSettings({ preRollSeconds: 10.6 }).preRollSeconds).toBe(11);
  });

  it("rejects an unknown quality rather than passing it to a constraint", () => {
    expect(normalizeSessionRecordingSettings({ quality: "4k" }).quality).toBe("720p");
    expect(normalizeSessionRecordingSettings({ quality: "1080p" }).quality).toBe("1080p");
  });

  it("treats a blank folder as the shell default, not as a path", () => {
    // An empty string would otherwise create a directory named "" beside the
    // executable.
    for (const folder of ["", "   ", 42, null]) {
      expect(normalizeSessionRecordingSettings({ folder }).folder).toBeNull();
    }
    expect(normalizeSessionRecordingSettings({ folder: "  D:\\Clips  " }).folder)
      .toBe("D:\\Clips");
  });

  it("keeps the pre-roll floor at zero so the idle encoders can be switched off", () => {
    // Zero is a meaningful setting, not a degenerate one: it skips the paired
    // idle encoders entirely.
    expect(normalizeSessionRecordingSettings({ preRollSeconds: 0 }).preRollSeconds).toBe(0);
  });
});

describe("capture profiles", () => {
  it("raises the bitrate with the resolution", () => {
    expect(cameraBitrateFor("720p")).toBeLessThan(cameraBitrateFor("1080p"));
    expect(cameraBitrateFor("1080p")).toBeLessThan(cameraBitrateFor("max"));
  });

  it("leaves the shared camera at its existing size on the default quality", () => {
    // 720p is what useMultiCamera already acquires, so the default costs face
    // tracking and the Observer's frame grid nothing.
    const c = cameraConstraintsFor("720p") as { width: { ideal: number } };
    expect(c.width.ideal).toBe(1280);
  });
});

describe("planEviction", () => {
  const clip = (id: string, startedAtMs: number, mb: number): StoredClip =>
    ({ id, startedAtMs, bytes: mb * 1024 * 1024 });
  const MB = 1024 * 1024;

  it("deletes nothing while the folder fits", () => {
    const clips = [clip("a", 1, 100), clip("b", 2, 100)];
    expect(planEviction(clips, 500 * MB)).toEqual({ deleteIds: [], shortfallBytes: 0 });
  });

  it("deletes oldest first, and only as many as it takes", () => {
    const clips = [clip("c", 3, 100), clip("a", 1, 100), clip("b", 2, 100)];
    const plan = planEviction(clips, 250 * MB);
    expect(plan.deleteIds).toEqual(["a"]);
    expect(plan.shortfallBytes).toBe(0);
  });

  it("orders by start time, not by array order", () => {
    const clips = [clip("newest", 300, 100), clip("oldest", 100, 100), clip("mid", 200, 100)];
    expect(planEviction(clips, 100 * MB).deleteIds).toEqual(["oldest", "mid"]);
  });

  it("never deletes a clip that is still being written", () => {
    // The open clip's files are held by the encoder; deleting them mid-write
    // would leave the recorder streaming into a hole.
    const clips = [clip("open", 300, 400), clip("old", 100, 100), clip("older", 50, 100)];
    const plan = planEviction(clips, 100 * MB, ["open"]);
    expect(plan.deleteIds).not.toContain("open");
    expect(plan.deleteIds).toEqual(["older", "old"]);
  });

  it("never deletes the newest clip, and reports the shortfall instead", () => {
    // A budget too small for one clip is a misconfiguration to surface — not a
    // reason to throw away the footage just captured.
    const clips = [clip("old", 1, 100), clip("huge", 2, 900)];
    const plan = planEviction(clips, 200 * MB);
    expect(plan.deleteIds).toEqual(["old"]);
    expect(plan.shortfallBytes).toBe(700 * MB);
  });

  it("keeps the sole clip even when it alone busts the budget", () => {
    const plan = planEviction([clip("only", 1, 5000)], 100 * MB);
    expect(plan.deleteIds).toEqual([]);
    expect(plan.shortfallBytes).toBeGreaterThan(0);
  });

  it("does not mutate the caller's list", () => {
    const clips = [clip("b", 2, 100), clip("a", 1, 100)];
    planEviction(clips, 50 * MB);
    expect(clips.map((c) => c.id)).toEqual(["b", "a"]);
  });

  it("handles an empty folder", () => {
    expect(planEviction([], 100 * MB)).toEqual({ deleteIds: [], shortfallBytes: 0 });
  });
});

describe("planStudentPurge", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const NOW = 1_800_000_000_000;
  const MB = 1024 * 1024;
  const clip = (
    id: string, ageDays: number, studentId: string | null, mb = 10,
  ): PurgeCandidate =>
    ({ id, startedAtMs: NOW - ageDays * DAY, bytes: mb * MB, studentId });

  const plan = (clips: PurgeCandidate[], studentId = "s1", retentionDays = 30, open?: string[]) =>
    planStudentPurge(clips, { studentId, retentionDays, nowMs: NOW, protectedIds: open });

  it("takes every clip the manifest attributes to the student", () => {
    const clips = [clip("a", 1, "s1"), clip("b", 2, "s2"), clip("c", 3, "s1")];
    const result = plan(clips);
    expect(result.clipIds).toEqual(["c", "a"]); // oldest first
    expect(result.bytes).toBe(20 * MB);
  });

  it("takes footage of the erased student however new it is", () => {
    // Age retention is irrelevant here: this is erasure, not housekeeping.
    expect(plan([clip("fresh", 0, "s1")]).clipIds).toEqual(["fresh"]);
  });

  it("never touches another student's footage", () => {
    const clips = [clip("theirs", 200, "s2"), clip("mine", 1, "s1")];
    expect(plan(clips).clipIds).toEqual(["mine"]);
  });

  it("takes an unattributable clip only once it is past retention", () => {
    // A crash-recovered manifest has studentId null (recoverOrphans cannot know
    // whose session it was). Deleting every orphan would destroy a DIFFERENT,
    // still-enrolled child's footage; deleting the ones the age sweep would
    // take anyway is the safe half.
    const clips = [clip("young-orphan", 5, null), clip("old-orphan", 45, null)];
    expect(plan(clips).clipIds).toEqual(["old-orphan"]);
  });

  it("uses the retention window it is given for the orphan rule", () => {
    const clips = [clip("orphan", 45, null)];
    expect(plan(clips, "s1", 90).clipIds).toEqual([]);
    expect(plan(clips, "s1", 7).clipIds).toEqual(["orphan"]);
  });

  it("falls back to the default window when retention is nonsense", () => {
    const clips = [clip("orphan", 45, null)];
    expect(planStudentPurge(clips, {
      studentId: "s1", retentionDays: Number.NaN, nowMs: NOW,
    }).clipIds).toEqual(["orphan"]);
    expect(planStudentPurge(clips, {
      studentId: "s1", retentionDays: 0, nowMs: NOW,
    }).clipIds).toEqual(["orphan"]);
  });

  it("never deletes a clip that is still being written", () => {
    const clips = [clip("open", 0, "s1"), clip("closed", 1, "s1")];
    expect(plan(clips, "s1", 30, ["open"]).clipIds).toEqual(["closed"]);
  });

  it("refuses a blank student id rather than matching everything", () => {
    // A purge message with an empty studentId must be inert, not a wipe.
    const clips = [clip("a", 1, "s1"), clip("b", 400, null)];
    for (const id of ["", "   "]) {
      expect(planStudentPurge(clips, { studentId: id, retentionDays: 30, nowMs: NOW }))
        .toEqual({ clipIds: [], bytes: 0 });
    }
  });

  it("handles a device that never recorded", () => {
    expect(plan([])).toEqual({ clipIds: [], bytes: 0 });
  });
});

describe("applySessionRecordingLicense", () => {
  // The licence gate itself. It runs in three places — the server's settings
  // read path, the server's settings write path, and the AAC client before it
  // will start an encoder — so this is the one piece of the entitlement whose
  // behaviour has to be identical everywhere.

  it("forces the switch off when the licence does not carry the entitlement", () => {
    // The case that matters: a row that says ON, a licence that says NO.
    // Whatever is stored, an unlicensed student does not record.
    expect(applySessionRecordingLicense({ enabled: true }, false).enabled).toBe(false);
  });

  it("leaves a licensed student's settings alone", () => {
    expect(applySessionRecordingLicense({ enabled: true }, true).enabled).toBe(true);
    expect(applySessionRecordingLicense({ enabled: false }, true).enabled).toBe(false);
  });

  it("keeps the rest of the object intact while unlicensed", () => {
    // A lapsed licence is not a reason to throw away a caretaker's disk budget
    // and folder — those have to come back unchanged if the licence returns.
    const gated = applySessionRecordingLicense(
      { enabled: true, quality: "1080p", maxStorageMb: 4096, maxAgeDays: 7, folder: "D:\\clips" },
      false,
    );
    expect(gated).toEqual({
      ...DEFAULT_SESSION_RECORDING,
      enabled: false,
      quality: "1080p",
      maxStorageMb: 4096,
      maxAgeDays: 7,
      folder: "D:\\clips",
    });
  });

  it("still normalizes — the gate does not skip the clamps", () => {
    // Licensed input goes through the same sanitization as everything else;
    // gating must not become a way to smuggle an unclamped object through.
    const licensed = applySessionRecordingLicense(
      { enabled: true, idleTailSeconds: 99_999, quality: "8k" },
      true,
    );
    expect(licensed.idleTailSeconds).toBe(IDLE_TAIL_SECONDS_MAX);
    expect(licensed.quality).toBe(DEFAULT_SESSION_RECORDING.quality);
  });

  it("treats an absent column as off under either licence", () => {
    for (const licensed of [true, false]) {
      expect(applySessionRecordingLicense(undefined, licensed)).toEqual(DEFAULT_SESSION_RECORDING);
    }
  });
});

describe("the settings save path", () => {
  it("routes sessionRecording to the aac_settings table", () => {
    // THE footgun this repo keeps stepping on: splitUpdateBody drops any field
    // missing from this allow-list into the STUDENTS update instead, where the
    // column does not exist — so the clinician panel appears to save, reports
    // success, and the setting is silently gone on the next load. The header
    // comment in AACSettingsPanel.tsx warns about it; this asserts it.
    expect(AAC_SETTINGS_FIELDS.has("sessionRecording")).toBe(true);
  });

  it("keeps sessionRecording out of the AI-editable settings schema", () => {
    // The module docblock promises this and the promise is load-bearing: the
    // AI's write path (institute-memory-schema's pickDeclaredAacFields) keeps
    // only keys DECLARED in this schema, so a declaration here would be enough
    // to let an assistant start a camera recording of a child. Asserted rather
    // than trusted, because nothing else would notice the day someone adds it
    // "for completeness".
    expect(Object.keys(AAC_SETTINGS_FIELD.properties ?? {})).not.toContain("sessionRecording");
  });
});
