// IMPORTANT — how to run these tests:
//   This config uses ts-jest's native-ESM preset (useESM + extensionsToTreatAsEsm).
//   Jest's ESM support requires Node's `--experimental-vm-modules` flag, which the
//   `npm test` script sets via NODE_OPTIONS. Running the binary directly
//   (`npx jest <pattern>`) WITHOUT that flag fails confusingly on the first file
//   in any chain that uses `import.meta` (e.g. providers/claude-structured.ts) or
//   imports a `.tsx` (e.g. shared/social-bot/ProceduralFace.tsx) — surfacing as
//   "Cannot use 'import.meta' outside a module" or "Unexpected token '<'". These
//   are NOT broken tests; the transform just isn't applied without ESM mode.
//   To run a single suite, go through the npm script so the flag is set:
//       npm test -- <pattern>            (e.g. npm test -- social-peer-speaker)
//   or set it yourself:  NODE_OPTIONS=--experimental-vm-modules npx jest <pattern>

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
  detectOpenHandles: true,
  forceExit: true,
  collectCoverageFrom: [
    'server/services/memory-schema/**/*.ts',
    '!server/tests/**',
  ],
  coverageDirectory: 'coverage',
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
  rootDir: '.',
  roots: ['<rootDir>/server'],
};
