/**
 * Trait clustering — Phase C2a: project a scenario onto one cluster.
 *
 * Produces a runnable sub-scenario containing only a cluster's traits (plus the
 * membership traits every living unit carries, so `is_alive`-style seeks still
 * work) and the rules among them, with every trait reference filtered to that
 * set. A sub-World built from this projection evolves the cluster's MARGINAL
 * distribution using the real engine — no dynamics are re-implemented.
 *
 * Scope (C2a): independent, coupling-free clusters. Resources / actions / events
 * are dropped (the supported scenario class has none across cluster boundaries);
 * the absorbed/death decrement (C2b) and shared stockpiles (C2c) are separate
 * steps. `projectScenarioToCluster` is a pure transform on the raw scenario JSON.
 */

type Json = Record<string, unknown>;

const splitKeys = (v: unknown): string[] => {
	if (v === undefined || v === null) return [];
	if (Array.isArray(v)) return v.flatMap(splitKeys);
	return String(v).split(',').map(s => s.trim()).filter(Boolean);
};
const keep = (v: unknown, set: Set<string>): string => splitKeys(v).filter(k => set.has(k)).join(',');

/** Filter a transmit/progress/impact rule's trait references to `set`. Returns
 * null if the rule no longer does anything (empty apply AND remove). */
function projectRule(rule: Json, set: Set<string>): Json | null {
	const out: Json = { ...rule };
	for (const f of ['apply', 'remove', 'require', 'forbid'] as const) {
		if (f in rule) out[f] = keep(rule[f], set);
	}
	const apply = splitKeys(out.apply), remove = splitKeys(out.remove);
	if (apply.length === 0 && remove.length === 0) return null;
	return out;
}

function projectModifier(mod: Json, set: Set<string>): Json {
	const out: Json = { ...mod };
	for (const f of ['apply', 'remove'] as const) if (f in mod) out[f] = keep(mod[f], set);
	return out;
}

const TRANSMIT_LISTS = ['transmit', 'progress'] as const;
const IMPACT_LISTS = ['produce', 'consume'] as const;
// `contact_mod` is current; `infect_mod` is the legacy key, carried so
// pre-rename scenarios still project correctly.
const MOD_LISTS = ['transmit_mod', 'progress_mod', 'contact_mod', 'infect_mod', 'produce_mod', 'consume_mod'] as const;

function projectTrait(trait: Json, set: Set<string>): Json {
	const out: Json = { ...trait };
	// transmit/progress: filter trait refs, drop rules that no longer change traits
	for (const list of TRANSMIT_LISTS) {
		if (Array.isArray(trait[list])) {
			out[list] = (trait[list] as Json[]).map(r => projectRule(r, set)).filter((r): r is Json => r !== null);
		}
	}
	// produce/consume impacts reference a RESOURCE (the aggregate-coupling channel,
	// C2c) — keep them as-is, only filtering any side-effect apply/remove traits.
	for (const list of IMPACT_LISTS) {
		if (Array.isArray(trait[list])) {
			out[list] = (trait[list] as Json[]).map(im => {
				const o: Json = { ...im };
				for (const f of ['apply', 'remove'] as const) if (f in im) o[f] = keep(im[f], set);
				return o;
			});
		}
	}
	for (const list of MOD_LISTS) {
		if (Array.isArray(trait[list])) out[list] = (trait[list] as Json[]).map(m => projectModifier(m, set));
	}
	// combo definitions referencing dropped traits are filtered; an emptied combo
	// becomes a plain trait (its def_* lists vanish).
	for (const f of ['def_and', 'def_not', 'def_or', 'require', 'forbid'] as const) {
		if (f in trait) out[f] = keep(trait[f], set);
	}
	return out;
}

function projectVector(vec: Json, set: Set<string>): Json {
	const out: Json = { ...vec };
	if (Array.isArray(vec.seek)) {
		// drop seek entries that reference a dropped trait (an independent
		// cluster never seeks across its boundary by construction)
		out.seek = (vec.seek as Json[]).filter(sk => {
			for (const k of splitKeys(sk.trait)) if (!set.has(k)) return false;
			for (const k of splitKeys(sk.not_trait)) if (!set.has(k)) return false;
			return true;
		});
	}
	return out;
}

export interface SubScenario { scenario: Json; clusterId: number; traitKeys: string[]; }

/**
 * Project `scenario` onto the cluster `clusterTraitKeys` (∪ membership).
 */
export function projectScenarioToCluster(
	scenario: Json,
	clusterTraitKeys: Iterable<string>,
	membership: Iterable<string>,
	clusterId: number,
	/** Override the site startpop (C3 re-partition: rebuild a sub-World from the
	 * current distribution rather than the scenario's initial one). */
	startpopOverride?: { size: number; apply: string }[],
): SubScenario {
	const set = new Set<string>([...clusterTraitKeys, ...membership]);
	const traits = (scenario.trait as Json[] | undefined ?? [])
		.filter(t => set.has(String(t.key)))
		.map(t => projectTrait(t, set));
	const vectors = (scenario.vector as Json[] | undefined ?? []).map(v => projectVector(v, set));

	const sites = (scenario.site as Json[] | undefined ?? []).map(site => {
		const out: Json = { key: site.key, name: site.name, pop: site.pop };
		if (startpopOverride) {
			// already projected onto this cluster's traits by the caller
			out.startpop = startpopOverride.map(p => ({ size: p.size, apply: p.apply }));
		} else if (Array.isArray(site.startpop)) {
			out.startpop = (site.startpop as Json[]).map(p => ({ size: p.size, apply: keep(p.apply, set) }));
		}
		// site.transmit is an INITIAL injection that fires during World.start().
		// On a re-partition rebuild the override startpop already reflects that
		// injection, so dropping it avoids double-counting (C3).
		if (!startpopOverride && Array.isArray(site.transmit)) {
			out.transmit = (site.transmit as Json[]).map(r => projectRule(r, set)).filter((r): r is Json => r !== null);
		}
		return out;
	});

	const sub: Json = {
		name: `${scenario.name ?? 'scenario'}::cluster${clusterId}`,
		use_date: false,
		phase: scenario.phase ?? [],
		vector: vectors,
		trait: traits,
		site: sites,
		// resources kept in every sub-World; the evolver reconciles their values
		// across sub-Worlds each day (C2c aggregate-coupling channel). Actions /
		// events still omitted.
		resource: scenario.resource ?? [],
	};
	return { scenario: sub, clusterId, traitKeys: [...clusterTraitKeys] };
}
