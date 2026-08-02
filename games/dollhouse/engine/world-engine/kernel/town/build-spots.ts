// shared/world-engine/kernel/town/build-spots.ts
//
// WHERE BUILDING CAN HAPPEN (⑦ — one build button, then the ground answers).
//
// The board used to carry every construction option at once: one button per
// buildable structure, per room kind, per room that could come down. That is a
// menu of verbs with no object — the player picks "build farm" and the town
// decides where. Now the board carries ONE word, `build`, and pressing it lights
// the GROUND: every plot a structure could rise on, every building that could
// grow or come down. The player settles on a spot and THAT spot's menu opens —
// the object is chosen first, so the options are only ever the ones that spot
// can really take.
//
// This module is the pure half: given the lot candidates the founding
// enumeration already produces (one per structure type per street slot) and the
// buildings that currently offer acts, it collapses them into the SPOT SET the
// overlay paints and the dwell hit-tests. It knows nothing about boards,
// renderers or sessions — the host feeds it live geometry and shapes the
// presenter view from what comes back.
//
// THE SPOT IS THE SLOT. Structure footprints differ (a farm is not a cottage),
// so the same street frontage yields a different rect per type. One highlight
// per slot — its rect the union of what could stand there — keeps the ground
// readable: the player aims at a PLACE, and the menu that opens names every
// structure that fits it.
//
// A BUILDING IS NOT ONE SPOT — IT IS ITS ROOMS AND ITS ROOM-SHAPED GAPS (user
// law). Aiming at a whole house and getting a list of every room that could
// come down is the same menu-of-verbs-with-no-object the build word was meant
// to abolish, one level in. So a building offers:
//   • one spot per standing ROOM — its menu is what can be done to THAT room,
//     which is why "break the bedroom" appears only while the bedroom is lit;
//   • one spot per GROWTH AREA — the ground a new room could take, whether
//     that is garden outside the walls or a band cut off an open floor inside.
// Growth areas collapse the way lots do: the same PLACE fits several room
// kinds, so overlapping candidates merge into one highlight that names them
// all, each keeping the exact geometry its order pins to.

/** A lot candidate as the founding enumeration hands it back, lifted to
 *  WORLD coords (the host applies the town center). */
export interface BuildSpotLot {
  /** StructureSpec type this candidate was enumerated for. */
  type: string;
  /** The street frontage slot claimed — the spot's identity. */
  slot: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A standing building that currently offers construction acts (grow a room,
 *  bring one down). World rect = its footprint. */
export interface BuildSpotBuilding {
  /** The construction-delta key (`h_3`, `f_2`, `w_7`). */
  key: string;
  /** Which plan array it lives in, and where. */
  focus: { kind: "house" | "work"; index: number };
  x: number;
  y: number;
  w: number;
  h: number;
}

/** ONE STANDING ROOM of a building — its own aim, its own menu. */
export interface BuildSpotRoom {
  /** The building's construction-delta key (`h_3`, `f_2`). */
  key: string;
  focus: { kind: "house" | "work"; index: number };
  /** The room id in the delta-applied plan (`h_3_r1`, `f_2_i0`). */
  room: string;
  /** The room's kind — the word its menu speaks ("break bedroom"). */
  roomKind: string;
  /** World footprint of the room. */
  x: number;
  y: number;
  w: number;
  h: number;
}

/** ONE ROOM KIND that could rise on a growth area, with the exact validated
 *  geometry its order pins to. The area is the aim; this is what it can
 *  become. */
export interface BuildGrowOffer {
  /** Room kind ("bedroom", "kitchen") — the word the menu speaks. */
  kind: string;
  /** The annex cluster the house path orders through, when there is one. */
  cluster?: string;
  /** Opaque here (kernel/town/construction owns its shape): the candidate
   *  the order stakes, so what rises is the place that was lit. */
  candidate: unknown;
}

/** GROUND A ROOM COULD TAKE — one candidate rect as the enumeration hands it
 *  back, before overlapping ones collapse into a single highlight. */
export interface BuildSpotGrowIn {
  /** The building the room would join. */
  key: string;
  focus: { kind: "house" | "work"; index: number };
  offer: BuildGrowOffer;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** WORK IN PROGRESS — an ordered-but-unbuilt plot, a room going up, a room
 *  coming down. Aiming at one opens its DECONSTRUCTION menu: the only thing
 *  you can do to work in progress is call it off. */
export interface BuildSpotSite {
  /** The ConstructionSite id the stage emitted (`site_w_3`, `site_pa_7`…). */
  site: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface BuildSpot {
  /** Stable id — the overlay, the board and the dwell all key on this. */
  id: string;
  kind: "lot" | "building" | "room" | "grow" | "site";
  /** The highlight rect, world coords. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** LOT: the frontage slot, and every structure type that fits it. */
  slot?: number;
  types?: string[];
  /** BUILDING / ROOM / GROW: which building the spot's menu belongs to. */
  key?: string;
  focus?: { kind: "house" | "work"; index: number };
  /** ROOM: the room this spot IS, and its kind. */
  room?: string;
  roomKind?: string;
  /** GROW: every room kind this ground could take, best-first. */
  offers?: BuildGrowOffer[];
  /** SITE: the construction site this spot would call off. */
  site?: string;
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const overlaps = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

const contains = (r: Rect, x: number, y: number): boolean =>
  x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;

/** A lot spot's id — the slot IS the identity, so the same ground keeps the
 *  same id as the catalog that fits it changes. */
export function lotSpotId(slot: number): string {
  return `lot:${slot}`;
}

/** A building spot's id — its delta key, which outlives plan-index shuffles. */
export function buildingSpotId(key: string): string {
  return `bld:${key}`;
}

/** A work-in-progress spot's id — the construction site's own id. */
export function siteSpotId(site: string): string {
  return `wip:${site}`;
}

/** A room spot's id — its building key and the room id, both of which outlive
 *  plan-index shuffles. */
export function roomSpotId(key: string, room: string): string {
  return `room:${key}:${room}`;
}

/** A growth area's id. The ground has no name of its own, so its identity is
 *  the building it would join plus its own rect, quantized — stable while the
 *  candidate set is, which is what stops the highlight crawling between
 *  frames (and what stops a settled selection sliding onto other ground). */
export function growSpotId(key: string, r: Rect): string {
  const q = (n: number) => Math.round(n * 4) / 4;
  return `grow:${key}:${q(r.x)},${q(r.y)},${q(r.w)},${q(r.h)}`;
}

/** How much two candidate rects must share before they are treated as ONE
 *  place: the overlap, as a fraction of the SMALLER rect. A kitchen band and
 *  a bedroom band cut off the same wall are the same place at slightly
 *  different depths (they merge); a rear band and a side band of one room
 *  meet only in a corner (they do not). */
const GROW_MERGE_SHARE = 0.6;

const intersectArea = (a: Rect, b: Rect): number =>
  Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) *
  Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));

const unionRect = (a: Rect, b: Rect): Rect => {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
};

/**
 * Collapse candidate growth rects into the AREAS the ground shows: the same
 * place fits several room kinds, and lighting one wash per kind would stack
 * near-identical rectangles on top of each other and make the ground
 * unreadable.
 *
 * Greedy over the input order (the caller sorts, so this is deterministic):
 * each candidate joins the first area it substantially overlaps, widening it
 * to the union; otherwise it opens a new one. Every kind keeps its OWN exact
 * geometry in `offers` — the union is what the player aims at, never what
 * gets built — and the first candidate for a kind wins, since the enumeration
 * hands them back best-first.
 */
export function growAreas(cands: readonly BuildSpotGrowIn[]): BuildSpot[] {
  const areas: Array<{ key: string; focus: BuildSpotGrowIn["focus"]; rect: Rect; offers: BuildGrowOffer[] }> = [];
  for (const c of cands) {
    const rect: Rect = { x: c.x, y: c.y, w: c.w, h: c.h };
    const area = areas.find(
      (a) =>
        a.key === c.key &&
        intersectArea(a.rect, rect) >=
          GROW_MERGE_SHARE * Math.min(a.rect.w * a.rect.h, rect.w * rect.h) - 1e-9,
    );
    if (!area) {
      areas.push({ key: c.key, focus: c.focus, rect, offers: [c.offer] });
      continue;
    }
    area.rect = unionRect(area.rect, rect);
    if (!area.offers.some((o) => o.kind === c.offer.kind)) area.offers.push(c.offer);
  }
  return areas.map((a) => ({
    id: growSpotId(a.key, a.rect),
    kind: "grow" as const,
    ...a.rect,
    key: a.key,
    focus: a.focus,
    offers: a.offers,
  }));
}

/**
 * The spots the ground shows right now, in a stable order — sites, growth
 * areas, rooms by key, lots by slot, then whole buildings by key. A set that
 * flickers between frames would make the highlights crawl, and the order is
 * also the tie-break `spotAt` falls back on when two rects match exactly.
 *
 * `busy` is the ground already spoken for by a live designation: a staked plot
 * is not offered a second time, and its own site marking is what the player
 * sees there instead.
 */
export function buildSpots(input: {
  lots: readonly BuildSpotLot[];
  buildings: readonly BuildSpotBuilding[];
  /** Standing rooms, one spot each (the building decomposed). */
  rooms?: readonly BuildSpotRoom[];
  /** Candidate growth rects, pre-collapse — `growAreas` merges them. */
  grow?: readonly BuildSpotGrowIn[];
  /** Work already under way. Listed FIRST so it wins the aim over the lot or
   *  building it stands on — what you can do to a half-built thing is not
   *  what you can do to a finished one. */
  sites?: readonly BuildSpotSite[];
  busy?: readonly Rect[];
}): BuildSpot[] {
  const busy = input.busy ?? [];
  // LOTS collapse per slot: the union rect covers every orientation a
  // structure could take there, so the highlight never sits under a
  // building the menu could actually raise.
  const bySlot = new Map<number, { rect: Rect; types: Set<string> }>();
  for (const lot of input.lots) {
    const found = bySlot.get(lot.slot);
    if (!found) {
      bySlot.set(lot.slot, { rect: { x: lot.x, y: lot.y, w: lot.w, h: lot.h }, types: new Set([lot.type]) });
      continue;
    }
    found.types.add(lot.type);
    const x0 = Math.min(found.rect.x, lot.x);
    const y0 = Math.min(found.rect.y, lot.y);
    const x1 = Math.max(found.rect.x + found.rect.w, lot.x + lot.w);
    const y1 = Math.max(found.rect.y + found.rect.h, lot.y + lot.h);
    found.rect = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }
  const out: BuildSpot[] = [];
  for (const s of [...(input.sites ?? [])].sort((p, q) => (p.site < q.site ? -1 : p.site > q.site ? 1 : 0))) {
    out.push({ id: siteSpotId(s.site), kind: "site", x: s.x, y: s.y, w: s.w, h: s.h, site: s.site });
  }
  // GROWTH AREAS before rooms: a band cut off an open floor lies INSIDE its
  // host, and "here a room could go" is the more specific offer of the two.
  // (Ground already staked is spoken for, exactly as a lot is.)
  for (const g of growAreas(input.grow ?? [])) {
    if (busy.some((b) => overlaps(g, b))) continue;
    out.push(g);
  }
  for (const r of [...(input.rooms ?? [])].sort((p, q) =>
    p.key === q.key ? (p.room < q.room ? -1 : p.room > q.room ? 1 : 0) : p.key < q.key ? -1 : 1,
  )) {
    out.push({
      id: roomSpotId(r.key, r.room),
      kind: "room",
      x: r.x, y: r.y, w: r.w, h: r.h,
      key: r.key,
      focus: r.focus,
      room: r.room,
      roomKind: r.roomKind,
    });
  }
  for (const slot of [...bySlot.keys()].sort((a, b) => a - b)) {
    const { rect, types } = bySlot.get(slot)!;
    if (busy.some((b) => overlaps(rect, b))) continue;
    out.push({
      id: lotSpotId(slot),
      kind: "lot",
      ...rect,
      slot,
      types: [...types].sort(),
    });
  }
  for (const b of [...input.buildings].sort((p, q) => (p.key < q.key ? -1 : p.key > q.key ? 1 : 0))) {
    out.push({
      id: buildingSpotId(b.key),
      kind: "building",
      x: b.x,
      y: b.y,
      w: b.w,
      h: b.h,
      key: b.key,
      focus: b.focus,
    });
  }
  return out;
}

/**
 * The spot a world point falls in — the SMALLEST containing one, so a
 * building standing on (or beside) an open lot wins the aim over the lot's
 * looser union rect. Ties go to the EARLIER spot, which is why sites lead
 * the list: work under way answers for its own ground. Null when the point
 * is on plain ground.
 */
export function spotAt(
  spots: readonly BuildSpot[],
  x: number,
  y: number,
): BuildSpot | null {
  let best: BuildSpot | null = null;
  let bestArea = Infinity;
  for (const s of spots) {
    if (!contains(s, x, y)) continue;
    const area = s.w * s.h;
    if (area < bestArea) {
      best = s;
      bestArea = area;
    }
  }
  return best;
}
