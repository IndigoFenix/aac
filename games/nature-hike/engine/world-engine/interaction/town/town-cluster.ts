// shared/world-engine/interaction/town/town-cluster.ts
//
// BEYOND ONE TOWN: a walking session as a WINDOW on the planet chart, with
// several living towns streaming into the SAME world as the player walks.
//
// The seam that makes this cheap: a TownStage's frame() emits PURE DATA
// diffs (buildings, residents, errands, furniture) in its own town frame —
// so a neighbor's stage can be TRANSLATED onto the window's coordinates and
// MERGED with the primary's. Every id is namespaced per town so two towns'
// `resident_4` never collide. The primary town keeps the quests, the cast,
// the goods vocabulary (dialogue stays its turf); neighbors stream as fully
// alive bodies — their streets, houses, furniture and errand-walking
// residents — which is the v1 contract (talking to a neighbor's residents
// joins when creature minds stream with them).
//
// Determinism holds: the cluster is a pure function of its towns + offsets.

import type { ClusterHouseCtx, ClusterPartner, ConstructionSite, TownStage, TownStageFrame } from "./town-stage.js";
import { buildTownPlay, type TownPlay, type TownPlayConfig } from "./town-play.js";
import type { TownTrade } from "../../kernel/town/trade.js";
import type { WorldSpec, RoadPath, BuildingSpec } from "../../types.js";

export interface ClusterMember {
  stage: TownStage;
  /** The town's center in WINDOW coordinates. */
  at: { x: number; y: number };
  /** Namespace for this town's streamed ids (unique per member). */
  tag: string;
  /** House-index offset for this member's RESIDENTS (0 for the primary).
   *  A resident id stays PROTOCOL-VALID (`resident_{house}_{member}`) with
   *  the house remapped into this member's reserved range — so the quest
   *  host's dialogue layer gives neighbor residents REAL MINDS through the
   *  standard `ensureResidentCreature` path (goods-slot needs, graceful
   *  family fallbacks) instead of seeing an opaque foreign id. Non-resident
   *  ids get the tag prefix (host treats them opaquely). */
  houseBase?: number;
  /** The member's LIVE town context (its full TownPlay). With it, the
   *  composite stage's `cluster.resolveHouse` answers a neighbor resident's
   *  OWN books/geometry (needs, deliveries, directions) instead of the
   *  primary's. Optional: a member without it streams bodies only. */
  play?: TownPlay;
}

const RESIDENT_ID = /^resident_(\d+)_(\d+)$/;

/** Namespace a streamed id: residents by house-range remap (protocol-valid
 *  — talkable), everything else by tag prefix (opaque). */
function mapId(id: string, tag: string, houseBase: number): string {
  if (!houseBase) return id; // the primary keeps its native ids
  const m = RESIDENT_ID.exec(id);
  return m ? `resident_${houseBase + Number(m[1])}_${m[2]}` : `${tag}:${id}`;
}
/** Translate one town's streamed frame into window coordinates. */
function offsetFrame(f: TownStageFrame, dx: number, dy: number, tag: string, houseBase: number): TownStageFrame {
  return {
    buildings: f.buildings
      ? f.buildings.map(b => ({
          ...b,
          id: houseBase ? `${tag}:${b.id}` : b.id,
          footprint: { ...b.footprint, x: b.footprint.x + dx, y: b.footprint.y + dy },
        }))
      : null,
    sites: f.sites
      ? f.sites.map(s => ({
          ...s,
          id: houseBase ? `${tag}:${s.id}` : s.id,
          x: s.x + dx,
          y: s.y + dy,
        }))
      : null,
    add: f.add.map(n => ({ ...n, id: mapId(n.id, tag, houseBase), x: n.x + dx, y: n.y + dy })),
    remove: f.remove.map(id => mapId(id, tag, houseBase)),
    errands: f.errands.map(e => ({
      npcId: mapId(e.npcId, tag, houseBase),
      points: e.points.map(p => ({ ...p, x: p.x + dx, y: p.y + dy })),
    })),
    addObjects: f.addObjects.map(o => ({ ...o, id: mapId(o.id, tag, houseBase), x: o.x + dx, y: o.y + dy })),
    removeObjects: f.removeObjects.map(id => mapId(id, tag, houseBase)),
  };
}

const offsetRoads = (roads: RoadPath[], dx: number, dy: number): RoadPath[] =>
  roads.map(r => ({ ...r, points: r.points.map(p => ({ x: p.x + dx, y: p.y + dy })) }));

/**
 * THE INTERCITY LINE, SEEN FROM THE WINDOW (trade-topology ⑤ / S2b).
 *
 * The composite's caravan line IS the primary's — one town, one road out — but
 * the two live in different frames. The trade geometry (gate, route, and
 * therefore `route.partnerAt`) belongs to the PRIMARY's own coordinates,
 * because the caravan streams through the primary's stage; the DEPOT is the
 * one anchor the host reads directly to stand the crates, so it must be in
 * WINDOW coordinates. That mismatch used to be papered over at the ring's own
 * seat — the caller lifted the depot, and separately subtracted `windowShift`
 * from a partner's `at` before binding. Both halves live HERE now, so a caller
 * that knows nothing about frames (the engine's `chooseTradePartner`, which
 * enumerates partners in the composite's own window coordinates) binds
 * correctly by construction.
 *
 * Everything else DELEGATES BY REFERENCE — in particular `route` is the very
 * object the line mutates in place, because the host reads `tr.route.partnerKey`
 * straight after a bind.
 */
function windowFramedTrade(inner: TownTrade, d0: { x: number; y: number }): TownTrade {
  return {
    // NOT a copy: `bindPartner` mutates this object, and the host reads it back.
    get route() { return inner.route; },
    // The one anchor in WINDOW coordinates (the crates stand where the player is).
    depot: { x: inner.depot.x + d0.x, y: inner.depot.y + d0.y },
    caravan: (t) => inner.caravan(t),
    tradeDay: (t) => inner.tradeDay(t),
    dayPhase: (t) => inner.dayPhase(t),
    importUnitsPerVisit: (good) => inner.importUnitsPerVisit(good),
    refreshCargo: (scarcity) => inner.refreshCargo(scarcity),
    exportPile: (t) => inner.exportPile(t),
    exportDailyUnits: () => inner.exportDailyUnits(),
    // WINDOW frame → PRIMARY frame. This is the seat the ring's `− windowShift`
    // was; `d0` is that same shift (`primary.at − primary.stage.center`).
    bindPartner: (partner) =>
      inner.bindPartner({ ...partner, at: { x: partner.at.x - d0.x, y: partner.at.y - d0.y } }),
  };
}

/**
 * Compose a walking WINDOW from a primary town and its neighbors.
 *
 * `windowSpec` is the session's world spec — the caller widens the primary
 * stage's spec to the window extent and shifts its content (spawns, cast)
 * by the primary's offset. This function owns the STREAMING composition:
 * one TownStage whose frame() is every member's frame, translated + merged.
 */
export function clusterStages(
  windowSpec: WorldSpec,
  primary: ClusterMember,
  neighbors: ClusterMember[],
): TownStage {
  const members = [primary, ...neighbors];
  const p0 = primary.stage.center;
  const d0 = { x: primary.at.x - p0.x, y: primary.at.y - p0.y };

  // Cast anchors live in the primary's frame → window coordinates.
  const castSpawns = new Map<string, { x: number; y: number }>();
  for (const [k, v] of primary.stage.castSpawns) {
    castSpawns.set(k, { x: v.x + d0.x, y: v.y + d0.y });
  }

  const roads: RoadPath[] = [];
  for (const m of members) {
    const dx = m.at.x - m.stage.center.x;
    const dy = m.at.y - m.stage.center.y;
    roads.push(...offsetRoads(m.stage.roads, dx, dy));
  }

  // `buildings` is a FULL-REPLACEMENT set per stage (null = unchanged) —
  // the union must come from each member's LAST set, or one member's
  // update would evict every other member's standing buildings.
  const lastBuildings = new Map<string, BuildingSpec[]>();
  // Sites follow the same full-replacement-per-member contract.
  const lastSites = new Map<string, ConstructionSite[]>();

  return {
    spec: windowSpec,
    center: { ...primary.at },
    roads,
    castSpawns,
    goods: primary.stage.goods,
    // The intercity caravan line stays the PRIMARY's (v1 — neighbor trade
    // joins when their carts get window-frame routes), wrapped so the window
    // and the primary agree about which frame a depot and a partner live in.
    trade: primary.stage.trade ? windowFramedTrade(primary.stage.trade, d0) : null,
    // A neighbor resident's house index carries its town (the reserved
    // range); this hands the host that town's OWN books + geometry.
    cluster: {
      resolveHouse(houseIndex: number): ClusterHouseCtx | null {
        if (houseIndex < 1000) return null; // the primary keeps native context
        const base = Math.floor(houseIndex / 1000) * 1000;
        const m = neighbors.find(n => (n.houseBase ?? 0) === base);
        if (!m?.play) return null;
        return {
          town: m.play.town,
          eco: m.play.eco,
          plan: m.play.plan,
          goods: m.stage.goods,
          localHouse: houseIndex - base,
          offset: { x: m.at.x - m.stage.center.x, y: m.at.y - m.stage.center.y },
          center: { ...m.at },
        };
      },
      // TRADE PARTNERS (⑤): every neighbor, keyed by its own config key
      // (else its tag). A member with a live TownPlay hands barter its REAL
      // books — scarcity signals off its fills/scalars and the yard stack
      // (deltas.stock) that `town:<key>` endpoints ALIAS, so intercity
      // shipments conserve stock across BOTH real economies.
      partners(): ClusterPartner[] {
        return neighbors.map((n) => ({
          key: n.play?.config.key ?? n.tag,
          at: { ...n.at },
          books: n.play
            ? { town: n.play.town, eco: n.play.eco, stock: n.play.deltas.stock }
            : null,
        }));
      },
    },
    frame(p, tSec, bodyPos, visibleR, isVisible, isRoomVisible) {
      const add: TownStageFrame["add"] = [];
      const remove: string[] = [];
      const errands: TownStageFrame["errands"] = [];
      const addObjects: TownStageFrame["addObjects"] = [];
      const removeObjects: string[] = [];
      let buildingsChanged = false;
      let sitesChanged = false;
      for (const m of members) {
        const dx = m.at.x - m.stage.center.x;
        const dy = m.at.y - m.stage.center.y;
        const houseBase = m.houseBase ?? 0;
        // Each stage sees the player in ITS OWN frame; live body positions
        // translate back the same way (through the id namespace).
        const f = offsetFrame(
          m.stage.frame(
            { x: p.x - dx, y: p.y - dy },
            tSec,
            bodyPos
              ? id => {
                  const live = bodyPos(mapId(id, m.tag, houseBase));
                  return live ? { x: live.x - dx, y: live.y - dy } : null;
                }
              : undefined,
            visibleR,
            isVisible,
            // Building ids reach the window namespaced (neighbors carry the
            // tag prefix — offsetFrame); the member stage asks in LOCAL ids.
            isRoomVisible
              ? id => isRoomVisible(houseBase ? `${m.tag}:${id}` : id)
              : undefined,
          ),
          dx, dy, m.tag, houseBase,
        );
        if (f.buildings) {
          lastBuildings.set(m.tag, f.buildings);
          buildingsChanged = true;
        }
        if (f.sites) {
          lastSites.set(m.tag, f.sites);
          sitesChanged = true;
        }
        add.push(...f.add);
        remove.push(...f.remove);
        errands.push(...f.errands);
        addObjects.push(...f.addObjects);
        removeObjects.push(...f.removeObjects);
      }
      return {
        buildings: buildingsChanged ? [...lastBuildings.values()].flat() : null,
        sites: sitesChanged ? [...lastSites.values()].flat() : null,
        add, remove, errands, addObjects, removeObjects,
      };
    },
  };
}

/**
 * Widen a primary stage's world spec to a WINDOW: manifold grows to
 * `width`×`height`, and the primary's content (spawns, authored npcs,
 * objects) shifts so its town center lands at `primaryAt`.
 */
export function widenSpecWindow(
  spec: WorldSpec,
  primaryCenter: { x: number; y: number },
  primaryAt: { x: number; y: number },
  width: number,
  height: number,
): WorldSpec {
  const dx = primaryAt.x - primaryCenter.x;
  const dy = primaryAt.y - primaryCenter.y;
  return {
    ...spec,
    manifold: { ...spec.manifold, width, height },
    spawns: spec.spawns.map(s => ({ ...s, x: s.x + dx, y: s.y + dy })),
    objects: spec.objects.map(o => ({ ...o, x: o.x + dx, y: o.y + dy })),
    npcs: (spec.npcs ?? []).map(n => ({ ...n, x: n.x + dx, y: n.y + dy })),
  };
}

/** What `buildTownScope` hands back, structurally — the ring needs only the
 *  built config and the primary's play, so this stays a LEAF on the type graph
 *  (no import of town-play-game.ts, whose `BuiltTownScope` satisfies it). */
export interface ClusterWindowInput {
  spec: { config: TownPlayConfig };
  play: TownPlay;
}

/** The composed walking window: the play the session runs (the primary's, with
 *  the composite stage swapped in) and the primary-town → window-coords shift
 *  the caller applies to its GROUND samplers. `cluster: 0` ⇒ the input play
 *  back, shift {0,0}. */
export interface ClusterWindow {
  play: TownPlay;
  windowShift: { x: number; y: number };
}

/** Metres of the default walking window (the composite manifold's extent). */
const CLUSTER_WINDOW_M = 4000;

/**
 * THE WALKING WINDOW — `cluster: N` streams N neighbour hamlets into the SAME
 * session (the window on the chart goes beyond one town): each neighbour is a
 * full living town at a walkable offset, its stage translated + merged with the
 * primary's. The primary keeps quests/cast/goods.
 *
 * This is the ONE definition of the ring. It was born inside world-lab's
 * `bootLivingTown` (quest-boot.ts), which made a cluster world unreachable from
 * any headless boot — `headless/text-quest.ts` played `built.play` as-is, so
 * `npm run world:text` / `npm run arc:run` could not boot one at all. Both are
 * now callers (trade-topology-round.md, deviation D-1).
 *
 * 🔒 S2b: the window comes back with its caravan line UNBOUND. Composing a
 * cluster no longer decides WHO trades with whom — the engine does, at the
 * first caravan bucket, by landed cost (`chooseTradePartner`). See the note at
 * the return.
 */
export function buildClusterWindow(
  built: ClusterWindowInput,
  opts?: { window?: number },
): ClusterWindow {
  const clusterN = Math.max(0, Math.min(4, Math.floor(built.spec.config.cluster ?? 0)));
  if (clusterN <= 0) return { play: built.play, windowShift: { x: 0, y: 0 } };

  const WINDOW = opts?.window ?? CLUSTER_WINDOW_M; // metres — a comfortable walking window
  const primaryAt = { x: WINDOW * 0.35, y: WINDOW * 0.35 };
  const windowShift = {
    x: primaryAt.x - built.play.stage.center.x,
    y: primaryAt.y - built.play.stage.center.y,
  };
  // Deterministic hamlet ring, ~1.1-1.7 km out — demo-walkable (REAL
  // region spacing is a day's walk; the window is the mechanism, the
  // distances are content).
  const neighbors: ClusterMember[] = [];
  for (let i = 0; i < clusterN; i++) {
    // THE PER-HAMLET KNOB (`world.hamlets[i]`, user call U-1): the SAME
    // TownPlayConfig the primary takes, per ring seat, spread OVER the
    // default — absent ⇒ the byte-identical ring that shipped.
    const nPlay = buildTownPlay({
      seed: built.spec.config.seed + 101 + i * 37,
      key: `hamlet-${i + 1}`,
      startPop: 60,
      days: 160,
      questCount: 0,
      ...(built.spec.config.hamlets?.[i] ?? {}),
    });
    const ang = (i / clusterN) * Math.PI * 1.4 + 0.4;
    const r = 1100 + 300 * i;
    neighbors.push({
      stage: nPlay.stage,
      at: { x: primaryAt.x + Math.cos(ang) * r, y: primaryAt.y + Math.sin(ang) * r },
      tag: `n${i + 1}`,
      // Reserved house range → neighbor residents keep the resident id
      // PROTOCOL, so the host's dialogue layer gives them real minds.
      houseBase: 1000 * (i + 1),
      // Its live context — the composite stage resolves a neighbor
      // resident's OWN books/geometry through it (TownStage.cluster).
      play: nPlay,
    });
  }
  const windowSpec = widenSpecWindow(
    built.play.stage.spec, built.play.stage.center, primaryAt, WINDOW, WINDOW,
  );
  const composite = clusterStages(
    windowSpec,
    { stage: built.play.stage, at: primaryAt, tag: "t0" },
    neighbors,
  );
  // 🔒 S2b — THE RING NO LONGER BINDS. What stood here was a NEAREST-BIND: the
  // caravan line was aimed at the closest hamlet by `Math.hypot`, at boot, with
  // no price and no books read — "who" decided twice, in two apps, by distance
  // alone (S0's confirmed gap). The engine now chooses, at the first caravan
  // bucket, by LANDED COST (`chooseTradePartner`, quest-host.ts). So a freshly
  // composed window comes back UNBOUND: `route.partnerAt` undefined and
  // `route.partnerKey` still `away:<seed>` — the honest marker of a line with
  // no partner read yet — until that first bucket edge.
  //
  // The depot lift moved too: it is `windowFramedTrade`'s job now (ONE place
  // that knows the window frame from the primary's), which is also what lets
  // the engine enumerate partners in window coordinates and bind correctly.
  return { play: { ...built.play, stage: composite }, windowShift };
}
