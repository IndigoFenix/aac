// Forward reference for Syndrome type
interface SyndromeLike {
	key: string;
	traits: string[];
}

/**
 * Filter for selecting data subsets based on trait requirements.
 * Caches syndrome inclusion results for performance.
 */
export class Filter {
	key: string;
	traits_required: string[];
	traits_forbidden: string[];

	// Cached inclusion results
	syndromes_yes: SyndromeLike[] = [];
	syndromes_no: SyndromeLike[] = [];
	syndromes_yes_kv: Record<string, SyndromeLike> = {};
	syndromes_no_kv: Record<string, SyndromeLike> = {};

	constructor(
		key: string,
		traits_required: string[] = [],
		traits_forbidden: string[] = []
	) {
		this.key = key;
		this.traits_required = traits_required;
		this.traits_forbidden = traits_forbidden;
	}

	/**
	 * Check if a syndrome is included by this filter (with caching)
	 */
	syndromeIncluded(syndrome: SyndromeLike): boolean {
		const key = syndrome.key;

		// Check cache first
		if (this.syndromes_yes_kv[key]) return true;
		if (this.syndromes_no_kv[key]) return false;

		// Calculate and cache
		if (this.getSynInc(syndrome)) {
			this.syndromes_yes.push(syndrome);
			this.syndromes_yes_kv[key] = syndrome;
			return true;
		} else {
			this.syndromes_no.push(syndrome);
			this.syndromes_no_kv[key] = syndrome;
			return false;
		}
	}

	/**
	 * Calculate whether syndrome matches filter requirements
	 */
	private getSynInc(syndrome: SyndromeLike): boolean {
		// Check required traits
		for (let i = 0, len = this.traits_required.length; i < len; i++) {
			if (syndrome.traits.indexOf(this.traits_required[i]) === -1) {
				return false;
			}
		}

		// Check forbidden traits
		for (let i = 0, len = this.traits_forbidden.length; i < len; i++) {
			if (syndrome.traits.indexOf(this.traits_forbidden[i]) !== -1) {
				return false;
			}
		}

		return true;
	}

	/**
	 * Clear cached results
	 */
	clearCache(): void {
		this.syndromes_yes = [];
		this.syndromes_no = [];
		this.syndromes_yes_kv = {};
		this.syndromes_no_kv = {};
	}
}

export default Filter;
