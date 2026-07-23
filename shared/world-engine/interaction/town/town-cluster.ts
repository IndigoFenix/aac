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
import type { TownPlay } from "./town-play.js";
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
    // joins when their carts get window-frame routes).
    trade: primary.stage.trade,
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
