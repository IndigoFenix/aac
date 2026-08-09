// transcripts/tp-probe.ts — READ-ONLY investigation harness (throwaway).
//
// Boots the SAME headless text quest the CLI boots (bootTextQuest), then every
// sim-second records, for each family resident:
//   • ground truth hands   — world objects with carriedBy === <body>
//   • the held bag's stock — session.containerStock[bagObjId]
//   • the PANEL projection — inspectCreature(...).rows "carrying" (== carryText(host.carryOf))
//   • trip clock           — session.liveTripAt
//   • home boxes           — furn_<house>_* container stocks
//   • market ledger        — session.marketConsumed totals
// Plus a PER-FRAME position-continuity watch (teleport detection).
//
// Nothing here mutates the sim: every read is a get/find, exactly as the debug
// panel's probe bundle is.

import * as fs from "node:fs";
import * as path from "node:path";
import { bootTextQuest } from "../shared/world-engine/headless/text-quest.ts";
import { inspectCreature } from "../shared/world-engine/interaction/quest/creature-inspect.ts";

const argv = process.argv.slice(2);
const argOf = (k: string, d: string): string => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1] : d;
};
const SEED = Number(argOf("--seed", "12"));
const DT = 1 / Number(argOf("--dtinv", "20"));
const SIM_S = Number(argOf("--sim", "260"));
const OUT = argOf("--out", `transcripts/tp-probe-seed${SEED}`);

const worldPath = path.resolve(process.cwd(), "games/dollhouse/src/game.spec.json");
const raw = JSON.parse(fs.readFileSync(worldPath, "utf8")) as Record<string, unknown>;

const logStream = fs.createWriteStream(`${OUT}.console.log`, { encoding: "utf8" });
const origLog = console.log.bind(console);
let tNow = 0;
const consoleHits: string[] = [];
console.log = (...parts: unknown[]) => {
  const line = parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join(" ");
  logStream.write(`t=${tNow.toFixed(1)} ${line}\n`);
  if (
    /trip overran|SET DOWN|fetching a bag|took \d|deposited|banked|DEMOTED|PUT DOWN|NO ROOM|drew \d/.test(
      line,
    )
  ) {
    consoleHits.push(`t=${tNow.toFixed(1)} ${line}`);
  }
};
console.info = console.log;
console.warn = console.log;
console.debug = console.log;

const run = bootTextQuest({ world: raw, seed: SEED, dt: DT });
const host = run.host as any;
const session = run.session as any;
const state = () => (host.world?.state ?? null) as any;

const probes = {
  state: null as any,
  activityOf: (cid: string) => host.activityOf(cid),
  whyProbe: (_cid: string) => undefined, // not needed; keeps the pass cheap
  carryOf: (cid: string) => host.carryOf(cid) ?? {},
  nameOf: (cid: string) => host.nameOf(cid),
  errandPath: (aid: string) => host.world?.npcErrandPath(aid) ?? null,
};

const houseIdx: number = session.town?.familyHouse ?? 0;
const members: number = session.town?.config?.family?.members?.length ?? 3;
const CIDS: string[] = [];
for (let m = 0; m < members; m++) CIDS.push(`resident_${houseIdx}_${m}`);

const bodyIdOf = (cid: string): string | null => {
  const st = state();
  if (!st) return null;
  if (st.avatars[cid]) return cid;
  if (st.avatars[`npc_${cid}`]) return `npc_${cid}`;
  return null;
};

const glyphOfObj = (objId: string): string =>
  session.smallProps.get(objId)?.glyph ??
  state()?.spec.objects.find((s: any) => s.id === objId)?.glyph ??
  "?";

/** GROUND TRUTH HANDS: every world object whose carriedBy is this body. This is
 *  what a renderer draws riding the body — the eye's own answer. */
const handsTruth = (cid: string): { objId: string; glyph: string; stock: Record<string, number> | null }[] => {
  const st = state();
  const bid = bodyIdOf(cid);
  if (!st || !bid) return [];
  const out: { objId: string; glyph: string; stock: Record<string, number> | null }[] = [];
  for (const [id, o] of Object.entries<any>(st.objects)) {
    if (o?.carriedBy !== bid) continue;
    const g = glyphOfObj(id);
    const stock = session.containerStock.get(id) ?? null;
    out.push({ objId: id, glyph: g, stock: stock ? { ...stock } : null });
  }
  return out;
};

const homeBoxes = (): Record<string, Record<string, number>> => {
  const out: Record<string, Record<string, number>> = {};
  for (const [id, stock] of session.containerStock as Map<string, Record<string, number>>) {
    if (!id.startsWith(`furn_${houseIdx}_`)) continue;
    const nonzero = Object.fromEntries(Object.entries(stock).filter(([, n]) => (n as number) > 0));
    if (Object.keys(nonzero).length) out[id] = nonzero as Record<string, number>;
  }
  return out;
};
const sumOf = (o: Record<string, Record<string, number>>): number => {
  let n = 0;
  for (const s of Object.values(o)) for (const v of Object.values(s)) n += v;
  return n;
};

const marketTotals = (): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const [id, c] of session.marketConsumed as Map<string, any>) {
    // StoreConsumption shape is opaque here — record its units field(s) generically.
    out[id] = typeof c?.units === "number" ? c.units : JSON.parse(JSON.stringify(c))?.units ?? -1;
  }
  for (const [id, c] of session.produceConsumed as Map<string, any>) {
    out[`P:${id}`] = typeof c?.units === "number" ? c.units : -1;
  }
  return out;
};

const panelCarrying = (cid: string): string => {
  probes.state = state();
  const ins = inspectCreature(session, cid, probes as any);
  const row = (l: string) => ins.rows.find((r) => r.label === l)?.value ?? "";
  return JSON.stringify({
    body: row("body"),
    position: row("position"),
    motion: row("motion"),
    going: row("going"),
    carrying: row("carrying"),
    task: row("task"),
    claims: row("claims"),
    embodied: ins.embodied,
  });
};

// ── header: the town facts the readout's own maths depends on ──────────────
const header: any = {
  familyHouse: houseIdx,
  members,
  housesLen: session.town?.plan?.houses?.length,
  houseAtArrayIdx: (() => {
    const h = session.town?.plan?.houses?.[houseIdx];
    return h ? { index: h.index, dx: h.dx, dy: h.dy, w: h.w, h: h.h } : null;
  })(),
  houseByIndexField: (() => {
    const h = session.town?.plan?.houses?.find((x: any) => x.index === houseIdx);
    return h ? { index: h.index, dx: h.dx, dy: h.dy, w: h.w, h: h.h } : null;
  })(),
  center: session.town?.stage?.center,
  goods: (session.town?.stage?.goods ?? []).map((g: any) => {
    const h = session.town.plan.houses.find((x: any) => x.index === houseIdx);
    let cyc: any = null;
    try {
      cyc = h ? g.cycle(h) : null;
    } catch (e) {
      cyc = String(e);
    }
    return { key: g.good.key, trip: cyc?.trip, period: cyc?.period, units: cyc?.units };
  }),
};

// ── the run ────────────────────────────────────────────────────────────────
const rows: any[] = [];
const jumps: string[] = [];
const last = new Map<string, { x: number; y: number }>();
const FRAMES = Math.round(SIM_S / DT);
const SAMPLE_EVERY = Math.round(1 / DT); // 1 sim-second

for (let f = 0; f < FRAMES; f++) {
  run.stepFrame();
  tNow = (f + 1) * DT;
  // PER-FRAME continuity: a walking body moves ≤ ~0.2 m per 0.05 s step.
  const st = state();
  if (st) {
    for (const cid of CIDS) {
      const bid = bodyIdOf(cid);
      const a = bid ? st.avatars[bid] : null;
      if (!a) {
        last.delete(cid);
        continue;
      }
      const p = last.get(cid);
      if (p) {
        const d = Math.hypot(a.x - p.x, a.y - p.y);
        if (d > 0.75) {
          jumps.push(
            `t=${tNow.toFixed(2)} ${cid} JUMP ${d.toFixed(2)}m  ${p.x.toFixed(1)},${p.y.toFixed(1)} -> ${a.x.toFixed(1)},${a.y.toFixed(1)}`,
          );
        }
      }
      last.set(cid, { x: a.x, y: a.y });
    }
  }
  if ((f + 1) % SAMPLE_EVERY !== 0) continue;
  const boxes = homeBoxes();
  const rec: any = {
    t: Number(tNow.toFixed(1)),
    clock: Number((session.townClock ?? 0).toFixed(1)),
    homeSum: sumOf(boxes),
    boxes,
    market: marketTotals(),
    stockAudit: Math.round(tNow) % 20 === 0 ? host.stockAudit() : undefined,
    per: {} as Record<string, any>,
  };
  for (const cid of CIDS) {
    const bid = bodyIdOf(cid);
    const a = bid ? state()?.avatars[bid] : null;
    const hands = handsTruth(cid);
    const step = session.needStep.get(cid);
    rec.per[cid] = {
      pos: a ? [Number(a.x.toFixed(1)), Number(a.y.toFixed(1))] : null,
      hands,
      carryOf: host.carryOf(cid),
      worn: session.wornBags.get(cid)?.glyph ?? null,
      live: session.liveNeedBodies.has(cid),
      tripAt: session.liveTripAt.get(cid) ?? null,
      step: step ? `${step.kind}:${step.tplKey}×${step.units} @ ${step.objId ?? "-"}` : null,
      pursuit: session.pursuits.get(cid)
        ? `${session.pursuits.get(cid).goal.kind}:${session.pursuits.get(cid).tplKey ?? "-"}`
        : null,
      panel: panelCarrying(cid),
    };
  }
  rows.push(rec);
}

fs.writeFileSync(`${OUT}.header.json`, JSON.stringify(header, null, 1));
fs.writeFileSync(`${OUT}.jsonl`, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
fs.writeFileSync(`${OUT}.jumps.txt`, jumps.join("\n") + "\n");
fs.writeFileSync(`${OUT}.events.txt`, consoleHits.join("\n") + "\n");
logStream.end();
run.dispose();
origLog(
  `done: ${rows.length} samples, ${jumps.length} position jumps, ${consoleHits.length} ledger events -> ${OUT}.*`,
);
