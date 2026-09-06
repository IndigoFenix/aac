// 🌳 TREES RIDE THE PER-BODY LOD LADDER (2026-09-06 — "tree rendering LoD is
// kind of random, sometimes there are fully-rendered trees intermingled with
// low-LOD trees at the same distance").
//
// `retieringBodyId` (quest-host.ts) is "the ONE ladder list (⑤)" — the same
// membership for THREE consumers: the per-frame re-band sweep, the town-clamp
// requeue (`setCreatureTier`) and the capsule-tier model swap. `flora:` was
// missing from it because a TREE must never become a placeholder capsule, but
// omitting it also took trees out of the first two: `tierOf` seeded a tree's
// tier at its first model build and nothing ever changed it
// (`createCreatureAvatarFactory`: "Detail is sampled ONCE per model build";
// the rebuild path is `resetAvatarModel`, driven only by the retier queue).
// A stand is dealt in batches at different moments — `seedWilderness` at the
// mount, one annulus per building event in `growNearStand`, a re-stand after a
// re-seed in `standWildFeature` — so each batch froze the effective tier of ITS
// moment and full and stick trees stood side by side at the same distance for
// the rest of the session, with no distance that fixed it. Exactly the
// ghost-caravan defect one prefix later (the docblock on `retieringBodyId`
// tells that story about `caravan_*`).
//
// SOURCE PINS, deliberately, and DB-free: `retieringBodyId` is module-private
// and a value import of quest-host costs every worker in this suite the host's
// whole transform (the reason long play arcs live in text mode, not jest). The
// three consumer sites are pinned by their own guard so the list cannot quietly
// grow a fourth reader that forgets one.
//
// Slice: `npm run test:engine -- flora`

import { describe, it, expect } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(
  join(process.cwd(), "shared", "world-engine", "interaction", "quest", "quest-host.ts"),
  "utf8",
);

/** The body of `retieringBodyId`, source text. */
function ladderList(): string {
  const at = SRC.indexOf("function retieringBodyId(id: string): boolean {");
  expect(at).toBeGreaterThan(0);
  const end = SRC.indexOf("\n}", at);
  return SRC.slice(at, end);
}

describe("the ONE ladder list — who re-bands by camera distance", () => {
  it("lists every streamed ambient body prefix, TREES INCLUDED", () => {
    const body = ladderList();
    for (const prefix of ["resident_", "fauna:", "flora:", "pet_", "caravan_", "hauler_", "cohort_"]) {
      expect(body).toContain(`id.startsWith("${prefix}")`);
    }
  });

  it("is read by all three consumers, and by nothing that skips one", () => {
    // The declaration + the three guards. A fourth reader is a decision to make
    // out loud (add it here with its law), not something to discover in GL.
    const reads = SRC.match(/retieringBodyId\(id\)/g) ?? [];
    expect(reads.length).toBe(3);
    // ① the capsule model swap, ② the per-frame re-band sweep,
    // ③ the town-clamp requeue.
    expect(SRC).toContain('!isLocal && retieringBodyId(id) && !id.startsWith("flora:") && tierFor?.(id) === "capsule"');
    expect((SRC.match(/if \(!retieringBodyId\(id\)\) continue;/g) ?? []).length).toBe(2);
  });

  it("keeps the capsule swap off trees — at the swap, not by omission", () => {
    // A tree is landscape: it may coarsen to the stick tier (that IS the plant
    // far tier) but must never be replaced by the placeholder pill. The
    // exclusion belongs to the ONE consumer that wanted it; spelling it by
    // leaving `flora:` out of the list is what froze every tree's detail.
    const at = SRC.indexOf('tierFor?.(id) === "capsule"');
    expect(at).toBeGreaterThan(0);
    const line = SRC.slice(SRC.lastIndexOf("\n", at) + 1, SRC.indexOf("\n", at));
    expect(line).toContain('!id.startsWith("flora:")');
  });

  it("still builds a tree's detail from the band (never a hardcoded tier)", () => {
    // makeNaturalBodyFactory takes the driver's detailFor — the ladder's own
    // mapping — so a re-band actually changes what the next build asks for.
    const at = SRC.indexOf("function makeNaturalBodyFactory(");
    expect(at).toBeGreaterThan(0);
    const body = SRC.slice(at, at + 1600);
    expect(body).toContain("...(detailFor ? { detailFor } : {})");
  });
});
