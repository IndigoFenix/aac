// IMPORTANT — how to run these tests:
//   This config uses ts-jest's native-ESM preset (useESM + extensionsToTreatAsEsm),
//   which requires Node's `--experimental-vm-modules`. The npm scripts supply it by
//   invoking node directly:
//       node --experimental-vm-modules node_modules/jest/bin/jest.js
//   Do NOT reintroduce `cross-env NODE_OPTIONS='...'` — cross-env v8 dropped the
//   quote-rejoining that made a multi-flag value survive cmd.exe, and the failure
//   is SILENT (see jest.esm-guard.js for the full incident).
//
//   Running the binary directly (`npx jest <pattern>`) drops the flag and now aborts
//   on the guard below. Previously it failed confusingly instead, on the first file
//   in any chain that uses `import.meta` (e.g. providers/claude-structured.ts) or
//   top-level await — surfacing as "Cannot use 'import.meta' outside a module".
//   To run a single suite, go through the npm script:
//       npm test -- <pattern>            (e.g. npm test -- social-peer-speaker)

import { assertVmModules } from './jest.esm-guard.js';

assertVmModules();

/** @type {import('ts-jest').JestConfigWithTsJest} */
export default {
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  extensionsToTreatAsEsm: ['.ts'],
  moduleNameMapper: {
    // Match `@shared/foo.js` first so the trailing `.js` is stripped before
    // ts-jest looks the file up. Without this, source files that use ESM-
    // style `@shared/...js` imports fail to resolve under jest.
    '^@shared/(.*)\\.js$': '<rootDir>/shared/$1',
    '^@shared/(.*)$': '<rootDir>/shared/$1',
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        useESM: true,
        // Skip full cross-file type checking — transpile each file in
        // isolation. Cuts peak memory dramatically (the memory schema
        // types are deeply recursive). Real type errors are still caught
        // by `npm run check` (tsc) and the IDE.
        isolatedModules: true,
        diagnostics: false,
        tsconfig: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          esModuleInterop: true,
          allowSyntheticDefaultImports: true,
          strict: true,
          skipLibCheck: true,
          noEmit: true,
          target: 'ES2022',
          lib: ['ES2022'],
          types: ['node', 'jest'],
          paths: {
            '@shared/*': ['./shared/*'],
          },
        },
      },
    ],
  },
  testMatch: [
    '<rootDir>/server/tests/**/*.test.ts',
  ],
  // Real-LLM tests live in tests/llm/ — excluded from default `npm test` runs
  // because they cost money and require API keys. Run them via `npm run test:llm`.
  testPathIgnorePatterns: ['/node_modules/', '/dist/', '/server/tests/llm/'],
  setupFilesAfterEnv: ['<rootDir>/server/tests/setup.ts'],
  globalSetup: '<rootDir>/server/tests/global-setup.ts',
  testTimeout: 30000,
  verbose: true,
  // ⚠️ `detectOpenHandles` FORCES BAND MODE. @jest/core's `shouldRunInBand()`
  // returns true whenever it is set, so the configured workers are never used
  // and the whole sweep runs on ONE core — measured 2026-09-05 on the
  // `creature` slice: 280.8 s serial vs 154.4 s at `--maxWorkers=4`. It is a
  // DEBUGGING tool ("which handle kept the process alive"), not a run mode, so
  // it is opt-in now:
  //     JEST_OPEN_HANDLES=1 npm run test:engine -- <word>
  // `forceExit` stays beside it: it papers over exactly the handles this flag
  // would name, and un-papering them is its own round, not this one.
  detectOpenHandles: process.env.JEST_OPEN_HANDLES === '1',
  forceExit: true,
  // MEASURED on this 4-core box, 2026-09-09, the whole world-engine fast half
  // (356 suites) at three worker counts:
  //     3 workers → 671 s     4 → 536 s     6 → 522 s
  // 6 wins by 2.6 % — inside the noise, and it wants half again as much RAM on
  // a box that had 7.6 GB free. 4 is the default; raise it per-run with
  // `JEST_MAX_WORKERS=6 npm run test:engine` when the box is quiet.
  maxWorkers: process.env.JEST_MAX_WORKERS
    ? (/%$/.test(process.env.JEST_MAX_WORKERS)
        ? process.env.JEST_MAX_WORKERS
        : Number(process.env.JEST_MAX_WORKERS))
    : 4,
  // A boot-arc worker grew 1.0 → 2.5 GB across a long in-band run and its late
  // suites ran ~1.5× slower. Recycle a worker that balloons once its current
  // file is done; a respawn is a couple of seconds, a swapping box is minutes.
  workerIdleMemoryLimit: '2GB',
  collectCoverageFrom: [
    'server/services/memory-schema/**/*.ts',
    '!server/tests/**',
  ],
  coverageDirectory: 'coverage',
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
  rootDir: '.',
  roots: ['<rootDir>/server'],
};
