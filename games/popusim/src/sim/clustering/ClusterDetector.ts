/**
 * Trait clustering — Phase C0: static cluster detection (diagnostics only).
 *
 * Binds the prototype in `planning-docs/cluster-core.mjs` to the live runtime
 * `World`/`Trait`/`Vector` objects. Produces a `ClusterReport`: a partition of
 * trait keys into clusters (= trait-sets that must be tracked jointly), the
 * membership/terminal-exit traits, and the resource-gated cross-edges that a
 * future split phase can deactivate.
 *
 * This phase is PURE ANALYSIS. It never mutates the world or changes simulation
 * behavior. It runs behind the `clustering` toggle (see WorkerSim) so it can be
 * inspected and stress-tested for edge cases before any behavioral phase (C1+)
 * is built on top of it.
 *
 * The design, criterion, and validation are in
 * `planning-docs/clustering-design.md`. The coupling rules implemented here:
 *   - Progress P on trait Y (internal): couple {Y} ∪ apply ∪ remove ∪
 *       seek-traits ∪ require/forbid.
 *   - Transmit T on trait Y (aggregate): couple apply ∪ remove ∪ seek ∪
 *       require/forbid among THEMSELVES, not the source Y.
 *   - Modifier owned by X, vector-overlaps a rate owned by Y: couple X–Y.
 *   - contact_mod owned by X: couple X to the apply-traits of sheds carrying a
 *       matching vector.
 * Terminal exits (death without a removal primitive) are detected by
 * reachability: membership from startpop seeds, terminality verified by probing
 * whether any re-application rule's seek admits a correlation-carrying state.
 */

// ---- minimal runtime shapes (we only read the post-`init` *_keys fields) ----

interface SeekRT {
	trait_has_keys?: string[];
	trait_not_keys?: string[];
	mult?: number;
}
interface VectorRT {
	key: string;
	seek?: SeekRT[];
}
interface RuleRT {
	trait_keys?: string[];   // resolved `apply`
	cure_keys?: string[];    // resolved `remove`
	vector_keys?: string[];
	require_keys?: string[]; // Progress only
	forbid_keys?: string[];  // Progress only
}
interface ModRT {
	vector_keys?: string[];
	mult?: number | string;
	trait_keys?: string[];   // mod.apply
	cure_keys?: string[];    // mod.remove
}
interface TraitRT {
	key: string;
	transmit?: RuleRT[];
	progress?: RuleRT[];
	produce?: RuleRT[];
	consume?: RuleRT[];
	transmit_mod?: ModRT[];
	progress_mod?: ModRT[];
	contact_mod?: ModRT[];
	produce_mod?: ModRT[];
	consume_mod?: ModRT[];
}
interface PopInitRT { size?: number; apply?: string[]; }
interface SiteRT { startpops?: PopInitRT[]; transmit?: RuleRT[]; }
interface WorldRT {
	traits: TraitRT[];
	vectors: VectorRT[];
	sites: SiteRT[];
}

// ---- public result shape ----------------------------------------------------

/** A resource-gated cross-edge: deactivates when its resource drives the
 * modifier multiplier to 1 (the story-scenario split lever). */
export interface GateEdge {
	owner: string;       // trait carrying the modifier
	rateOwner: string;   // trait owning the modified rate
	kind: string;        // 'transmit' | 'progress' | 'produce' | 'consume' | 'contact'
	resource: string;    // resource whose value is the multiplier
}

export interface ClusterReport {
	/** Trait-key clusters, largest first. Trait-sets that must be tracked jointly. */
	clusters: string[][];
	/** Membership traits derived from startpop seeds (e.g. `alive`). */
	membership: string[];
	/** Subset of membership verified terminal by reachability. */
	terminal: string[];
	/** Traits decremented out via a terminal-exit rule (not coupled). */
	exitTraits: string[];
	/** Resource-gated couplings — candidates for dynamic splitting (Phase C3). */
	gateEdges: GateEdge[];
	traitCount: number;
}

// ---- helpers ----------------------------------------------------------------

const keysOf = (a?: string[]): string[] => (a && a.length ? a : []);

class UnionFind {
	private p: Record<string, string> = {};
	has(x: string): boolean { return this.p[x] !== undefined; }
	add(x: string): void { if (this.p[x] === undefined) this.p[x] = x; }
	find(x: string): string {
		if (this.p[x] === undefined) this.p[x] = x;
		while (this.p[x] !== x) { this.p[x] = this.p[this.p[x]]; x = this.p[x]; }
		return x;
	}
	union(a: string, b: string, valid: Set<string>): void {
		if (!valid.has(a) || !valid.has(b)) return;
		const ra = this.find(a), rb = this.find(b);
		if (ra !== rb) this.p[ra] = rb;
	}
}

// ---- detector ---------------------------------------------------------------

export function detectClusters(
	world: WorldRT,
	opts: { exitAware?: boolean; resourceValues?: Record<string, number>; band?: number } = {},
): ClusterReport {
	const exitAware = opts.exitAware !== false;
	// When resourceValues is supplied we compute the ACTIVE-edge graph (C3): a
	// resource-gated modifier is inert when its value ≈ 1 (within `band`), so it
	// does not couple. Numeric multipliers are likewise inert at exactly 1.
	// Without resourceValues every gate edge is treated active (the STRUCTURAL
	// graph used for the conservative boot partition).
	const useActive = opts.resourceValues !== undefined;
	const band = opts.band ?? 1e-9;
	const modActive = (mult: number | string | undefined): boolean => {
		if (!useActive) return true;
		if (typeof mult === 'string') {
			const v = opts.resourceValues![mult];
			return v === undefined ? true : Math.abs(v - 1) > band;
		}
		return Math.abs((Number(mult) || 0) - 1) > band;
	};
	const traits = world.traits;
	const traitKeys = new Set<string>(traits.map(t => t.key));

	// vector -> seeks  (replicates Syndrome.getSeekMod semantics)
	const vectorSeeks: Record<string, SeekRT[]> = {};
	for (const v of world.vectors) vectorSeeks[v.key] = v.seek || [];
	const seekTraitsOf = (vecKeys: string[]): string[] => {
		const s = new Set<string>();
		for (const vk of vecKeys) for (const sk of (vectorSeeks[vk] || [])) {
			for (const k of keysOf(sk.trait_has_keys)) s.add(k);
			for (const k of keysOf(sk.trait_not_keys)) s.add(k);
		}
		return [...s];
	};
	const seekAdmits = (held: Set<string>, vecKeys: string[]): boolean => {
		let w = 1;
		for (const vk of vecKeys) for (const sk of (vectorSeeks[vk] || [])) {
			let apply = false;
			for (const k of keysOf(sk.trait_has_keys)) if (held.has(k)) { apply = true; break; }
			if (!apply) for (const k of keysOf(sk.trait_not_keys)) if (!held.has(k)) { apply = true; break; }
			if (apply) w *= (sk.mult ?? 1);
		}
		return w > 0;
	};

	// index rate owners (for modifier matching) and vector apply-traits (contact)
	const vectorApplyTraits: Record<string, Set<string>> = {};
	const addVecApply = (vecKeys: string[], applyKeys: string[]): void => {
		for (const vk of vecKeys) { (vectorApplyTraits[vk] ??= new Set()); for (const a of applyKeys) vectorApplyTraits[vk].add(a); }
	};
	const rateOwners: Record<'transmit' | 'progress' | 'produce' | 'consume', Record<string, Set<string>>> =
		{ transmit: {}, progress: {}, produce: {}, consume: {} };
	const addOwner = (kind: keyof typeof rateOwners, vecKeys: string[], owner: string): void => {
		for (const vk of vecKeys) ((rateOwners[kind][vk] ??= new Set())).add(owner);
	};

	// every transmit/progress rule, used by terminality re-application probe
	const rules: { apply: string[]; remove: string[]; vec: string[] }[] = [];

	for (const t of traits) {
		for (const r of keysOf2(t.transmit)) { addVecApply(keysOf(r.vector_keys), keysOf(r.trait_keys)); addOwner('transmit', keysOf(r.vector_keys), t.key); rules.push({ apply: keysOf(r.trait_keys), remove: keysOf(r.cure_keys), vec: keysOf(r.vector_keys) }); }
		for (const r of keysOf2(t.progress)) { addVecApply(keysOf(r.vector_keys), keysOf(r.trait_keys)); addOwner('progress', keysOf(r.vector_keys), t.key); rules.push({ apply: keysOf(r.trait_keys), remove: keysOf(r.cure_keys), vec: keysOf(r.vector_keys) }); }
		for (const r of keysOf2(t.produce)) addOwner('produce', keysOf(r.vector_keys), t.key);
		for (const r of keysOf2(t.consume)) addOwner('consume', keysOf(r.vector_keys), t.key);
	}
	for (const s of world.sites) for (const r of keysOf2(s.transmit)) addVecApply(keysOf(r.vector_keys), keysOf(r.trait_keys));

	// ---- 1. membership from startpop seeds ----
	const seeds = world.sites
		.flatMap(s => s.startpops || [])
		.map(p => keysOf(p.apply))
		.filter(a => a.length > 0);
	let membership = new Set<string>();
	if (seeds.length) membership = new Set(seeds[0].filter(k => seeds.every(s => s.includes(k))));

	// ---- 2. verify terminality by reachability of re-application ----
	const absorbTags = [...traitKeys].filter(k => k === 'dead' || k.startsWith('not_'));
	const livingSample = [...traitKeys].filter(k => !membership.has(k) && k !== 'dead' && !k.startsWith('not_')).slice(0, 3);
	const terminal = new Set<string>();
	for (const m of membership) {
		const reApply = rules.filter(r => r.apply.includes(m));
		const resurrects = reApply.some(r => {
			const probes = [new Set(absorbTags), ...livingSample.map(x => new Set([...absorbTags, x]))];
			return probes.some(held => seekAdmits(held, r.vec));
		});
		if (!resurrects) terminal.add(m);
	}
	const isExitRule = (remove: string[]): boolean => exitAware && remove.some(k => terminal.has(k));

	// ---- 3. union-find coupling ----
	const uf = new UnionFind();
	for (const k of traitKeys) uf.add(k);
	const exitTraits = new Set<string>();
	const gateEdges: GateEdge[] = [];

	for (const t of traits) {
		for (const r of keysOf2(t.progress)) {
			const apply = keysOf(r.trait_keys), remove = keysOf(r.cure_keys);
			const seek = seekTraitsOf(keysOf(r.vector_keys));
			const gates = [...keysOf(r.require_keys), ...keysOf(r.forbid_keys)];
			if (isExitRule(remove)) {
				for (const k of remove) exitTraits.add(k);
				for (const a of apply) uf.union(t.key, a, traitKeys);
				for (const g of gates) uf.union(t.key, g, traitKeys);
			} else {
				for (const k of [...apply, ...remove, ...seek, ...gates]) uf.union(t.key, k, traitKeys);
			}
		}
		for (const r of keysOf2(t.transmit)) {
			const apply = keysOf(r.trait_keys), remove = keysOf(r.cure_keys);
			const seek = seekTraitsOf(keysOf(r.vector_keys));
			const exit = isExitRule(remove);
			if (exit) for (const k of remove) exitTraits.add(k);
			const group = exit ? [...apply] : [...apply, ...remove, ...seek];
			for (let i = 1; i < group.length; i++) uf.union(group[0], group[i], traitKeys);
		}
		const modCouple = (mods: ModRT[] | undefined, kind: 'transmit' | 'progress' | 'produce' | 'consume'): void => {
			for (const m of (mods || [])) {
				const resource = typeof m.mult === 'string' ? m.mult : undefined;
				const active = modActive(m.mult);
				for (const vk of keysOf(m.vector_keys)) for (const owner of (rateOwners[kind][vk] || [])) {
					if (active) uf.union(t.key, owner, traitKeys);
					if (resource && owner !== t.key) gateEdges.push({ owner: t.key, rateOwner: owner, kind, resource });
				}
				if (!active) continue; // apply/remove side-effects also gated by the same multiplier
				for (const a of keysOf(m.trait_keys)) uf.union(t.key, a, traitKeys);
				for (const r of keysOf(m.cure_keys)) uf.union(t.key, r, traitKeys);
			}
		};
		modCouple(t.transmit_mod, 'transmit');
		modCouple(t.progress_mod, 'progress');
		modCouple(t.produce_mod, 'produce');
		modCouple(t.consume_mod, 'consume');
		for (const m of (t.contact_mod || [])) {
			const resource = typeof m.mult === 'string' ? m.mult : undefined;
			const active = modActive(m.mult);
			for (const vk of keysOf(m.vector_keys)) for (const a of (vectorApplyTraits[vk] || [])) {
				if (active) uf.union(t.key, a, traitKeys);
				if (resource && a !== t.key) gateEdges.push({ owner: t.key, rateOwner: a, kind: 'contact', resource });
			}
			if (!active) continue;
			for (const a of keysOf(m.trait_keys)) uf.union(t.key, a, traitKeys);
			for (const r of keysOf(m.cure_keys)) uf.union(t.key, r, traitKeys);
		}
	}

	// collect components
	const comps: Record<string, string[]> = {};
	for (const k of traitKeys) (comps[uf.find(k)] ??= []).push(k);
	const clusters = Object.values(comps).sort((a, b) => b.length - a.length);

	// keep only gate edges whose endpoints landed in the same cluster (they are
	// the live couplings holding that cluster together)
	const clusterOf: Record<string, number> = {};
	clusters.forEach((c, i) => c.forEach(k => { clusterOf[k] = i; }));
	const dedup = new Set<string>();
	const liveGates = gateEdges.filter(e => {
		if (clusterOf[e.owner] !== clusterOf[e.rateOwner]) return false;
		const sig = `${e.owner}|${e.rateOwner}|${e.kind}|${e.resource}`;
		if (dedup.has(sig)) return false;
		dedup.add(sig);
		return true;
	});

	return {
		clusters,
		membership: [...membership],
		terminal: [...terminal],
		exitTraits: [...exitTraits],
		gateEdges: liveGates,
		traitCount: traitKeys.size,
	};
}

/** non-empty array guard that also narrows to RuleRT[] */
function keysOf2<T>(a: T[] | undefined): T[] { return a && a.length ? a : []; }

/** One-line-per-cluster summary for logging. */
export function formatClusterReport(r: ClusterReport): string {
	const lines: string[] = [];
	const multi = r.clusters.filter(c => c.length > 1);
	const singles = r.clusters.length - multi.length;
	lines.push(`[clustering] ${r.traitCount} traits -> ${r.clusters.length} clusters (${multi.length} multi + ${singles} singletons)`);
	lines.push(`[clustering] membership={${r.membership.join(',')}} terminal={${r.terminal.join(',')}}`);
	for (const c of multi) lines.push(`[clustering]   [${c.length}] ${c.slice().sort().join(', ')}`);
	if (r.gateEdges.length) lines.push(`[clustering] resource-gated edges: ${r.gateEdges.map(e => `${e.owner}->${e.rateOwner}(${e.resource})`).join(', ')}`);
	return lines.join('\n');
}
