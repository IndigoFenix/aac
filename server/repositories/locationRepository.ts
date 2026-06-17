// server/repositories/locationRepository.ts
// Repository for registered GPS locations (institute-scoped) and the
// calendar_event_locations join table.

import {
  locations,
  calendarEventLocations,
  type Location,
  type InsertLocation,
  type UpdateLocation,
} from "@shared/schema";
import { db } from "../db";
import { eq, and, inArray } from "drizzle-orm";
import { haversineMeters } from "@shared/location-matching";

export class LocationRepository {
  async create(data: InsertLocation, createdByUserId: string): Promise<Location> {
    const [row] = await db
      .insert(locations)
      .values({ ...data, createdByUserId })
      .returning();
    return row;
  }

  async getById(id: string): Promise<Location | undefined> {
    const [row] = await db.select().from(locations).where(eq(locations.id, id));
    return row || undefined;
  }

  async update(id: string, updates: UpdateLocation): Promise<Location | undefined> {
    const [row] = await db
      .update(locations)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(locations.id, id))
      .returning();
    return row || undefined;
  }

  /** Soft-delete: mark inactive so historical event links remain meaningful. */
  async deactivate(id: string): Promise<boolean> {
    const [row] = await db
      .update(locations)
      .set({ isActive: false, updatedAt: new Date() })
      .where(eq(locations.id, id))
      .returning({ id: locations.id });
    return !!row;
  }

  /** Active locations for a single institute. */
  async listByInstitute(instituteId: string): Promise<Location[]> {
    return db
      .select()
      .from(locations)
      .where(and(eq(locations.instituteId, instituteId), eq(locations.isActive, true)))
      .orderBy(locations.title);
  }

  /** Active locations belonging to any of the given institutes. */
  async listByInstitutes(instituteIds: string[]): Promise<Location[]> {
    if (instituteIds.length === 0) return [];
    return db
      .select()
      .from(locations)
      .where(and(inArray(locations.instituteId, instituteIds), eq(locations.isActive, true)))
      .orderBy(locations.title);
  }

  /**
   * Active locations within `radiusMeters` of (lat, lng) belonging to any of the
   * given institutes. Uses a cheap bounding-box pre-filter in SQL, then refines
   * with the exact Haversine distance in JS. (No PostGIS dependency.)
   */
  async findNearby(
    instituteIds: string[],
    lat: number,
    lng: number,
    radiusMeters: number,
  ): Promise<Array<Location & { distanceM: number }>> {
    const candidates = await this.listByInstitutes(instituteIds);
    if (candidates.length === 0) return [];

    // 1 degree latitude ≈ 111_320 m; longitude scales by cos(lat).
    const latDelta = radiusMeters / 111_320;
    const lngDelta = radiusMeters / (111_320 * Math.max(0.01, Math.cos((lat * Math.PI) / 180)));

    return candidates
      .filter(
        (loc) =>
          Math.abs(loc.latitude - lat) <= latDelta &&
          Math.abs(loc.longitude - lng) <= lngDelta,
      )
      .map((loc) => ({
        ...loc,
        distanceM: haversineMeters({ latitude: lat, longitude: lng }, loc),
      }))
      .filter((loc) => loc.distanceM <= radiusMeters)
      .sort((a, b) => a.distanceM - b.distanceM);
  }

  // ---- Event ⇄ location join ----

  /** Location ids assigned to a single event. */
  async getLocationIdsForEvent(eventId: string): Promise<string[]> {
    const rows = await db
      .select({ locationId: calendarEventLocations.locationId })
      .from(calendarEventLocations)
      .where(eq(calendarEventLocations.eventId, eventId));
    return rows.map((r) => r.locationId);
  }

  /** Full location rows assigned to each of the given events. */
  async getLocationsForEvents(eventIds: string[]): Promise<Map<string, Location[]>> {
    const result = new Map<string, Location[]>();
    if (eventIds.length === 0) return result;

    const rows = await db
      .select({ eventId: calendarEventLocations.eventId, location: locations })
      .from(calendarEventLocations)
      .innerJoin(locations, eq(calendarEventLocations.locationId, locations.id))
      .where(inArray(calendarEventLocations.eventId, eventIds));

    for (const r of rows) {
      const list = result.get(r.eventId) || [];
      list.push(r.location);
      result.set(r.eventId, list);
    }
    return result;
  }

  /** Replace an event's location links with the desired set. */
  async setEventLocations(eventId: string, locationIds: string[]): Promise<void> {
    await db.delete(calendarEventLocations).where(eq(calendarEventLocations.eventId, eventId));
    const unique = [...new Set(locationIds)];
    if (unique.length === 0) return;
    await db
      .insert(calendarEventLocations)
      .values(unique.map((locationId) => ({ eventId, locationId })));
  }
}

export const locationRepository = new LocationRepository();
