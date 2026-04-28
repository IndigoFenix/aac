/**
 * Jest Test Setup
 *
 * This file is run before each test file to set up the test environment.
 */

import { jest, beforeAll, afterAll } from '@jest/globals';
import dotenv from 'dotenv';

// Load .env so TEST_DATABASE_URL is visible inside test workers
// (jest workers don't auto-load it).
dotenv.config();

// Set test environment variables.
// global-setup.ts also sets these before any worker starts; this is the in-worker fallback
// for cases where setupFilesAfterEnv runs before the parent's env propagates.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  process.env.TEST_DATABASE_URL ??
  'postgresql://test:test@localhost:5432/test_db';

// Increase timeout for async operations
jest.setTimeout(30000);

// Mock console methods for cleaner test output (optional)
const originalConsoleLog = console.log;
const originalConsoleWarn = console.warn;
const originalConsoleError = console.error;

beforeAll(() => {
  // Suppress logs during tests unless DEBUG is set
  if (!process.env.DEBUG) {
    console.log = jest.fn();
    console.warn = jest.fn();
    // Keep error logs visible
    // console.error = jest.fn();
  }
});

afterAll(() => {
  // Restore console methods
  console.log = originalConsoleLog;
  console.warn = originalConsoleWarn;
  console.error = originalConsoleError;
});

// Global test utilities
declare global {
  var testUtils: {
    generateUUID: () => string;
    waitFor: (ms: number) => Promise<void>;
  };
}

globalThis.testUtils = {
  generateUUID: () => {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = Math.random() * 16 | 0;
      const v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  },
  waitFor: (ms: number) => new Promise(resolve => setTimeout(resolve, ms)),
};

export {};
