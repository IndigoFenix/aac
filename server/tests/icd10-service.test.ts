/**
 * Unit tests for the ICD-10 search service. Pure data lookup against the
 * curated seed; no DB needed.
 */

import { describe, it, expect } from '@jest/globals';
import {
  searchIcdCodes,
  getIcdCode,
} from '../services/insurance/icd10Service.js';

describe('searchIcdCodes', () => {
  it('returns the first N codes when query is empty', () => {
    const codes = searchIcdCodes({ q: '', limit: 5 });
    expect(codes).toHaveLength(5);
    expect(codes.every((c) => c.code && c.description)).toBe(true);
  });

  it('prefix-matches on the code field with priority', () => {
    const codes = searchIcdCodes({ q: 'F80' });
    expect(codes.length).toBeGreaterThan(0);
    // All F80.x codes should appear before any non-F80 substring matches.
    const firstNonF80 = codes.findIndex((c) => !c.code.toUpperCase().startsWith('F80'));
    if (firstNonF80 !== -1) {
      // Anything after the first non-F80 must also not be F80 (proves prefix block is contiguous at top).
      for (let i = firstNonF80; i < codes.length; i++) {
        expect(codes[i].code.toUpperCase().startsWith('F80')).toBe(false);
      }
    }
  });

  it('matches on the description field as a fallback', () => {
    const codes = searchIcdCodes({ q: 'rett' });
    expect(codes.find((c) => c.code === 'F84.2')).toBeDefined();
  });

  it('is case-insensitive', () => {
    const upper = searchIcdCodes({ q: 'AUTISM' });
    const lower = searchIcdCodes({ q: 'autism' });
    expect(upper.map((c) => c.code)).toEqual(lower.map((c) => c.code));
  });

  it('filters to a regime when one is supplied', () => {
    const all = searchIcdCodes({ q: '' });
    const usOnly = searchIcdCodes({ q: '', regime: 'us_cpt' });
    // Every us_cpt result must declare us_cpt; at least some entries exist.
    expect(usOnly.length).toBeGreaterThan(0);
    expect(usOnly.every((c) => c.regimes.includes('us_cpt'))).toBe(true);
    // Bogus regime returns empty.
    const bogus = searchIcdCodes({ q: '', regime: 'no_such_regime' });
    expect(bogus).toHaveLength(0);
    // Sanity: total all >= total us_cpt.
    expect(all.length).toBeGreaterThanOrEqual(usOnly.length);
  });

  it('respects the limit parameter', () => {
    expect(searchIcdCodes({ q: '', limit: 3 })).toHaveLength(3);
    expect(searchIcdCodes({ q: '', limit: 1 })).toHaveLength(1);
  });

  it('flags unspecified codes via the unspecified field', () => {
    const f809 = getIcdCode('F80.9');
    expect(f809).not.toBeNull();
    expect(f809!.unspecified).toBe(true);

    const f802 = getIcdCode('F80.2');
    expect(f802).not.toBeNull();
    expect(f802!.unspecified).toBe(false);
  });

  it('getIcdCode is case-insensitive and returns null for unknown codes', () => {
    expect(getIcdCode('f84.2')?.code).toBe('F84.2');
    expect(getIcdCode('Z99.99999')).toBeNull();
  });
});
