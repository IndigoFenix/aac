// server/repositories/venueRepository.ts
//
// Data access for Location Menus: the shared venue/menu cache (non-PHI) and the
// per-student association (PHI).
//
// The split matters and is enforced by which table a method touches:
//   venues / venue_menus  — public facts, global cache, no student anywhere
//   student_venues        — which child eats where, always studentId-scoped
//
// See planning-docs/aac-restaurant-menus.md §4.4.

import {
  venues,
  venueMenus,
  studentVenues,
  type Venue,
  type InsertVenue,
  type VenueMenu,
  type InsertVenueMenu,
  type StudentVenue,
  type InsertStudentVenue,
} from "@shared/schema";
import { db } from "../db";
import { eq, and, desc, sql } from "drizzle-orm";
import { haversineMeters, type GeoPoint } from "@shared/location-matching";

/** A venue with its distance from the point that was searched. */
export interface NearbyVenue {
  venue: Venue;
  distanceM: number;
}

export class VenueRepository {
  // ── venues (non-PHI, shared) ────────────────────────────────────────────

  /**
   * Insert or refresh a venue from a POI provider.
   *
   * Upsert on (source, sourceId) rather than insert: two students near the same
   * restaurant must converge on ONE row, or `student_venues` fragments and the
   * global menu cache stops being global.
   */
  async upsert(data: InsertVenue): Promise<Venue> {
    const [row] = await db
      .insert(venues)
      .values(data)
      .onConflictDoUpdate({
        target: [venues.source, venues.sourceId],
        set: {
          name: data.name,
          latitude: data.latitude,
          longitude: data.longitude,
          address: data.address ?? null,
          venueType: data.venueType ?? null,
          cuisine: data.cuisine ?? null,
          websiteUri: data.websiteUri ?? null,
          countryCode: data.countryCode ?? null,
          brandKey: data.brandKey ?? null,
          lastSeenAt: new Date(),
          updatedAt: new Date(),
        },
      })
      .returning();
    return row;
  }

  async getById(id: string): Promise<Venue | undefined> {
    const [row] = await db.select().from(venues).where(eq(venues.id, id));
    return row || undefined;
  }

  /**
   * Venues within `radiusM` of a point, nearest first.
   *
   * A bounding box narrows the scan in SQL, then haversine gives the true
   * distance — a box alone over-selects at the corners, and at food-court
   * distances that difference decides which restaurant we think you are in.
   */
  async findNearby(point: GeoPoint, radiusM: number): Promise<NearbyVenue[]> {
    // Degrees of latitude are ~111km everywhere; longitude shrinks with
    // latitude, so the lon delta is widened by 1/cos(lat).
    const latDelta = radiusM / 111_320;
    const cosLat = Math.max(0.01, Math.cos((point.latitude * Math.PI) / 180));
    const lonDelta = latDelta / cosLat;

    const rows = await db
      .select()
      .from(venues)
      .where(
        and(
          sql`${venues.latitude} BETWEEN ${point.latitude - latDelta} AND ${point.latitude + latDelta}`,
          sql`${venues.longitude} BETWEEN ${point.longitude - lonDelta} AND ${point.longitude + lonDelta}`,
        ),
      );

    return rows
      .map((venue) => ({ venue, distanceM: haversineMeters(point, venue) }))
      .filter((r) => r.distanceM <= radiusM)
      .sort((a, b) => a.distanceM - b.distanceM);
  }

  /** Other venues sharing a brand — how a chain menu is detected (§4.9). */
  async countByBrand(brandKey: string): Promise<number> {
    const rows = await db
      .select({ id: venues.id })
      .from(venues)
      .where(eq(venues.brandKey, brandKey));
    return rows.length;
  }

  // ── venue_menus (non-PHI, shared) ───────────────────────────────────────

  /**
   * Raw insert. NOT the way to cache a menu.
   *
   * Every menu must go through `cacheMenu()` in
   * services/venue-menus/menu-cache.ts, which runs the refinement pass (§4.2a)
   * and the review escalation before writing. Calling this directly puts
   * unrefined items into a cache every student reads from, and bypasses the
   * rules that keep a chain-level guess away from a child.
   */
  async createMenu(data: InsertVenueMenu): Promise<VenueMenu> {
    const [row] = await db.insert(venueMenus).values(data).returning();
    return row;
  }

  async getMenuById(id: string): Promise<VenueMenu | undefined> {
    const [row] = await db.select().from(venueMenus).where(eq(venueMenus.id, id));
    return row || undefined;
  }

  /**
   * The menu a session should actually use: newest APPROVED menu for a venue.
   *
   * Approved-only by design. A `pending_review` menu exists but has not been
   * seen by a caretaker, and handing an unreviewed menu to a student is the
   * thing review is for. Callers wanting the pending one ask for it explicitly.
   */
  async getActiveMenu(venueId: string): Promise<VenueMenu | undefined> {
    const [row] = await db
      .select()
      .from(venueMenus)
      .where(and(eq(venueMenus.venueId, venueId), eq(venueMenus.status, "approved")))
      .orderBy(desc(venueMenus.extractedAt))
      .limit(1);
    return row || undefined;
  }

  /** Everything for a venue, newest first — the review queue's read. */
  async listMenus(venueId: string): Promise<VenueMenu[]> {
    return db
      .select()
      .from(venueMenus)
      .where(eq(venueMenus.venueId, venueId))
      .orderBy(desc(venueMenus.extractedAt));
  }

  /**
   * Record a caretaker's decision. `reviewedByUserId` is set HERE and is not
   * accepted from a caller — who approved a menu is an audit fact, and a
   * request body must never get to claim it.
   */
  async setMenuStatus(
    id: string,
    status: "approved" | "rejected",
    reviewedByUserId: string,
  ): Promise<VenueMenu | undefined> {
    const [row] = await db
      .update(venueMenus)
      .set({ status, reviewedByUserId, reviewedAt: new Date(), updatedAt: new Date() })
      .where(eq(venueMenus.id, id))
      .returning();
    return row || undefined;
  }

  /** Replace a menu's items — the caretaker's corrections in the review UI. */
  async updateMenuItems(id: string, items: unknown[]): Promise<VenueMenu | undefined> {
    const [row] = await db
      .update(venueMenus)
      .set({ items, updatedAt: new Date() })
      .where(eq(venueMenus.id, id))
      .returning();
    return row || undefined;
  }

  // ── student_venues (PHI) ────────────────────────────────────────────────

  /**
   * Link a student to a venue, or refresh the existing link.
   *
   * EVERY method below takes studentId and filters on it. That is not
   * defensive style — it is the access boundary for this table.
   */
  async linkStudent(data: InsertStudentVenue): Promise<StudentVenue> {
    const [row] = await db
      .insert(studentVenues)
      .values(data)
      .onConflictDoUpdate({
        target: [studentVenues.studentId, studentVenues.venueId],
        set: {
          ...(data.boardId !== undefined ? { boardId: data.boardId } : {}),
          ...(data.label !== undefined ? { label: data.label } : {}),
          ...(data.isFavorite !== undefined ? { isFavorite: data.isFavorite } : {}),
          lastVisitedAt: new Date(),
          updatedAt: new Date(),
        },
      })
      .returning();
    return row;
  }

  /**
   * Menus awaiting review across every venue this student is linked to — the
   * caretaker review queue.
   *
   * Joins through `student_venues`, so it can only ever surface menus for
   * venues THIS student has been linked to. That join is the access boundary:
   * the menus table itself is global, and a query without it would show a
   * caretaker every pending menu in the system.
   */
  async listPendingForStudent(
    studentId: string,
  ): Promise<Array<{ menu: VenueMenu; venue: Venue }>> {
    const rows = await db
      .select({ menu: venueMenus, venue: venues })
      .from(studentVenues)
      .innerJoin(venues, eq(venues.id, studentVenues.venueId))
      .innerJoin(venueMenus, eq(venueMenus.venueId, venues.id))
      .where(
        and(
          eq(studentVenues.studentId, studentId),
          eq(venueMenus.status, "pending_review"),
        ),
      )
      .orderBy(desc(venueMenus.extractedAt));
    return rows;
  }

  async listForStudent(studentId: string): Promise<StudentVenue[]> {
    return db
      .select()
      .from(studentVenues)
      .where(eq(studentVenues.studentId, studentId))
      .orderBy(desc(studentVenues.lastVisitedAt));
  }

  async getStudentVenue(studentId: string, venueId: string): Promise<StudentVenue | undefined> {
    const [row] = await db
      .select()
      .from(studentVenues)
      .where(and(eq(studentVenues.studentId, studentId), eq(studentVenues.venueId, venueId)));
    return row || undefined;
  }

  async unlinkStudent(studentId: string, venueId: string): Promise<boolean> {
    const rows = await db
      .delete(studentVenues)
      .where(and(eq(studentVenues.studentId, studentId), eq(studentVenues.venueId, venueId)))
      .returning();
    return rows.length > 0;
  }
}

export const venueRepository = new VenueRepository();
