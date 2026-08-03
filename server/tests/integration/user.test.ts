/**
 * User integration tests.
 *
 * Covers registration, login validation, and lookup paths used during
 * onboarding, OAuth, and profile updates.
 */

import { describe, it, expect, afterEach, jest } from '@jest/globals';
import { eq } from 'drizzle-orm';
import { truncateAll, db } from '../helpers/db.js';
import { userService, userRepository, makeUser } from '../helpers/factories.js';
import { personRepository } from '../../repositories/personRepository.js';
import { s3Service } from '../../services/storage/s3-service.js';
import {
  users,
  biometricData,
  persons,
  personChatRooms,
  personChats,
  personChatRoomParticipants,
} from '@shared/schema';

describe('User integration', () => {
  afterEach(truncateAll);

  describe('registerUser', () => {
    it('creates a user, hashes the password (bcrypt), and stores defaults', async () => {
      const email = `register-${Date.now()}@test.local`;
      const { user, referralApplied } = await userService.registerUser({
        email,
        password: 'plaintext-secret',
        firstName: 'Reg',
        lastName: 'Tester',
        fullName: 'Reg Tester',
        userType: 'Caregiver',
      } as any);

      expect(user.id).toBeDefined();
      expect(user.email).toBe(email);
      expect(user.password).toBeTruthy();
      // bcrypt hashes start with $2a$ or $2b$ and are exactly 60 chars
      expect(user.password!.startsWith('$2')).toBe(true);
      expect(user.password!.length).toBe(60);
      expect(user.password).not.toBe('plaintext-secret');
      expect(user.chatMemory).toEqual({});
      expect(user.credits).toBeGreaterThan(0);
      expect(user.isAdmin).toBe(false);
      expect(user.isSystemAdmin).toBe(false);
      expect(referralApplied).toBe(false);
    });

    it('throws if the email is already registered', async () => {
      const email = `dup-${Date.now()}@test.local`;
      await userService.registerUser({
        email,
        password: 'pw',
        firstName: 'A',
        lastName: 'B',
        fullName: 'A B',
      } as any);

      await expect(
        userService.registerUser({
          email,
          password: 'pw2',
          firstName: 'C',
          lastName: 'D',
          fullName: 'C D',
        } as any),
      ).rejects.toThrow(/already exists/i);
    });
  });

  describe('validateLogin', () => {
    it('returns the user when password matches', async () => {
      const email = `login-${Date.now()}@test.local`;
      await userService.registerUser({
        email,
        password: 'correct-horse',
        firstName: 'L',
        lastName: 'T',
        fullName: 'L T',
      } as any);

      const result = await userService.validateLogin(email, 'correct-horse');
      expect(result).not.toBeNull();
      expect(result!.email).toBe(email);
    });

    it('returns null when password does not match', async () => {
      const email = `login2-${Date.now()}@test.local`;
      await userService.registerUser({
        email,
        password: 'right',
        firstName: 'L',
        lastName: 'T',
        fullName: 'L T',
      } as any);

      const result = await userService.validateLogin(email, 'wrong');
      expect(result).toBeNull();
    });

    it('returns null for a non-existent user', async () => {
      const result = await userService.validateLogin(
        'nobody@test.local',
        'whatever',
      );
      expect(result).toBeNull();
    });
  });

  describe('deleteUser', () => {
    it('removes the person facet: rooms they created survive creator-nulled; their messages and persons row go', async () => {
      const target = await makeUser();
      const other = await makeUser();
      const targetPerson = await personRepository.getOrCreateForUser(target.id);
      const otherPerson = await personRepository.getOrCreateForUser(other.id);

      // Room the target user created, with a message from each side.
      const [room] = await db.insert(personChatRooms).values({
        instituteId: 'inst-delete-user-test', isDirect: false, createdByPersonId: targetPerson.id,
      } as any).returning();
      await db.insert(personChatRoomParticipants).values([
        { roomId: room.id, personId: targetPerson.id },
        { roomId: room.id, personId: otherPerson.id },
      ] as any);
      await db.insert(personChats).values({
        roomId: room.id, senderPersonId: targetPerson.id, body: 'from target',
      } as any);
      const [otherMsg] = await db.insert(personChats).values({
        roomId: room.id, senderPersonId: otherPerson.id, body: 'from other',
      } as any).returning();

      const ok = await userRepository.deleteUser(target.id);
      expect(ok).toBe(true);

      // User + their persons row are gone.
      expect((await db.select().from(users).where(eq(users.id, target.id))).length).toBe(0);
      expect((await db.select().from(persons).where(eq(persons.id, targetPerson.id))).length).toBe(0);
      // The room survives with the creator nulled; only the other member remains.
      const [roomRow] = await db.select().from(personChatRooms).where(eq(personChatRooms.id, room.id));
      expect(roomRow).toBeDefined();
      expect(roomRow.createdByPersonId).toBeNull();
      const remaining = await db.select().from(personChatRoomParticipants)
        .where(eq(personChatRoomParticipants.roomId, room.id));
      expect(remaining.map((p) => p.personId)).toEqual([otherPerson.id]);
      // The target's message is gone; the other member's survives.
      const msgs = await db.select().from(personChats).where(eq(personChats.roomId, room.id));
      expect(msgs.map((m) => m.id)).toEqual([otherMsg.id]);
    });

    it('releases the biometric record and its face photo', async () => {
      // biometric_data is referenced, never referencing: once the user row goes,
      // nothing can reach their face embedding or photo again.
      const target = await makeUser();
      const [bio] = await db
        .insert(biometricData)
        .values({ faceImageUrl: 'biometric/deleted-user.jpg' } as any)
        .returning();
      await db.update(users).set({ biometricDataId: bio.id }).where(eq(users.id, target.id));

      const deleteSpy = jest.spyOn(s3Service, 'delete').mockResolvedValue(undefined);
      try {
        expect(await userRepository.deleteUser(target.id)).toBe(true);

        const [survivor] = await db.select().from(biometricData).where(eq(biometricData.id, bio.id));
        expect(survivor).toBeUndefined();
        expect(deleteSpy).toHaveBeenCalledWith('biometric/deleted-user.jpg');
      } finally {
        deleteSpy.mockRestore();
      }
    });
  });

  describe('createGoogleUser', () => {
    it('creates a user with googleId and no password', async () => {
      const email = `google-${Date.now()}@test.local`;
      const user = await userService.createGoogleUser({
        email,
        firstName: 'Goo',
        lastName: 'Gle',
        googleId: `goog-${Date.now()}`,
      });

      expect(user.id).toBeDefined();
      expect(user.email).toBe(email);
      expect(user.googleId).toBeTruthy();
      expect(user.password).toBeNull();
    });
  });

  describe('updateUserProfile', () => {
    it('updates first/last/full names', async () => {
      const { user } = await userService.registerUser({
        email: `profile-${Date.now()}@test.local`,
        password: 'pw',
        firstName: 'Old',
        lastName: 'Name',
        fullName: 'Old Name',
      } as any);

      const updated = await userService.updateUserProfile(user.id, 'New', 'Surname');
      expect(updated).toBeDefined();
      expect(updated!.firstName).toBe('New');
      expect(updated!.lastName).toBe('Surname');
      expect(updated!.fullName).toBe('New Surname');
    });
  });

  describe('getUserByEmail', () => {
    it('returns the user for a known email', async () => {
      const email = `lookup-${Date.now()}@test.local`;
      const { user } = await userService.registerUser({
        email,
        password: 'pw',
        firstName: 'L',
        lastName: 'U',
        fullName: 'L U',
      } as any);

      const found = await userService.getUserByEmail(email);
      expect(found).toBeDefined();
      expect(found!.id).toBe(user.id);
    });

    it('returns undefined for unknown email', async () => {
      const found = await userService.getUserByEmail('absent@test.local');
      expect(found).toBeUndefined();
    });
  });

  describe('updateUser admin flags', () => {
    it('promotes a user to admin via repository update', async () => {
      const { user } = await userService.registerUser({
        email: `admin-${Date.now()}@test.local`,
        password: 'pw',
        firstName: 'A',
        lastName: 'D',
        fullName: 'A D',
      } as any);
      expect(user.isAdmin).toBe(false);

      const updated = await userRepository.updateUser(user.id, {
        isAdmin: true,
      } as any);
      expect(updated!.isAdmin).toBe(true);
    });
  });
});
