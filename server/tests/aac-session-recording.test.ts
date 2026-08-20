// Session-recording policy: the settings chokepoint and the disk-budget
// planner. Both are read by three separate processes (the clinician editor, the
// AAC renderer, the Electron main process), so a partial or unclamped object
// escaping here would be wrong in three places at once.

import {
  DEFAULT_SESSION_RECORDING,
  IDLE_TAIL_SECONDS_MAX,
  IDLE_TAIL_SECONDS_MIN,
  MAX_STORAGE_MB_MIN,
  PRE_ROLL_SECONDS_MAX,
  cameraBitrateFor,
  cameraConstraintsFor,
  normalizeSessionRecordingSettings,
  planEviction,
  type StoredClip,
} from "@shared/aac/session-recording.js";
import { AAC_SETTINGS_FIELDS } from "../services/studentService.js";

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

describe("the settings save path", () => {
  it("routes sessionRecording to the aac_settings table", () => {
    // THE footgun this repo keeps stepping on: splitUpdateBody drops any field
    // missing from this allow-list into the STUDENTS update instead, where the
    // column does not exist — so the clinician panel appears to save, reports
    // success, and the setting is silently gone on the next load. The header
    // comment in AACSettingsPanel.tsx warns about it; this asserts it.
    expect(AAC_SETTINGS_FIELDS.has("sessionRecording")).toBe(true);
  });
});
