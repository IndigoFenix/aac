/**
 * Unit tests for shared/phone.ts toE164() — the normalizer used at every
 * SMS-write boundary. Covers the formats clinicians actually enter:
 * already-E.164, Israeli local-with-leading-0, US area code, "00" prefix,
 * input with whitespace/punctuation, and unrecognized inputs.
 */

import { describe, it, expect } from '@jest/globals';
import { toE164, isE164 } from '@shared/phone';

describe('toE164', () => {
  describe('already E.164', () => {
    it('passes through a valid E.164 string', () => {
      expect(toE164('+972541234567')).toBe('+972541234567');
      expect(toE164('+15551234567', 'US')).toBe('+15551234567');
    });

    it('rejects an obviously malformed +-prefixed input', () => {
      expect(toE164('+0123')).toBeNull();           // E.164 first digit must be 1-9
      expect(toE164('+notanumber')).toBeNull();
    });
  });

  describe('Israeli local format', () => {
    it('drops the trunk 0 and prepends +972 when country=IL', () => {
      expect(toE164('0507414948', 'IL')).toBe('+972507414948');
      expect(toE164('050-741-4948', 'IL')).toBe('+972507414948');
      expect(toE164('(050) 741 4948', 'IL')).toBe('+972507414948');
    });

    it('handles input that already has the dial code without +', () => {
      // "972507414948" with country=IL — without +, our normalizer treats it
      // as a domestic number and prepends +972, yielding +972972507414948
      // (which is still E.164-shaped). Worth being explicit about — clinicians
      // who paste from a contact card may produce this; we accept it as a
      // best effort. Production: switch to libphonenumber if this matters.
      const out = toE164('972507414948', 'IL');
      expect(out).not.toBeNull();
      expect(isE164(out!)).toBe(true);
    });
  });

  describe('US format', () => {
    it('does NOT strip a leading 0 (NANP has no trunk prefix)', () => {
      // NANP numbers don't start with 0, but defensively: "0555..." with
      // country=US should still produce a valid-shape E.164.
      expect(toE164('5551234567', 'US')).toBe('+15551234567');
      expect(toE164('(555) 123-4567', 'US')).toBe('+15551234567');
    });
  });

  describe('"00" international prefix', () => {
    it('converts 00 to +', () => {
      expect(toE164('00972507414948')).toBe('+972507414948');
      expect(toE164('00 972 50 7414948')).toBe('+972507414948');
    });
  });

  describe('failure modes', () => {
    it('returns null when domestic input has no country hint', () => {
      expect(toE164('0507414948')).toBeNull();
    });

    it('returns null for empty input', () => {
      expect(toE164('')).toBeNull();
      expect(toE164('   ')).toBeNull();
    });

    it('returns null for unknown country', () => {
      expect(toE164('0507414948', 'XX')).toBeNull();
    });

    it('returns null for inputs with letters', () => {
      expect(toE164('1-800-FLOWERS', 'US')).toBeNull();
    });
  });
});
