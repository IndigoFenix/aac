// The per-student device-location setting (`aac_settings.device_location_enabled`).
//
// Two consumers depend on it: the AAC session's startup/refresh GPS, which
// places the student at a registered institute location, and the venue lanes'
// "somewhere near me" search. Both read it from the same column, so the ONE
// thing that can silently break the whole feature is the save path.

import { AAC_SETTINGS_FIELDS } from "../services/studentService.js";

describe("deviceLocationEnabled save path", () => {
  it("routes deviceLocationEnabled to the aac_settings table", () => {
    // THE footgun this repo keeps stepping on: splitUpdateBody drops any field
    // missing from this allow-list into the STUDENTS update instead, where the
    // column does not exist — so the clinician panel appears to save, reports
    // success, and the setting is silently gone on the next load. A location
    // toggle that quietly refuses to turn on is worse than no toggle: the
    // clinician believes they granted it and the sessions never see a fix.
    expect(AAC_SETTINGS_FIELDS.has("deviceLocationEnabled")).toBe(true);
  });

  it("is NOT reachable through the aac-prefixed alias by accident", () => {
    // splitUpdateBody also accepts old-style "aac<Field>" keys. That is fine,
    // but the canonical name is what the panel sends; assert we did not add
    // only a prefixed variant.
    expect(AAC_SETTINGS_FIELDS.has("aacDeviceLocationEnabled")).toBe(false);
  });
});
