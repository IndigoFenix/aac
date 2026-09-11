// jest.config.engine.js — THE FAST HALF of the world-engine suite.
//
// Every test that exercises the world-engine (shared/world-engine/*) lives in
// server/tests/world-engine/. Those are PURE logic over WorldState — they never
// touch Postgres. `jest.config.engine-all.js` selects the whole folder and
// drops the DB globalSetup; THIS config removes the BOOT ARCS from it.
//
// ⏱️ WHY THE SPLIT (2026-09-09 efficiency round). A suite that calls
// `bootTextQuest` boots the real quest-host headless — ~60 s of wall time
// EACH, before a single assertion runs. On 2026-09-05 twenty-two such suites
// were 56 % of a 74-minute sweep; four days later there were thirty-six. They
// are now named `*.arc.test.ts` and live behind `npm run test:engine:arcs`, so
// the per-tweak run (`npm run test:engine -- <word>`) never pays for them.
// `server/tests/world-engine/arc-naming-guard.test.ts` keeps the drift from
// coming back.
//
// Run it with:  npm run test:engine              (the fast half)
//               npm run test:engine -- routing   (a slice — adds a pattern)
//               npm run test:engine:arcs         (the boot arcs)
//               npm run test:engine:all          (both, one process)

import all, { engineBase } from './jest.config.engine-all.js';

export default {
  ...all,
  testPathIgnorePatterns: [...(engineBase.testPathIgnorePatterns ?? []), '\\.arc\\.test\\.ts$'],
};
