// Clinician-client unit tests (client/src).
//
// A sibling of jest.config.client.js, which roots client-aac/ + client-shared/
// and maps `@/` to client-aac/src. The clinician client uses the same `@/`
// alias for ITS OWN src, so the two cannot share one config — a second root
// would resolve every `@/` import to the wrong client. Everything else is the
// same preset for the same reasons (see the header there).
//
// Run with:  npm run test:client-app
//            npm run test:client-app -- rail-status      (single suite)
//
// SCOPE: `testEnvironment: 'node'` — pure modules only (the guided-setup
// decision functions, formatters, reducers). No DOM, no React rendering.

import { assertVmModules } from './jest.esm-guard.js';

assertVmModules();

/** @type {import('ts-jest').JestConfigWithTsJest} */
export default {
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  extensionsToTreatAsEsm: ['.ts', '.tsx'],
  moduleNameMapper: {
    '^@shared/(.*)\\.js$': '<rootDir>/shared/$1',
    '^@shared/(.*)$': '<rootDir>/shared/$1',
    '^@client-shared/(.*)\\.js$': '<rootDir>/client-shared/src/$1',
    '^@client-shared/(.*)$': '<rootDir>/client-shared/src/$1',
    '^@/(.*)$': '<rootDir>/client/src/$1',
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        useESM: true,
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
            '@client-shared/*': ['./client-shared/src/*'],
            '@/*': ['./client/src/*'],
          },
        },
      },
    ],
  },
  testMatch: ['<rootDir>/client/src/**/*.test.ts', '<rootDir>/client/src/**/*.test.tsx'],
  testPathIgnorePatterns: ['/node_modules/', '/dist/'],
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
  rootDir: '.',
  roots: ['<rootDir>/client'],
  testTimeout: 15000,
  verbose: true,
};
