/**
 * 🌳 TREES THAT STAND IN THE WAY — the pure predicate (user, 2026-09-06).
 *
 *   *"The main issue with it is that nearby trees can block the view. Maybe
 *    render them as outlines if they're blocking the camera."*
 *
 * At the baked orbit pose (`orbit-pose.ts`: pitch 0.5, frame 1, lift 0, ring
 * 0.5) a founding's camera stands 28.2 m out and 15.4 m up from a 15 m frame,
 * inside a 30 m relevance ring holding ~50 oaks. An oak is 23.8 m tall and
 * fills 79 % of the viewport height at that range, so ONE of them standing on
 * the sight line hides the whole site.
 *
 * ⚖️ WHAT THIS MODULE IS, AND IS NOT.
 *  • It is RENDER-ONLY and PER-VIEWER ([[feedback_lod_per_camera]]): the answer
 *    depends entirely on where the local camera is, so it can never ride the
 *    wire, never reach the sim, and never decide anything but a fidelity.
 *  • It is PURE — no THREE, no host, no session. The driver owns the camera and
 *    the focus and calls this; the host owns the tier it forces. Written here
 *    so the geometry can be pinned without booting either.
 *  • It decides WHICH bodies occlude. What that then LOOKS like is the tier
 *    machinery's business (quest-host `setOccluders` forces the `stick` rung
 *    through the ordinary re-tier drain, and render3d draws that rung's
 *    silhouette rim-only). There is no second model path anywhere.
 *
 * The measure is a SEGMENT-TO-SEGMENT distance: the sight line camera→focus
 * against the tree's own vertical axis (ground → standing height). A plan-view
 * test would flag every herb the camera looks over; a sphere test would miss a
 * trunk whose crown is above the line. Both segments may be degenerate.
 */

/** A point in one session's SIM metres. `x`/`y` are the sim plane and `z` is
 *  metres ABOVE THE SIM GROUND PLANE — the same convention `TierPoint` uses,
 *  so a driver that already computes a view point can pass it straight in. */
export interface OccPoint {
  x: number;
  y: number;
  z: number;
}

/** A body that could stand in the way: where it is on the sim plane and how
 *  tall it stands. HEIGHT COMES FROM THE HOST (`QuestHost3D.occluderCandidates`
 *  → quest-host's own `bodyHeightM`, which is the species registry scaled by
 *  the plant's live growth stage). A driver must never re-derive it: the model
 *  factory, the LOD band and this test have to agree about how tall a sapling
 *  is, and that is one rule, written once. */
export interface OccluderBody {
  id: string;
  x: number;
  y: number;
  /** Standing height in metres (a staged plant's ACTUAL height, not its adult). */
  heightM: number;
}

/** THE DIALS. One record, so "too many trees went to outline" has one place to
 *  answer it. Every threshold is a FRACTION — of the crown radius, or of the
 *  camera→focus distance — never a metre: the same rule then means the same
 *  thing for a 3 m sapling and a 24 m oak, which is exactly why
 *  `tierForProjected` states ITS hysteresis in screen fraction. */
export interface OccluderRule {
  /** Crown radius ÷ standing height. No source declares a crown width
   *  (`products.ts` gives `bodyHeightM` and nothing wider), so it is derived:
   *  0.30 puts a mature oak's crown at 7.1 m radius / 14 m across, which is the
   *  spread the flora field draws. */
  crownFrac: number;
  /** Below this, a body is scenery underfoot, not a wall. An early-out only —
   *  the 3-D test already refuses a herb (a 0.4 m axis can only reach the sight
   *  line within ~0.7 m of the focus, and its crown radius is 0.12 m). */
  minHeightM: number;
  /** Clearance under `crownR × enterFrac` ⇒ it starts occluding… */
  enterFrac: number;
  /** …and it keeps occluding until the clearance passes `crownR × exitFrac`.
   *  THE HYSTERESIS. Every flip costs a model rebuild through the re-tier
   *  drain, so a tree grazing the edge of the sight line as the camera orbits
   *  must never flap — the same law the tier bands run on. */
  exitFrac: number;
  /** How far along camera→focus the closest approach may sit before the body
   *  stops counting as "in the way": 1 would be the focus itself, and a tree
   *  standing ON the site is the SUBJECT, not an obstruction. */
  nearEnter: number;
  /** …and its hysteresis partner (a tree already outlined holds a little
   *  longer, so drifting across the focus does not flicker). */
  nearExit: number;
}

export const OCCLUDER_RULE: Readonly<OccluderRule> = {
  crownFrac: 0.3,
  minHeightM: 2,
  enterFrac: 0.9,
  exitFrac: 1.15,
  nearEnter: 0.92,
  nearExit: 0.97,
};

/** The radius the crown is treated as filling, from the standing height. */
export function crownRadiusM(heightM: number, rule: OccluderRule = OCCLUDER_RULE): number {
  return Math.max(0, heightM) * rule.crownFrac;
}

/** How close the tree's AXIS comes to the sight line, and WHERE along that line
 *  (0 = at the camera, 1 = at the focus).
 *
 *  Closed-form segment↔segment: clamp the unconstrained line-line solution into
 *  the two unit intervals and re-solve each parameter against the other, which
 *  is the standard two-pass fix for the parallel/endpoint cases. Both segments
 *  may collapse to points (a camera sitting on its focus, a zero-height body) —
 *  those fall out of the `≤ 0` guards rather than dividing by zero.
 *
 *  Returns null when the sight line has no length at all, i.e. there is no
 *  "in front of" to be on. */
export function occlusionOf(
  cam: OccPoint,
  focus: OccPoint,
  tree: OccluderBody,
): { clearM: number; u: number } | null {
  // The sight line C→F…
  const dx = focus.x - cam.x;
  const dy = focus.y - cam.y;
  const dz = focus.z - cam.z;
  const dd = dx * dx + dy * dy + dz * dz;
  if (!(dd > 0)) return null;
  // …and the tree's axis, straight up from the ground under it.
  const h = Math.max(0, tree.heightM);
  // r = C - A, where A is the tree's foot.
  const rx = cam.x - tree.x;
  const ry = cam.y - tree.y;
  const rz = cam.z - 0;
  // The axis is (0, 0, h): every dot product with it collapses to a z term.
  const b = dz * h; // d · e
  const c = dx * rx + dy * ry + dz * rz; // d · r
  const f = rz * h; // e · r
  const ee = h * h;
  let u: number; // along the sight line
  let v: number; // along the tree axis
  const denom = dd * ee - b * b;
  if (ee <= 0) {
    // A zero-height body: the axis is a point at its foot.
    v = 0;
    u = -c / dd;
  } else if (!(Math.abs(denom) > 1e-9 * dd * ee)) {
    // 🚨 PARALLEL — and the guard is RELATIVE, not an absolute epsilon. A camera
    // looking straight down a trunk makes `denom` the difference of two products
    // that are equal in exact arithmetic (here ~9e5 each), so in floating point
    // it lands anywhere from 0 to ~1e-9 — and the numerator vanishes with it. An
    // absolute `< 1e-12` test lets 0/1e-10 through as 0 and, worse, 0/0 through
    // as NaN, which would put a tree's clearance at NaN and drop it silently.
    // Start at the sight line's own start and let the two passes below recover.
    u = 0;
    v = f / ee;
  } else {
    u = (b * f - c * ee) / denom;
    v = (dd * f - b * c) / denom;
  }
  u = u < 0 ? 0 : u > 1 ? 1 : u;
  // Re-solve v against the clamped u, then u against the clamped v — the two
  // passes are what make an endpoint case exact instead of merely close.
  if (ee > 0) {
    v = (f + b * u) / ee;
    v = v < 0 ? 0 : v > 1 ? 1 : v;
    u = (b * v - c) / dd;
    u = u < 0 ? 0 : u > 1 ? 1 : u;
  }
  const px = cam.x + dx * u - (tree.x + 0);
  const py = cam.y + dy * u - (tree.y + 0);
  const pz = cam.z + dz * u - h * v;
  return { clearM: Math.hypot(px, py, pz), u };
}

export interface OccludingOpts {
  /** A body the viewer is pointing at / has selected: NEVER an occluder. It has
   *  to stay fully drawn and selectable — the whole reason the orbit dwell
   *  exists under the builder hold is to pick the thing under the cursor. */
  exempt?: string | null;
  rule?: OccluderRule;
}

/**
 * The bodies occluding the view of `focus` from `cam`, given which ones were
 * occluding LAST frame (`prev` — the hysteresis's only state).
 *
 * A body occludes when its axis comes within its crown radius of the sight
 * line AND its closest approach is on the camera's side of the focus. Both
 * thresholds widen once a body is already occluding, so nothing flickers at
 * either edge.
 *
 * Allocates one Set per call over a handful of candidates; the arithmetic is a
 * few dozen multiplies per body, which is why this runs every frame while the
 * candidate LIST is refreshed lazily (trees do not move).
 */
export function occludingBodies(
  cam: OccPoint,
  focus: OccPoint,
  trees: readonly OccluderBody[],
  prev: ReadonlySet<string>,
  opts: OccludingOpts = {},
): Set<string> {
  const rule = opts.rule ?? OCCLUDER_RULE;
  const exempt = opts.exempt ?? null;
  const out = new Set<string>();
  for (const t of trees) {
    if (t.id === exempt) continue;
    if (!(t.heightM >= rule.minHeightM)) continue;
    const hit = occlusionOf(cam, focus, t);
    if (!hit) continue;
    const held = prev.has(t.id);
    const r = crownRadiusM(t.heightM, rule) * (held ? rule.exitFrac : rule.enterFrac);
    if (!(hit.clearM < r)) continue;
    if (!(hit.u > 0 && hit.u < (held ? rule.nearExit : rule.nearEnter))) continue;
    out.add(t.id);
  }
  return out;
}

/** Did the set actually move? The driver pushes only on a change, and the host
 *  only re-tiers what changed — a set rebuilt every frame is not news. */
export function sameOccluders(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}
