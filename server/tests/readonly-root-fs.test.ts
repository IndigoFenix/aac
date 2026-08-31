/**
 * The ECS task can run with `readonlyRootFilesystem = true`
 * (terraform/ecs.tf, var.ecs_readonly_root_fs). Under that flag the container
 * image is immutable at runtime and `/tmp` — a Fargate ephemeral volume — is
 * the ONLY writable path. Two classes of bug turn that flag from hardening
 * into an outage:
 *
 *   1. a debug-log writer that still opens a file next to the server bundle;
 *   2. a writer that is gated, but whose write is not exception-safe, so the
 *      day a gate is misconfigured an EROFS reaches a request handler.
 *
 * This suite is a SOURCE PIN. It reads the writers' source rather than
 * exercising them, because the failure mode is "someone adds a new
 * fs.appendFileSync in six months" and no behavioural test of today's code
 * catches that. It also pins the predicate itself and the no-throw contract.
 *
 * DB-free — runs under `npm run test:unit -- readonly`.
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import os from 'os';

import {
  fileDebugLogEnabled,
  safeAppend,
  safeTruncate,
  resetDebugFileState,
} from '../services/file-debug-log.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.resolve(HERE, '..');

function source(relative: string): string {
  return fs.readFileSync(path.join(SERVER_DIR, relative), 'utf-8');
}

// ---------------------------------------------------------------------------
// The writers, and how each one is allowed to be safe.
// ---------------------------------------------------------------------------

/**
 * Every module that opens a file under the APP DIRECTORY at runtime. Each must
 * consult a production gate before writing. `gate` is the token that must
 * appear in the source; `sharedHelper` says whether it must import the shared
 * predicate (the default) or is allowed its own documented env switch.
 */
const APP_DIR_WRITERS: Array<{ file: string; gate: string; sharedHelper: boolean }> = [
  { file: 'services/caption-debug-log.ts', gate: 'fileDebugLoggingEnabled', sharedHelper: true },
  { file: 'services/chat/memory-debug-log.ts', gate: 'fileDebugLoggingEnabled', sharedHelper: true },
  { file: 'services/dual-agent/agent-flow-logger.ts', gate: 'fileDebugLoggingEnabled', sharedHelper: true },
  { file: 'services/dual-agent/dual-agent-logger.ts', gate: 'fileDebugLoggingEnabled', sharedHelper: true },
  { file: 'services/deepAnalysisService.ts', gate: 'fileDebugLoggingEnabled', sharedHelper: true },
  { file: 'services/sessionSummary.ts', gate: 'fileDebugLoggingEnabled', sharedHelper: true },
  { file: 'services/memory-schema/quest-game-log.ts', gate: 'fileDebugLoggingEnabled', sharedHelper: true },
  { file: 'services/symbol/auto-symbol-service.ts', gate: 'fileDebugLoggingEnabled', sharedHelper: true },
  { file: 'services/aac-sim/trace.ts', gate: 'fileDebugLogEnabled', sharedHelper: true },
  // Owned by another workstream; gated on its own env switch by design.
  { file: 'services/providers/claude-structured.ts', gate: 'CLAUDE_CACHE_DEBUG', sharedHelper: false },
];

describe('read-only root filesystem: app-directory writers', () => {
  it.each(APP_DIR_WRITERS)('$file is gated on $gate', ({ file, gate }) => {
    expect(source(file)).toContain(gate);
  });

  it.each(APP_DIR_WRITERS.filter((w) => w.sharedHelper))(
    '$file routes through the shared file-debug-log helper',
    ({ file }) => {
      expect(source(file)).toMatch(/from ["'][^"']*file-debug-log(\.js)?["']/);
    },
  );

  it.each(APP_DIR_WRITERS.filter((w) => w.sharedHelper))(
    '$file writes only through safeAppend / safeTruncate, never raw fs',
    ({ file }) => {
      const src = source(file);
      // Raw appends/writes are what throw EROFS. Reads (existsSync, statSync)
      // are fine on a read-only mount and are deliberately not restricted.
      expect(src).not.toMatch(/\bfs\.appendFileSync\s*\(/);
      expect(src).not.toMatch(/\bfs\.writeFileSync\s*\(/);
      expect(src).not.toMatch(/\bfs\.createWriteStream\s*\(/);
    },
  );

  it('claude-structured.ts establishes its gate before it appends', () => {
    // Not ours to edit — pin only. The env read must come first in the file, so
    // no append can be reached without it.
    const src = source('services/providers/claude-structured.ts');
    const gateAt = src.indexOf('CLAUDE_CACHE_DEBUG');
    const appendAt = src.indexOf('appendFileSync');
    expect(gateAt).toBeGreaterThanOrEqual(0);
    expect(appendAt).toBeGreaterThanOrEqual(0);
    expect(gateAt).toBeLessThan(appendAt);
  });

  it('quest-game-log actually CONSULTS the predicate, not just imports it', () => {
    // The regression this pins: the file imported `fileDebugLoggingEnabled` and
    // never read it, so it was the one app-dir writer still running in prod.
    const src = source('services/memory-schema/quest-game-log.ts');
    expect(src).toMatch(/if\s*\(\s*!fileDebugLoggingEnabled\s*\)\s*return/);
  });
});

// ---------------------------------------------------------------------------
// /tmp is the only writable path — confirm the one runtime writer uses it.
// ---------------------------------------------------------------------------

describe('read-only root filesystem: runtime scratch space', () => {
  it('the video frame extractor writes under os.tmpdir(), i.e. the /tmp volume', () => {
    const src = source('services/chat/tools/video-frame-extractor.ts');
    expect(src).toMatch(/from ["']os["']/);
    expect(src).toMatch(/mkdtemp\(\s*path\.join\(\s*tmpdir\(\)/);
  });

  it('os.tmpdir() is what the ECS task mounts as the writable volume', () => {
    // Sanity anchor for the Terraform side: the container mounts the `tmp`
    // volume at /tmp, so os.tmpdir() must not have been overridden to a path
    // inside the app directory.
    expect(os.tmpdir()).toBeTruthy();
    expect(os.tmpdir()).not.toContain('node_modules');
  });

  it('no server module streams a trace to disk without an explicit opt-in', () => {
    // aac-sim/trace.ts CAN write, but only when a caller invokes openFile, and
    // the only caller is the dev script scripts/aac-sim-play.ts. The server-side
    // runner must not call it.
    const runner = source('services/aac-sim/runner.ts');
    expect(runner).not.toContain('openFile');
    expect(source('services/aac-sim/trace.ts')).toMatch(
      /openFile[\s\S]{0,400}if\s*\(\s*!fileDebugLogEnabled\(\)\s*\)/,
    );
  });
});

// ---------------------------------------------------------------------------
// The predicate.
// ---------------------------------------------------------------------------

describe('fileDebugLogEnabled', () => {
  const saved = { ...process.env };

  beforeEach(() => {
    delete process.env.DEBUG_FILE_LOGS;
    delete process.env.AWS_LAMBDA_EXEC_WRAPPER;
  });

  afterEach(() => {
    process.env = { ...saved };
  });

  it('is FALSE in production with no override — the whole point', () => {
    process.env.NODE_ENV = 'production';
    expect(fileDebugLogEnabled()).toBe(false);
  });

  it('is false on Lambda even outside production', () => {
    process.env.NODE_ENV = 'development';
    process.env.AWS_LAMBDA_EXEC_WRAPPER = '/opt/bootstrap';
    expect(fileDebugLogEnabled()).toBe(false);
  });

  it('is false under NODE_ENV=test so jest runs leave no PHI log behind', () => {
    process.env.NODE_ENV = 'test';
    expect(fileDebugLogEnabled()).toBe(false);
  });

  it('is true in development', () => {
    process.env.NODE_ENV = 'development';
    expect(fileDebugLogEnabled()).toBe(true);
  });

  it('DEBUG_FILE_LOGS=true is the only thing that overrides production', () => {
    process.env.NODE_ENV = 'production';
    process.env.DEBUG_FILE_LOGS = 'true';
    expect(fileDebugLogEnabled()).toBe(true);
  });

  it('a non-"true" DEBUG_FILE_LOGS value does not open the gate', () => {
    process.env.NODE_ENV = 'production';
    process.env.DEBUG_FILE_LOGS = '1';
    expect(fileDebugLogEnabled()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The no-throw contract. This is what makes a leaked gate survivable.
// ---------------------------------------------------------------------------

describe('safeAppend / safeTruncate under a read-only filesystem', () => {
  const realAppend = fs.appendFileSync;
  const realWrite = fs.writeFileSync;

  function erofs(): NodeJS.ErrnoException {
    const err: NodeJS.ErrnoException = new Error("EROFS: read-only file system, open '/app/x.log'");
    err.code = 'EROFS';
    return err;
  }

  beforeEach(() => {
    resetDebugFileState();
  });

  afterEach(() => {
    (fs as unknown as Record<string, unknown>).appendFileSync = realAppend;
    (fs as unknown as Record<string, unknown>).writeFileSync = realWrite;
    resetDebugFileState();
  });

  it('swallows EROFS instead of throwing into the caller', () => {
    (fs as unknown as Record<string, unknown>).appendFileSync = () => {
      throw erofs();
    };
    expect(() => safeAppend('/app/server/caption-debug.log', 'line\n')).not.toThrow();
  });

  it('safeTruncate swallows EROFS too', () => {
    (fs as unknown as Record<string, unknown>).writeFileSync = () => {
      throw erofs();
    };
    expect(() => safeTruncate('/app/server/caption-debug.log')).not.toThrow();
  });

  it('stops retrying a permanently dead path — one failed syscall, not one per line', () => {
    let attempts = 0;
    (fs as unknown as Record<string, unknown>).appendFileSync = () => {
      attempts += 1;
      throw erofs();
    };
    for (let i = 0; i < 50; i += 1) safeAppend('/app/server/dead.log', `line ${i}\n`);
    expect(attempts).toBe(1);
  });

  it('keeps retrying a TRANSIENT failure — only permanent codes are memoised', () => {
    let attempts = 0;
    (fs as unknown as Record<string, unknown>).appendFileSync = () => {
      attempts += 1;
      const err: NodeJS.ErrnoException = new Error('too many open files');
      err.code = 'EMFILE';
      throw err;
    };
    for (let i = 0; i < 3; i += 1) safeAppend('/app/server/flaky.log', 'x\n');
    expect(attempts).toBe(3);
  });

  it('still writes normally when the filesystem is writable', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rofs-')), 'ok.log');
    safeAppend(file, 'first\n');
    safeAppend(file, 'second\n');
    expect(fs.readFileSync(file, 'utf-8')).toBe('first\nsecond\n');
    safeTruncate(file);
    expect(fs.readFileSync(file, 'utf-8')).toBe('');
  });
});
