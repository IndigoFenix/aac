// jest.config.engine.js — FAST, DB-FREE runs for the world-engine tests.
//
// Every test that exercises the world-engine (shared/world-engine/*) lives in
// server/tests/world-engine/. Those are PURE logic over WorldState — they never
// touch Postgres. The default `npm test` still pays `jest.config.js`'s
// `globalSetup` (connect to the test DB + run Drizzle migrations) on every run,
// and shares the pool with the slow integration / http / crm / llm-mocked /
// memory-schema suites. This config inherits the base EXCEPT:
//   • globalSetup is dropped — no DB connection, so an engine run needs no test
//     DB, can't collide with a concurrent full run, and starts instantly;
//   • the file set is narrowed by testRegex to the world-engine/ folder.
//
// Run it with:  npm run test:engine            (all world-engine suites)
//               npm run test:engine -- routing (a slice — adds a pattern)

import base from './jest.config.js';

// Drop testMatch so testRegex is the sole selector (they are mutually exclusive).
const { testMatch: _drop, ...rest } = base;

export default {
  ...rest,
  globalSetup: undefined,
  testRegex: 'server[\\\\/]tests[\\\\/]world-engine[\\\\/].*\\.test\\.ts$',
};
