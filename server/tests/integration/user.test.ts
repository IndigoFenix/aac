/**
 * User integration tests.
 *
 * Covers registration, login validation, and lookup paths used during
 * onboarding, OAuth, and profile updates.
 */

import { describe, it, expect, afterEach } from '@jest/globals';
import { truncateAll } from '../helpers/db.js';
import { userService, userRepository } from '../helpers/factories.js';

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
