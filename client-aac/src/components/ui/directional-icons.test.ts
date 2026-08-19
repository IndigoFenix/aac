// Direction rule for UI chrome — the triangle helpers, plus the guard that
// keeps new chrome from naming a physical side.
//
// The component wrappers (ChevronBack &c.) can't be asserted here: this jest
// project is `testEnvironment: 'node'` by design, so there is no renderer. What
// IS assertable — and is the thing that actually rotted — is that no app-chrome
// file reaches for lucide's left/right icons directly. That is the shape of the
// original bug: three call sites wrote the `isRTL ? … : …` ternary and a dozen
// never did, so a Hebrew student's Back button pointed away from back.

import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { forwardTriangle, backTriangle } from "./directional-icons";

describe("triangle helpers", () => {
  it("points forward along the reading direction", () => {
    expect(forwardTriangle(false)).toBe("▶");
    expect(forwardTriangle(true)).toBe("◀");
  });

  it("points back against the reading direction", () => {
    expect(backTriangle(false)).toBe("◀");
    expect(backTriangle(true)).toBe("▶");
  });

  it("never agrees with itself across the two directions", () => {
    // Guards the copy-paste slip where both helpers return the same character:
    // a board whose "deeper" and "back" marks look identical is unreadable.
    expect(forwardTriangle(true)).not.toBe(backTriangle(true));
    expect(forwardTriangle(false)).not.toBe(backTriangle(false));
  });
});

/** Icons that name a physical side. Chrome must go through the logical set. */
const PHYSICAL = /<(ChevronLeft|ChevronRight|ArrowLeft|ArrowRight|ArrowLeftToLine|ArrowRightToLine)[\s/>]/;

/** Surfaces a student sees. `ui/` shadcn primitives and the debug panel are
 *  out of scope — the former is unused vendored boilerplate, the latter is
 *  explicitly exempt from translation/RTL work. */
const CHROME_DIRS = ["src/components", "src/components/apps", "src/pages"];

/** Developer-only surfaces. Debug features are exempt from the translation and
 *  RTL passes by project rule — no student ever opens this panel. */
const EXEMPT = new Set(["UnifiedDebugPanel.tsx"]);

function tsxFilesIn(dir: string): string[] {
  const abs = join(process.cwd(), "client-aac", dir);
  return readdirSync(abs, { withFileTypes: true })
    .filter(
      (e) =>
        e.isFile() && e.name.endsWith(".tsx") && !e.name.includes(".test.") && !EXEMPT.has(e.name),
    )
    .map((e) => join(abs, e.name));
}

describe("app chrome uses logical arrows", () => {
  it("names no physical-side icon", () => {
    const offenders: string[] = [];
    for (const dir of CHROME_DIRS) {
      for (const file of tsxFilesIn(dir)) {
        const src = readFileSync(file, "utf8");
        for (const [i, line] of src.split("\n").entries()) {
          if (PHYSICAL.test(line)) offenders.push(`${dir}/${file.split(/[\\/]/).pop()}:${i + 1}`);
        }
      }
    }
    // If this fires: import ChevronBack / ChevronForward / ArrowBack /
    // ArrowForward from @/components/ui/directional-icons instead. Media
    // TRANSPORT (rewind, fast-forward) is the one exception — it maps to tape
    // motion, not reading order, and lucide has dedicated icons for it that
    // this pattern does not match.
    expect(offenders).toEqual([]);
  });
});
