/**
 * Board key building and resolution (P4).
 *
 * These keys are how the AI addresses pre-built boards, so three properties
 * matter: they are unique, they are STABLE across session reloads (the
 * Coordinator caches the loaded key), and a bare board name still resolves when
 * it is unambiguous.
 *
 * DB-free — pure logic, lives in the unit config.
 *
 * See planning-docs/aac-packages-plan.md §4.
 */

import { describe, it, expect } from '@jest/globals';
import { slug, buildBoardKeys, resolveBoardKey } from '@shared/board-keys';

const keysFor = (entries: Array<{ id: string; name: string; packageName?: string }>, reserved?: string[]) =>
  buildBoardKeys(entries, reserved);

describe('slug', () => {
  it('lowercases and joins on underscores', () => {
    expect(slug('Morning Routine')).toBe('morning_routine');
  });

  it('collapses runs of punctuation and trims the edges', () => {
    expect(slug('  Snack -- time!!  ')).toBe('snack_time');
  });

  it('NEVER emits a dot, so a name cannot forge the qualifier separator', () => {
    expect(slug('Mr. Fox')).toBe('mr_fox');
    expect(slug('a.b.c')).toBe('a_b_c');
  });

  it('caps length without leaving a trailing underscore', () => {
    const out = slug('x'.repeat(30) + ' ' + 'y'.repeat(30));
    expect(out.length).toBeLessThanOrEqual(40);
    expect(out.endsWith('_')).toBe(false);
  });

  it('survives a name with no usable characters', () => {
    expect(slug('!!!')).toBe('');
    expect(slug('')).toBe('');
  });
});

describe('buildBoardKeys', () => {
  it('uses a bare slug for the students own boards', () => {
    const keys = keysFor([{ id: 'a', name: 'Morning Routine' }]);
    expect(keys.get('a')).toBe('morning_routine');
  });

  it('qualifies package boards with the package slug', () => {
    const keys = keysFor([
      { id: 'a', name: 'Snack', packageName: 'Kindergarten Core' },
    ]);
    expect(keys.get('a')).toBe('kindergarten_core.snack');
  });

  it('suffixes collisions in input order', () => {
    const keys = keysFor([
      { id: 'a', name: 'Snack' },
      { id: 'b', name: 'snack' },
      { id: 'c', name: 'SNACK' },
    ]);
    expect(keys.get('a')).toBe('snack');
    expect(keys.get('b')).toBe('snack_2');
    expect(keys.get('c')).toBe('snack_3');
  });

  it('does not collide across DIFFERENT packages — the qualifier already separates them', () => {
    const keys = keysFor([
      { id: 'a', name: 'Snack', packageName: 'Kindergarten' },
      { id: 'b', name: 'Snack', packageName: 'Afternoon Club' },
    ]);
    expect(keys.get('a')).toBe('kindergarten.snack');
    expect(keys.get('b')).toBe('afternoon_club.snack');
  });

  it('reserves the home key so a board named "Home" cannot shadow it', () => {
    const keys = keysFor([{ id: 'a', name: 'Home' }], ['home']);
    expect(keys.get('a')).toBe('home_2');
  });

  it('is STABLE — the same input order gives the same keys every time', () => {
    const entries = [
      { id: 'a', name: 'Snack' },
      { id: 'b', name: 'Snack', packageName: 'Pack' },
      { id: 'c', name: 'snack' },
    ];
    expect([...keysFor(entries).entries()]).toEqual([...keysFor(entries).entries()]);
  });

  it('falls back to a usable key when a name slugs to nothing', () => {
    const keys = keysFor([{ id: 'a', name: '???' }, { id: 'b', name: '!!!' }]);
    expect(keys.get('a')).toBe('board');
    expect(keys.get('b')).toBe('board_2');
  });
});

describe('resolveBoardKey', () => {
  const keys = buildBoardKeys([
    { id: 'own', name: 'Morning Routine' },
    { id: 'k-snack', name: 'Snack', packageName: 'Kindergarten' },
    { id: 'a-snack', name: 'Snack', packageName: 'Afternoon Club' },
    { id: 'k-lunch', name: 'Lunch', packageName: 'Kindergarten' },
  ]);

  it('resolves an exact qualified key', () => {
    expect(resolveBoardKey('kindergarten.snack', keys)).toEqual({
      kind: 'found',
      id: 'k-snack',
      key: 'kindergarten.snack',
    });
  });

  it('resolves an unqualified board key when only one board has it', () => {
    expect(resolveBoardKey('lunch', keys)).toEqual({
      kind: 'found',
      id: 'k-lunch',
      key: 'kindergarten.lunch',
    });
  });

  it('reports AMBIGUOUS with the qualified alternatives, not a dead end', () => {
    const result = resolveBoardKey('snack', keys);
    expect(result.kind).toBe('ambiguous');
    if (result.kind !== 'ambiguous') throw new Error('expected ambiguous');
    expect(result.candidates.sort()).toEqual(['afternoon_club.snack', 'kindergarten.snack']);
  });

  it('resolves a student-owned board by its bare key', () => {
    expect(resolveBoardKey('morning_routine', keys)).toMatchObject({ kind: 'found', id: 'own' });
  });

  it('tolerates the display form the model might send back', () => {
    expect(resolveBoardKey('Kindergarten Core.Snack', buildBoardKeys([
      { id: 'x', name: 'Snack', packageName: 'Kindergarten Core' },
    ]))).toMatchObject({ kind: 'found', id: 'x' });
  });

  it('returns missing for an unknown key', () => {
    expect(resolveBoardKey('nope', keys)).toEqual({ kind: 'missing' });
    expect(resolveBoardKey('', keys)).toEqual({ kind: 'missing' });
  });

  it('does not match a qualified input against a different packages board', () => {
    expect(resolveBoardKey('afternoon_club.lunch', keys)).toEqual({ kind: 'missing' });
  });
});
