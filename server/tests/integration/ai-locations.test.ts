/**
 * AI (manage-memory) location flows — integration, real DB.
 *
 * Exercises the institute memory-schema DB ops the AI drives:
 *   - Context_Locations.add auto-geocodes a typed address into GPS coords.
 *   - Context_Locations.update re-geocodes when the address changes.
 *   - Context_Calendar.add accepts locationIds and the location shows up on read.
 *
 * Geocoding (the external Nominatim/Google call) is mocked; everything else is
 * the real service + repository + DB path.
 */

import { describe, it, expect, afterEach, beforeEach, jest } from "@jest/globals";
import { truncateAll } from "../helpers/db.js";
import { makeUser, makeInstitute } from "../helpers/factories.js";
import { locationService } from "../../services/locationService.js";
import {
  INSTITUTE_LOCATIONS_FIELD,
  INSTITUTE_CALENDAR_FIELD,
} from "../../services/memory-schema/institute-memory-schema.js";

describe("AI location memory-schema flows", () => {
  afterEach(async () => {
    jest.restoreAllMocks();
    await truncateAll();
  });

  let userId: string;
  let instituteId: string;
  let ctx: any;

  beforeEach(async () => {
    const user = await makeUser();
    const { institute } = await makeInstitute(user.id); // creator is admin
    userId = user.id;
    instituteId = institute.id;
    ctx = { all: { userId, instituteId } };
  });

  const locOps = () => INSTITUTE_LOCATIONS_FIELD.db!;
  const calOps = () => INSTITUTE_CALENDAR_FIELD.db!;

  it("auto-geocodes the address when the AI adds a location without coordinates", async () => {
    const spy = jest
      .spyOn(locationService, "geocodeAddress")
      .mockResolvedValue({ lat: 32.0853, lng: 34.7818, displayName: "Tel Aviv", provider: "nominatim" });

    const created: any = await locOps().add!(ctx, { title: "Main Clinic", address: "1 Health St, Tel Aviv" });

    expect(spy).toHaveBeenCalledWith("1 Health St, Tel Aviv");
    expect(created.latitude).toBeCloseTo(32.0853, 4);
    expect(created.longitude).toBeCloseTo(34.7818, 4);
    expect(created.id).toBeTruthy();
  });

  it("fails helpfully when an address cannot be geocoded and no coords are given", async () => {
    jest.spyOn(locationService, "geocodeAddress").mockResolvedValue(null);
    await expect(locOps().add!(ctx, { title: "Nowhere", address: "asdkjfh" })).rejects.toThrow(/Could not find GPS/i);
  });

  it("accepts explicit coordinates without geocoding", async () => {
    const spy = jest.spyOn(locationService, "geocodeAddress");
    const created: any = await locOps().add!(ctx, { title: "Manual", latitude: 10, longitude: 20 });
    expect(spy).not.toHaveBeenCalled();
    expect(created.latitude).toBe(10);
  });

  it("re-geocodes when the AI edits the address", async () => {
    jest.spyOn(locationService, "geocodeAddress").mockResolvedValueOnce({ lat: 1, lng: 1, displayName: "a", provider: "nominatim" });
    const created: any = await locOps().add!(ctx, { title: "Place", address: "first address" });

    jest.spyOn(locationService, "geocodeAddress").mockResolvedValueOnce({ lat: 5, lng: 6, displayName: "b", provider: "google" });
    const updated: any = await locOps().update!(ctx, created.id, { address: "second address" });

    expect(updated.latitude).toBeCloseTo(5, 4);
    expect(updated.longitude).toBeCloseTo(6, 4);
  });

  it("attaches a location to an event the AI creates and surfaces it on read", async () => {
    jest.spyOn(locationService, "geocodeAddress").mockResolvedValue({ lat: 2, lng: 3, displayName: "x", provider: "nominatim" });
    const loc: any = await locOps().add!(ctx, { title: "Therapy Room", address: "somewhere" });

    const event: any = await calOps().add!(ctx, {
      title: "Music Therapy",
      startTime: "2026-07-01T10:00:00",
      endTime: "2026-07-01T11:00:00",
      instituteId,
      locationIds: [loc.id],
    });
    expect(event.locationIds).toContain(loc.id);

    const fetched: any = await calOps().get!(ctx, event.id);
    expect(fetched.locationIds).toContain(loc.id);
  });
});
