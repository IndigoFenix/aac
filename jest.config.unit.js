// jest.config.unit.js — FAST, DB-FREE run of everything that isn't a DB/API
// integration test.
//
// The heavy, slow part of `npm test` is server/tests/integration/ (34 suites,
// Postgres-backed — student-erasure alone is ~100s) plus jest's one-time
// `globalSetup` (connect + Drizzle migrate). The rest — the world-engine folder,
// the board/agent/glyph/speech/prompt units, the mocked-LLM suites — are pure
// logic and never need the DB. This config inherits the base EXCEPT:
//   • globalSetup is dropped (no DB connection / migration);
//   • integration/ is ignored (run it with `npm run test:integration`).
//
// Run it with:  npm run test:unit            (all non-integration suites, DB-free)
//               npm run test:unit -- board   (a slice)
//
// If a suite here fails because it genuinely needs the DB, it belongs in
// integration/ — move it there rather than restoring globalSetup.

import base from './jest.config.js';

export default {
  ...base,
  globalSetup: undefined,
  testPathIgnorePatterns: [
    ...(base.testPathIgnorePatterns ?? []),
    '/server/tests/integration/',
  ],
};
