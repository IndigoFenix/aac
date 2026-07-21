// Client-side unit tests (client-aac + client).
//
// Separate from jest.config.js on purpose: the server config carries a
// globalSetup that provisions a test database and a setupFilesAfterEach that
// wires server fixtures. Client units need neither, and paying a DB spin-up to
// assert a pure function is both slow and a false dependency.
//
// Run with:  npm run test:client
//            npm run test:client -- platform      (single suite)
//
// Same ts-jest native-ESM preset as the server config — see the header of
// jest.config.js for why NODE_OPTIONS=--experimental-vm-modules is required.
//
// SCOPE: `testEnvironment: 'node'`, so these are for logic that does NOT touch
// the DOM — pure modules, reducers, formatters, capability matrices. Component
// tests would need jsdom + @testing-library; add a second project here if and
// when that's wanted, rather than making every unit pay for a DOM.

/** @type {import('ts-jest').JestConfigWithTsJest} */
export default {
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  extensionsToTreatAsEsm: ['.ts', '.tsx'],
  moduleNameMapper: {
    '^@shared/(.*)\\.js$': '<rootDir>/shared/$1',
    '^@shared/(.*)$': '<rootDir>/shared/$1',
    '^@/(.*)$': '<rootDir>/client-aac/src/$1',
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        useESM: true,
        // Transpile-only, matching the server config: real type errors are
        // caught by `npm run check` (tsc), not here.
        isolatedModules: true,
        diagnostics: false,
        tsconfig: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          esModuleInterop: true,
          allowSyntheticDefaultImports: true,
          jsx: 'react-jsx',
          strict: true,
          skipLibCheck: true,
          noEmit: true,
          target: 'ES2022',
          lib: ['ES2022', 'DOM'],
          types: ['node', 'jest'],
          paths: {
            '@shared/*': ['./shared/*'],
            '@/*': ['./client-aac/src/*'],
          },
        },
      },
    ],
  },
  testMatch: [
    '<rootDir>/client-aac/src/**/*.test.ts',
    '<rootDir>/client-aac/src/**/*.test.tsx',
  ],
  testPathIgnorePatterns: ['/node_modules/', '/dist/'],
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
  rootDir: '.',
  roots: ['<rootDir>/client-aac'],
  testTimeout: 15000,
  verbose: true,
};
