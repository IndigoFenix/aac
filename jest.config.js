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
