// Fail LOUDLY when jest is running without `--experimental-vm-modules`.
//
// Jest does not error when the flag is missing. `jest-resolve`'s
// `cachedShouldLoadAsEsm()` opens with `if (!runtimeSupportsVmModules) return
// false` — so every `.ts` file quietly falls back to the CommonJS transform
// despite `extensionsToTreatAsEsm`. Two things follow, and only the first is
// visible:
//
//   1. Any file using `import.meta` or top-level `await` dies at PARSE time
//      ("Cannot use 'import.meta' outside a module"), which reads like a broken
//      source file rather than a missing runtime flag.
//   2. `jest.unstable_mockModule` — the only way to mock an ESM dependency —
//      becomes a silent no-op. The suite loads the REAL module and calls the
//      REAL API with the REAL key from .env. That costs money and reads as a
//      code regression when nothing is broken.
//
// (2) is why this is a hard abort and not a warning.
//
// Incident 2026-08-31: `npm test` and `npm run test:unit` had been running the
// whole suite as CommonJS. The scripts passed the flag via
// `cross-env NODE_OPTIONS='--experimental-vm-modules --max-old-space-size=6144'`,
// but cross-env v8 dropped its quote-rejoining behaviour (we are on v10), so on
// Windows cmd.exe split the value at the space and node received the literal
// `'--experimental-vm-modules` — an unrecognised option, silently ignored. The
// single-flag scripts (`test:engine`, `test:integration`, …) still worked,
// which is why this looked like a handful of individually broken suites.
// The scripts now invoke `node --experimental-vm-modules node_modules/jest/bin/jest.js`
// directly: no env-var round-trip, no shell quoting, same on every platform.

// Namespace import, not `{ SyntheticModule }`: without the flag the named
// export does not exist and node throws a SyntaxError before this file runs,
// which is exactly the unhelpful error this guard exists to replace.
import * as vm from "vm";

export function assertVmModules() {
  if (typeof vm.SyntheticModule === "function") return;
  throw new Error(
    "\n\njest is running WITHOUT --experimental-vm-modules.\n" +
      "Every .ts file would load as CommonJS: import.meta/top-level-await fail to\n" +
      "parse, and jest.unstable_mockModule silently no-ops so mocked suites hit the\n" +
      "REAL paid APIs.\n\n" +
      "Run tests through the npm scripts (npm test, npm run test:unit, ...), which\n" +
      "invoke `node --experimental-vm-modules node_modules/jest/bin/jest.js`.\n" +
      "A bare `npx jest` will always land here.\n",
  );
}
