// jest.config.engine-arcs.js — THE BOOT ARCS of the world-engine suite.
//
// Only `server/tests/world-engine/**/*.arc.test.ts`: the suites that call
// `bootTextQuest` and drive the real quest-host headless. Each boot costs
// ~60 s of wall time before its first assertion, so they are a TIER of their
// own (CLAUDE.md, Testing): run them per-LANDING, not per-tweak.
//
//   npm run test:engine:arcs              all of them
//   npm run test:engine:arcs -- forage    one slice (single word — `a|b`
//                                         breaks on cmd.exe)
//
// A long play arc belongs in TEXT MODE (`npm run world:text`, or
// `scripts/dev/arc-run.ts` for a measured one), not here — a jest suite that
// value-imports quest-host also pays a heavy per-worker transform tax.

import all from './jest.config.engine-all.js';

export default {
  ...all,
  testRegex: 'server[\\\\/]tests[\\\\/]world-engine[\\\\/].*\\.arc\\.test\\.ts$',
};
