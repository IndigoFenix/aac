// jest.config.engine-all.js — EVERY world-engine suite, fast half + arcs.
//
// This is the file set `jest.config.engine.js` used to select on its own,
// before the arc split (2026-09-09 efficiency round). It stays as the ONE
// place the folder is named; the other two engine configs narrow it:
//
//   jest.config.engine.js       …minus `*.arc.test.ts`   → `npm run test:engine`
//   jest.config.engine-arcs.js  …only  `*.arc.test.ts`   → `npm run test:engine:arcs`
//   this file                    both                    → `npm run test:engine:all`
//
// Inherits `jest.config.js` EXCEPT globalSetup, which is dropped: world-engine
// suites are pure logic over WorldState and never touch Postgres, so a run
// needs no test DB, cannot collide with a concurrent full run, and starts
// instantly.

import base from './jest.config.js';

// Drop testMatch so testRegex is the sole selector (they are mutually exclusive).
const { testMatch: _drop, ...rest } = base;

export const engineBase = {
  ...rest,
  globalSetup: undefined,
};

export default {
  ...engineBase,
  testRegex: 'server[\\\\/]tests[\\\\/]world-engine[\\\\/].*\\.test\\.ts$',
};
