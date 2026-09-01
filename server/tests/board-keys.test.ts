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
    expect(slug('🌽🌽')).toBe('');
  });
});

/**
 * The ASCII-only class this used to use erased every non-Latin name, so on a
 * Hebrew deployment EVERY board slugged to '' and keyed as board / board_2 /
 * board_3. The AI then could not name the board a child had asked for out
 * loud. Prod incident 2026-08-31, session 426dba70 — see the regression at the
 * bottom of this file.
 */
describe('slug — non-Latin scripts', () => {
  it('keeps a Hebrew name addressable instead of erasing it', () => {
    expect(slug('תירס חם - סיפור אינטראקטיבי')).toBe('תירס_חם_סיפור_אינטראקטיבי');
    expect(slug('הנסיך הקטן')).toBe('הנסיך_הקטן');
  });

  it('gives DISTINCT keys to distinct Hebrew names', () => {
    const names = ['תירס חם', 'הנסיך הקטן', 'האריה שאהב תות', 'ארוחת בוקר'];
    expect(new Set(names.map(slug)).size).toBe(names.length);
  });

  it('handles the other scripts the app ships locales for', () => {
    expect(slug('مرحبا بالعالم')).toBe('مرحبا_بالعالم');
    expect(slug('Ёлка')).toBe('елка');
  });

  it('folds diacritics rather than truncating at them', () => {
    // The ASCII class turned "Café" into "caf" and "İstanbul" into "stanbul".
    expect(slug('Café')).toBe('cafe');
    expect(slug('İstanbul')).toBe('istanbul');
  });

  it('folds niqqud, so a מנוקד title and its plain spelling share a key', () => {
    expect(slug('שָׁלוֹם עוֹלָם')).toBe(slug('שלום עולם'));
  });

  it('KEEPS kana voicing marks — dakuten changes the letter, it does not decorate it', () => {
    // Stripping these would key a Japanese board to a misspelling of itself
    // (ボード → ホート).
    expect(slug('日本語のボード名です')).toBe('日本語のボード名です');
  });

  it('still never emits a dot, whatever the script', () => {
    for (const name of ['תירס.חם', 'مرحبا.بالعالم', 'ボード.名', 'Mr. Fox']) {
      expect(slug(name)).not.toContain('.');
    }
  });

  it('caps by CODE POINT, so it cannot leave half a surrogate pair', () => {
    const out = slug('𐐨'.repeat(60));
    expect(Array.from(out).length).toBeLessThanOrEqual(40);
    expect(out).toBe(Array.from(out).join(''));
  });

  it('is IDEMPOTENT — resolveBoardKey re-slugs a key this function produced', () => {
    for (const name of [
      'תירס חם - סיפור אינטראקטיבי', 'Morning Routine', '  Snack -- time!!  ',
      'Café', 'İstanbul', 'مرحبا بالعالم', '日本語のボード名です', 'שָׁלוֹם עוֹלָם',
      'x'.repeat(60), '!!!', '',
    ]) {
      expect(slug(slug(name))).toBe(slug(name));
    }
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

/**
 * PROD REGRESSION — chat_sessions 426dba70…, student עופר, 2026-08-31.
 *
 * The child asked for the book "תירס חם" out loud, by name. The board existed,
 * was auto-selectable, and its author hint was the exact words he used — but
 * every Hebrew board on his device keyed as `package.board_N`, so the AI told
 * him it was not available. These are his real seven boards, in repository
 * order.
 */
describe('a Hebrew student device (prod regression)', () => {
  const entries = [
    { id: 'bank', name: 'Bank Teller' },
    { id: 'family', name: 'Family & Household' },
    { id: 'prince', name: 'הנסיך הקטן' },
    { id: 'pluto', name: 'איה פלוטו - בית דיבר', packageName: 'ספרי ילדים' },
    { id: 'lion', name: 'האריה שאהב תות', packageName: 'ספרי ילדים' },
    { id: 'corn', name: 'תירס חם - סיפור אינטראקטיבי', packageName: 'ספרי ילדים' },
    { id: 'icecream', name: 'Ice Cream Vendor', packageName: 'פעילויות' },
  ];
  const keys = buildBoardKeys(entries, ['home']);

  it('gives every board a key that names it, not board_N', () => {
    expect(keys.get('corn')).toBe('ספרי_ילדים.תירס_חם_סיפור_אינטראקטיבי');
    expect([...keys.values()].filter(k => /(^|\.)board(_\d+)?$/.test(k))).toEqual([]);
  });

  it('gives all seven distinct keys', () => {
    expect(new Set(keys.values()).size).toBe(entries.length);
  });

  it('resolves the book the child actually asked for', () => {
    for (const asked of [
      'ספרי_ילדים.תירס_חם_סיפור_אינטראקטיבי', // the key, copied exactly
      'תירס_חם_סיפור_אינטראקטיבי',            // the bare board segment
      'תירס חם - סיפור אינטראקטיבי',           // the display name
      'ספרי ילדים.תירס חם - סיפור אינטראקטיבי', // both display names
    ]) {
      expect(resolveBoardKey(asked, keys)).toMatchObject({ kind: 'found', id: 'corn' });
    }
  });

  it('does not confuse the two Hebrew packages with each other', () => {
    expect(keys.get('icecream')).toBe('פעילויות.ice_cream_vendor');
    expect(resolveBoardKey('ice_cream_vendor', keys)).toMatchObject({ kind: 'found', id: 'icecream' });
  });
});
