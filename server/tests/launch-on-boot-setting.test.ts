// The per-student start-with-the-device setting (`aac_settings.launch_on_boot`).
//
// Stored per student, applied per DEVICE: the Electron shell mirrors it into the
// OS login item whenever it loads a profile (client-aac/src/hooks/useLaunchOnBoot.ts).
// What is pinned here is the two ends nobody notices breaking — the save path,
// and the fact that the AI cannot flip it.

import { AAC_SETTINGS_FIELDS } from "../services/studentService.js";

describe("launchOnBoot save path", () => {
  it("routes launchOnBoot to the aac_settings table", () => {
    // THE footgun this repo keeps stepping on: splitUpdateBody drops any field
    // missing from this allow-list into the STUDENTS update instead, where the
    // column does not exist — so the clinician panel appears to save, reports
    // success, and the setting is silently gone on the next load. Here that
    // would read as "autostart doesn't work on this machine", which is a
    // hardware/provisioning hunt, not a settings hunt.
    expect(AAC_SETTINGS_FIELDS.has("launchOnBoot")).toBe(true);
  });

  it("is NOT reachable through the aac-prefixed alias by accident", () => {
    expect(AAC_SETTINGS_FIELDS.has("aacLaunchOnBoot")).toBe(false);
  });
});

describe("launchOnBoot is clinician-only", () => {
  it("is absent from the AI-writable aac_settings columns", async () => {
    // The memory schema's write path filters to an explicit WRITABLE_COLUMNS
    // allow-list, so a new column is AI-read-only by default. This asserts the
    // default was not later widened: deciding that a device turns itself on is
    // a caretaker's call about a physical machine in a room, and belongs on the
    // same footing as deviceLocationEnabled and sessionRecording.
    const source = await import("node:fs/promises").then((fs) =>
      fs.readFile(
        new URL("../services/memory-schema/aac-settings-memory-schema.ts", import.meta.url),
        "utf8",
      ),
    );
    const block = source.slice(
      source.indexOf("const WRITABLE_COLUMNS"),
      source.indexOf("const filtered"),
    );
    expect(block).not.toContain("launchOnBoot");
  });
});
