// ⏱️ THE ARC-NAMING GUARD — the drift stopper for the 2026-09-09 efficiency round.
//
// A world-engine suite that calls `bootTextQuest` boots the REAL quest-host
// headless. That costs ~60 s of wall time before its first assertion, and the
// count only ever goes up: 22 such suites on 2026-09-05 (56 % of a 74-minute
// sweep), 35 four days later. They now live behind their own config
// (`jest.config.engine-arcs.js` → `npm run test:engine:arcs`), selected by
// FILENAME so nobody has to maintain a list.
//
// This guard fails the fast half the moment a boot arc is written without the
// name. It is deliberately cheap: it reads the folder, it boots nothing.
//
// Note what is NOT flagged: importing `planetCellWildMix` / `PLANET_CELL_ECO`
// from `headless/text-quest` (pure data helpers — `forage-flow-anchor.test.ts`
// does exactly that and is not an arc). The marker is the BOOT.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));

/** Every `*.test.ts` under server/tests/world-engine/, recursively. */
function testFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = path.join(dir, e);
    if (statSync(p).isDirectory()) testFiles(p, out);
    else if (p.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

/** The boot, in either of the two shapes a suite can write it. */
const BOOTS = [/\bbootTextQuest\s*\(/, /\bimport\s*\{[^}]*\bbootTextQuest\b[^}]*\}/s];

describe("⏱️ boot arcs are named `*.arc.test.ts`", () => {
  const files = testFiles(DIR);

  it("no un-named suite boots the quest host", () => {
    const offenders = files
      .filter((f) => !f.endsWith(".arc.test.ts"))
      .filter((f) => {
        const src = readFileSync(f, "utf8");
        return BOOTS.some((re) => re.test(src));
      })
      .map((f) => path.relative(DIR, f));

    // The failure message IS the fix instructions — an author who hits this has
    // just written a slow suite into the fast tier by accident.
    if (offenders.length)
      throw new Error(
        `These suites call bootTextQuest but are not named *.arc.test.ts:\n` +
          offenders.map((o) => `  • ${o}`).join("\n") +
          `\n\nA quest-host boot costs ~60 s before its first assertion, so it belongs in the\n` +
          `ARC tier (npm run test:engine:arcs), not the per-tweak one (npm run test:engine).\n` +
          `Either rename the file to <name>.arc.test.ts, or — better for a long play arc —\n` +
          `move it to text mode: npm run world:text / scripts/dev/arc-run.ts.\n` +
          `See CLAUDE.md "Test layout & fast paths".`,
      );
    expect(offenders).toEqual([]);
  });

  it("every named arc actually boots (the name is not decoration)", () => {
    const idle = files
      .filter((f) => f.endsWith(".arc.test.ts"))
      .filter((f) => !BOOTS.some((re) => re.test(readFileSync(f, "utf8"))))
      .map((f) => path.relative(DIR, f));
    // A suite that stopped booting should come BACK to the fast tier — an arc
    // config that quietly accumulates cheap suites is the same drift in the
    // other direction.
    expect(idle).toEqual([]);
  });
});
