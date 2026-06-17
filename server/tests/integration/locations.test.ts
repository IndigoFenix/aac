/**
 * Locations integration tests (real DB).
 *
 * Covers institute-scoped CRUD access rules, the calendar event ↔ location
 * association sync, and the bounding-box + Haversine `findNearby` query.
 */

import { describe, it, expect, afterEach, beforeEach } from '@jest/globals';
import { truncateAll } from '../helpers/db.js';
import { makeUser, makeInstitute } from '../helpers/factories.js';
import { locationService } from '../../services/locationService.js';
import { locationRepository, calendarRepository } from '../../repositories/index.js';

describe('Locations', () => {
  afterEach(truncateAll);

  let adminId: string;
  let outsiderId: string;
  let instituteId: string;

  beforeEach(async () => {
    const admin = await makeUser();
    const outsider = await makeUser();
    const { institute } = await makeInstitute(admin.id);
    adminId = admin.id;
    outsiderId = outsider.id;
    instituteId = institute.id;
  });

  describe('CRUD + access scoping', () => {
    it('lets an institute member create and list a location', async () => {
      const created = await locationService.create(
        { instituteId, title: 'Main Clinic', address: '1 Health St', latitude: 32.0853, longitude: 34.7818 },
        adminId,
      );
      expect(created).not.toBeNull();
      expect(created!.title).toBe('Main Clinic');

      const list = await locationService.listForInstitute(instituteId, adminId);
      expect(list).toHaveLength(1);
    });

    it('denies a non-member from creating or listing', async () => {
      const created = await locationService.create(
        { instituteId, title: 'X', latitude: 1, longitude: 2 },
        outsiderId,
      );
      expect(created).toBeNull();
      expect(await locationService.listForInstitute(instituteId, outsiderId)).toBeNull();
    });

    it('soft-deletes (deactivates) a location so it drops out of the active list', async () => {
      const created = await locationService.create(
        { instituteId, title: 'Temp', latitude: 1, longitude: 2 },
        adminId,
      );
      expect(await locationService.remove(created!.id, adminId)).toBe(true);
      const list = await locationService.listForInstitute(instituteId, adminId);
      expect(list).toHaveLength(0);
    });

    it('denies a non-member from editing', async () => {
      const created = await locationService.create(
        { instituteId, title: 'Y', latitude: 1, longitude: 2 },
        adminId,
      );
      const updated = await locationService.update(created!.id, { title: 'Hacked' }, outsiderId);
      expect(updated).toBeNull();
    });
  });

  describe('event ↔ location association', () => {
    it('syncs an event\'s locations and reads them back', async () => {
      const a = await locationService.create({ instituteId, title: 'A', latitude: 1, longitude: 1 }, adminId);
      const b = await locationService.create({ instituteId, title: 'B', latitude: 2, longitude: 2 }, adminId);

      const event = await calendarRepository.createEvent(
        {
          title: 'Therapy',
          startTime: new Date('2026-06-17T10:00:00Z'),
          endTime: new Date('2026-06-17T11:00:00Z'),
          instituteId,
        } as any,
        adminId,
      );

      await locationRepository.setEventLocations(event.id, [a!.id, b!.id, a!.id /* dup ignored */]);
      const ids = await locationRepository.getLocationIdsForEvent(event.id);
      expect(ids.sort()).toEqual([a!.id, b!.id].sort());

      // Re-sync to a single location replaces the set.
      await locationRepository.setEventLocations(event.id, [b!.id]);
      expect(await locationRepository.getLocationIdsForEvent(event.id)).toEqual([b!.id]);

      const byEvent = await locationRepository.getLocationsForEvents([event.id]);
      expect(byEvent.get(event.id)?.map((l) => l.title)).toEqual(['B']);
    });
  });

  describe('findNearby', () => {
    it('returns only locations within the radius, sorted by distance', async () => {
      // ~50m north and ~500m north of the same base point.
      const base = { lat: 32.0853, lng: 34.7818 };
      const close = await locationService.create(
        { instituteId, title: 'Close', latitude: base.lat + 50 / 111_320, longitude: base.lng },
        adminId,
      );
      await locationService.create(
        { instituteId, title: 'Far', latitude: base.lat + 500 / 111_320, longitude: base.lng },
        adminId,
      );

      const nearby = await locationRepository.findNearby([instituteId], base.lat, base.lng, 150);
      expect(nearby.map((l) => l.title)).toEqual(['Close']);
      expect(nearby[0].id).toBe(close!.id);
      expect(nearby[0].distanceM).toBeLessThan(150);
    });

    it('ignores locations of institutes not in the list', async () => {
      await locationService.create({ instituteId, title: 'Here', latitude: 10, longitude: 10 }, adminId);
      const nearby = await locationRepository.findNearby(['some-other-institute'], 10, 10, 150);
      expect(nearby).toHaveLength(0);
    });
  });
});
