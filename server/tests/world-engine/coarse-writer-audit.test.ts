// THE MEMBRANE AUDIT (states round S4 — states-round.md §4 law 2 / §10):
// "coarse writers as a closed, enumerable, audited list." The destiny laws'
// one real risk is disciplinary — an accidental micro→macro path silently
// breaks path-independence — so this suite CLOSES the list two ways:
//
//   1. THE CHANNEL TABLE: every declared flow, registered on the destiny
//      membrane (`registerCoarseChannel`) — the enumerable half.
//   2. THE WRITE-SITE PINS: the raw write patterns (`driftBank` mirror
//      assignments, `TownWorld.inject` callers, ad-hoc `deltas.stock`
//      writes, live plan mutations) counted across the WHOLE of
//      shared/world-engine. A NEW site anywhere reds this suite until it
//      is routed through a channel or added here WITH ITS LAW — the
//      one-definition-audit pattern applied to history.
//
// The pins are per-file COUNTS, deliberately: brittle to refactors is the
// point — moving or adding a coarse writer is a decision, and this table
// is where it gets made out loud. (Recorded S4 decisions: the three
// driftBank mirror sites stay three — creditImport/debitExport wrap two,
// stepDriftDrain inlines the third; consolidating them buys no closure
// the pin does not already give and risks the books. tri.ts's two
// advanceDays paths — quiet-delegate vs stepped — stay a RECORDED
// EXEMPTION: lab-world machinery, its proof lives with a future
// CompositionBoot fixture, never silently.)
// Slice: `npm run test:engine -- coarse-writer`

import { describe, it, expect } from "@jest/globals";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  registerCoarseChannel, coarseChannels, isCoarseChannel,
} from "@shared/world-engine/kernel/destiny.js";
// Importing state-books registers its own channel — the membrane's first
// real producer, asserted below.
import "@shared/world-engine/planet/state-books.js";

const ROOT = join(process.cwd(), "shared", "world-engine");

/** Every .ts file under shared/world-engine, repo-relative below the root,
 *  forward slashes — the audit's whole jurisdiction. */
function allSources(): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string): void => {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name);
      const r = rel ? `${rel}/${name}` : name;
      if (statSync(abs).isDirectory()) walk(abs, r);
      else if (name.endsWith(".ts")) out.push(r);
    }
  };
  walk(ROOT, "");
  return out.sort();
}

interface WriterPin {
  /** The law this write family lives under — the failure message's teacher. */
  law: string;
  pattern: RegExp;
  /** file (relative to shared/world-engine, forward slashes) → site count. */
  sites: Record<string, number>;
}

const WRITER_PINS: WriterPin[] = [
  {
    law:
      "THE DRIFT-BANK MIRROR — the durable book mirror has exactly three " +
      "writers, all in quest-host (creditImport, debitExport, " +
      "stepDriftDrain); a fourth is a new coarse channel to declare",
    pattern: /deltas\.driftBank\[[^\]]+\] =/g,
    sites: { "interaction/quest/quest-host.ts": 3 },
  },
  {
    law:
      "TOWN-WORLD.INJECT — the one door into the town books; its callers " +
      "are the delivery joins (town-quests ×3), the boot replay " +
      "(town-play ×2), the day's eating (quest-host ×1) and the founded " +
      "completion (construction-director ×1)",
    pattern: /\.inject\(/g,
    sites: {
      "interaction/town/town-quests.ts": 3,
      "interaction/town/town-play.ts": 2,
      "interaction/quest/quest-host.ts": 1,
      "interaction/quest/construction-director.ts": 1,
    },
  },
  {
    law:
      "YARD-STOCK AD-HOC WRITES — recorded exemption: construction's own " +
      "pile arithmetic (deposit, refused-order return, declared-resources " +
      "boot fold); a write outside these is a new channel to declare",
    pattern: /deltas\.stock\[[^\]]+\] =/g,
    sites: {
      "interaction/town/town-play.ts": 1,
      "interaction/quest/construction-director.ts": 2,
    },
  },
  {
    law:
      "LIVE PLAN MUTATIONS — recorded exemptions: move-in vacates/founds " +
      "(quest-host), the thirst-service well dig (quest-host), zone-steered " +
      "founding (construction-director) and boot seeding (town-play); the " +
      "plan is otherwise a build-time artifact",
    pattern: /plan\.(works|houses|wells)\.push\(/g,
    sites: {
      "interaction/town/town-play.ts": 3,
      "interaction/quest/construction-director.ts": 2,
      "interaction/quest/quest-host.ts": 2,
    },
  },
];

/** The declared flows — the membrane's enumerable half. Owners in the
 *  descriptions; the fold codecs keep their OWN registry (registerFoldCodec,
 *  kernel/town/fold.ts — the second closed membrane; the warp's arms table
 *  is the third). */
const CHANNELS = [
  { id: "town-books:credit-import", description: "a landed import credits the flownet stockpile + the driftBank mirror (quest-host creditImport, B1-bridged)" },
  { id: "town-books:debit-export", description: "what leaves on the cart leaves the books (quest-host debitExport)" },
  { id: "town-books:drift-drain", description: "the day's eating drains the granary at day edges (quest-host stepDriftDrain)" },
  { id: "wild:draw", description: "a region source yields standing units to a leg or shelf (wild-area drawWildArea via drawSourceShelf)" },
  { id: "farm:haul", description: "the town's field feeds the day's modelled consumption (quest-host stepFarmSource — street rung, eaten is the sink)" },
  { id: "cohort:rates-step", description: "pooled households produce/consume/age on the day clock (population cohortRatesStep)" },
  { id: "polity:apply-resolutions", description: "a live world's dispute outcomes relabel the polity ledger — genuine coarse interventions, append-only + high-water mark (history applyResolutions)" },
];

describe("the membrane — declared flows, enumerable and closed", () => {
  it("registers every channel once; the first real producer is already on it", () => {
    expect(isCoarseChannel("state-books:intervention")).toBe(true); // state-books' own
    for (const ch of CHANNELS) registerCoarseChannel(ch);
    const ids = coarseChannels().map((c) => c.id);
    for (const ch of CHANNELS) expect(ids).toContain(ch.id);
    expect([...ids].sort()).toEqual(ids); // deterministic enumeration
    expect(() => registerCoarseChannel(CHANNELS[0]!)).toThrow(/already registered/);
  });
});

describe("the write-site pins — a new coarse writer cannot land silently", () => {
  const sources = allSources();
  const text = new Map<string, string>();
  const read = (rel: string): string => {
    let t = text.get(rel);
    if (t === undefined) {
      t = readFileSync(join(ROOT, rel), "utf8");
      text.set(rel, t);
    }
    return t;
  };

  for (const pin of WRITER_PINS) {
    it(pin.law, () => {
      const found: Record<string, number> = {};
      for (const rel of sources) {
        const n = read(rel).match(pin.pattern)?.length ?? 0;
        if (n > 0) found[rel] = n;
      }
      expect(found).toEqual(pin.sites);
    });
  }
});
