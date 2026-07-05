/**
 * PhaseDelta — write-only accumulator for one phase of simulation work.
 *
 * Within a phase, the simulator is restructured as:
 *   read snapshot (immutable) -> compute deltas -> apply deltas (mutate state)
 *
 * Every kernel that processes sheds, progressions, or consumption writes
 * its results into a PhaseDelta. The order in which kernels run cannot
 * affect the final state because (a) reads are from a snapshot frozen at
 * phase start and (b) writes are commutative additions into the delta.
 *
 * Storage: parallel TypedArrays (struct-of-arrays). Keyed by integer IDs:
 *   popId           — Population.id assigned by World.registerPopulation
 *   sourceSubId,    — SubSyndrome.id assigned by World.materializeSubSyndrome
 *   targetSubId
 *   stockId         — Stockpile.id assigned by World.registerStockpile
 *
 * Dedup-on-write: a single `Map<number, number>` keyed by a 53-bit packed
 * `(popId, sourceSubId, targetSubId)` triple so repeated writes to the
 * same triple accumulate into one slot. Without dedup, two writes would
 * each pass through rounding independently at apply and produce wrong
 * results.
 *
 * The packed key replaced a 3-level nested Map (which itself replaced an
 * earlier `${popId}|${sourceSubId}|${targetSubId}` string-keyed Map). At
 * 175k addPopShift calls per phase, three Map walks dominated the
 * post-pass; one packed-number Map.get / Map.set is roughly 5× faster.
 *
 * Packing layout: `popId * 2^34 + sourceSubId * 2^17 + targetSubId`. Exact
 * for popId < 2^19, sourceSubId < 2^17, targetSubId < 2^17. If a value
 * overflows we log once and fall back to a nested-Map path so the
 * simulation stays correct (just slower).
 *
 * The whole delta is reusable across phases via `reset()`, which clears
 * counters and the dedup Map without releasing the TypedArray capacity.
 */

const INITIAL_CAPACITY = 1024;
const INITIAL_STOCK_CAPACITY = 64;

/** popId bit-shift for the packed dedup key (popId * 2^38). Chosen so the
 * full key `popId * 2^38 + sourceSubId * 2^19 + targetSubId` stays inside
 * 53-bit safe-integer range when popId < 2^14, sourceSubId < 2^19, and
 * targetSubId < 2^19. */
const KEY_POP_SHIFT = 274877906944; // 2^38
/** sourceSubId bit-shift (sourceSubId * 2^19). */
const KEY_SOURCE_SHIFT = 524288; // 2^19
const KEY_POP_MAX = 16384;      // 2^14
const KEY_SUB_MAX = 524288;     // 2^19
// In gpu-test the simulation hits 131072 SubSyndromes within a few minutes
// of play; the old 2^17 limit kicked the *non-bulk* addPopShift callers
// (progression, stockpile sheds) into the nested-Map slow path. The new
// budget supports 524288 SubSyndromes and 16384 simultaneous Populations,
// which is enough headroom for any realistic scenario.

let overflowWarned = false;

export class PhaseDelta {
	// --- Population shifts ---
	popIds: Int32Array;
	sourceSubIds: Int32Array;
	targetSubIds: Int32Array;
	amounts: Float32Array;
	n: number = 0;
	private capacity: number;
	/** Slot index keyed by `popId * 2^34 + sourceSubId * 2^17 + targetSubId`.
	 * Cleared on reset. Single Map with a numeric key avoids both string
	 * allocations and the 3-level Map walk that the previous designs paid. */
	private popDedup: Map<number, number> = new Map();
	/** Fallback dedup for the (rare) case that an ID overflows the packed-
	 * key budget. Allocated lazily on first overflow. */
	private popDedupFallback: Map<number, Map<number, Map<number, number>>> | null = null;

	// --- Stockpile deltas ---
	stockIds: Int32Array;
	stockAmounts: Float32Array;
	nStock: number = 0;
	private stockCapacity: number;
	/** Slot index by stockpile id. Cleared on reset. */
	private stockDedup: Map<number, number> = new Map();

	constructor() {
		this.capacity = INITIAL_CAPACITY;
		this.popIds = new Int32Array(this.capacity);
		this.sourceSubIds = new Int32Array(this.capacity);
		this.targetSubIds = new Int32Array(this.capacity);
		this.amounts = new Float32Array(this.capacity);

		this.stockCapacity = INITIAL_STOCK_CAPACITY;
		this.stockIds = new Int32Array(this.stockCapacity);
		this.stockAmounts = new Float32Array(this.stockCapacity);
	}

	/**
	 * Record that `amount` units in Population `popId` should transition from
	 * SubSyndrome `sourceSubId` to SubSyndrome `targetSubId`. Multiple writes
	 * to the same triple accumulate into one slot.
	 *
	 * Skips zero-amount and self-targeting writes.
	 */
	addPopShift(popId: number, sourceSubId: number, targetSubId: number, amount: number): void {
		if (amount === 0 || sourceSubId === targetSubId) return;
		if (isNaN(amount)) {
			console.error('addPopShift: NaN amount', { popId, sourceSubId, targetSubId });
			return;
		}

		// Fast path: pack the three IDs into a 53-bit safe integer key.
		if (popId < KEY_POP_MAX && sourceSubId < KEY_SUB_MAX && targetSubId < KEY_SUB_MAX) {
			const key = popId * KEY_POP_SHIFT + sourceSubId * KEY_SOURCE_SHIFT + targetSubId;
			const existing = this.popDedup.get(key);
			if (existing !== undefined) {
				this.amounts[existing] += amount;
				return;
			}
			if (this.n === this.capacity) this.growPop();
			const slot = this.n++;
			this.popIds[slot] = popId;
			this.sourceSubIds[slot] = sourceSubId;
			this.targetSubIds[slot] = targetSubId;
			this.amounts[slot] = amount;
			this.popDedup.set(key, slot);
			return;
		}

		// Slow path: an ID overflowed the packed-key budget. Warn once and
		// fall back to nested Maps so the simulation stays correct.
		if (!overflowWarned) {
			overflowWarned = true;
			console.warn(
				`PhaseDelta: ID overflow (popId=${popId}, sourceSubId=${sourceSubId}, targetSubId=${targetSubId}). ` +
				`Falling back to nested-Map dedup. Bump KEY_POP_SHIFT/KEY_*_MAX in PhaseDelta.ts to recover speed.`,
			);
		}
		if (this.popDedupFallback === null) this.popDedupFallback = new Map();
		let bySource = this.popDedupFallback.get(popId);
		if (bySource === undefined) {
			bySource = new Map();
			this.popDedupFallback.set(popId, bySource);
		}
		let byTarget = bySource.get(sourceSubId);
		if (byTarget === undefined) {
			byTarget = new Map();
			bySource.set(sourceSubId, byTarget);
		}
		const existing = byTarget.get(targetSubId);
		if (existing !== undefined) {
			this.amounts[existing] += amount;
			return;
		}
		if (this.n === this.capacity) this.growPop();
		const slot = this.n++;
		this.popIds[slot] = popId;
		this.sourceSubIds[slot] = sourceSubId;
		this.targetSubIds[slot] = targetSubId;
		this.amounts[slot] = amount;
		byTarget.set(targetSubId, slot);
	}

	/**
	 * Bulk-add already-deduplicated popShifts from a WASM batch. Inputs are
	 * typed-array views (typically over WASM linear memory). The caller
	 * guarantees that within the passed arrays no two entries share the
	 * same `(popId, sourceSubId, targetSubId)` key — i.e. dedup happened
	 * upstream.
	 *
	 * Cross-batch dedup is unnecessary for applyShedBatch output: Population
	 * ids are globally unique across sites, and within a phase the only
	 * sources that add to the same `popId` are progression / consumption
	 * sheds (which run *before* applyShedBatch). If `popDedup` is empty when
	 * we enter, we can therefore stream WASM-deduped entries straight into
	 * the array slots with no Map operations. When `popDedup` has earlier
	 * entries (e.g. a scenario with progression), we still need the Map to
	 * fold any colliding key, so fall back to the per-entry dedup path.
	 *
	 * Skipping the Map also dodges the silent slow-path fallback that fires
	 * once `targetSubId` crosses `KEY_SUB_MAX` (2^17) — at high pop counts
	 * with combinatorial trait growth, SubSyndrome ids cross that threshold
	 * within minutes of play and the nested-Map fallback otherwise dominates.
	 */
	bulkAddPopShifts(
		popIds: Uint32Array,
		sourceSubIds: Uint32Array,
		targetSubIds: Uint32Array,
		amounts: Float32Array,
		count: number,
	): void {
		while (this.n + count > this.capacity) this.growPop();

		if (this.popDedup.size === 0 && this.popDedupFallback === null) {
			// Fast path: no earlier entries to merge against, and WASM
			// already dedup'd within this batch. Pure typed-array writes.
			let slot = this.n;
			for (let i = 0; i < count; i++) {
				const popId = popIds[i];
				const sourceSubId = sourceSubIds[i];
				const targetSubId = targetSubIds[i];
				const amount = amounts[i];
				if (amount === 0 || sourceSubId === targetSubId) continue;
				this.popIds[slot] = popId;
				this.sourceSubIds[slot] = sourceSubId;
				this.targetSubIds[slot] = targetSubId;
				this.amounts[slot] = amount;
				slot++;
			}
			this.n = slot;
			return;
		}

		// Mixed path: pre-existing entries may collide with ours. Use the
		// regular per-entry dedup, which falls back to the nested-Map path
		// when ids exceed the packed-key budget.
		for (let i = 0; i < count; i++) {
			this.addPopShift(popIds[i], sourceSubIds[i], targetSubIds[i], amounts[i]);
		}
	}

	/**
	 * Record a delta to apply to stockpile `stockId`'s value at the apply step.
	 * Multiple writes accumulate.
	 */
	addStockpileDelta(stockId: number, amount: number): void {
		if (amount === 0) return;

		const existing = this.stockDedup.get(stockId);
		if (existing !== undefined) {
			this.stockAmounts[existing] += amount;
			return;
		}

		if (this.nStock === this.stockCapacity) this.growStock();

		const slot = this.nStock++;
		this.stockIds[slot] = stockId;
		this.stockAmounts[slot] = amount;
		this.stockDedup.set(stockId, slot);
	}

	/**
	 * Iterate every accumulated population shift in insertion order. The
	 * callback receives the unrolled tuple — no array allocation per entry.
	 */
	forEachPopShift(cb: (popId: number, sourceSubId: number, targetSubId: number, amount: number) => void): void {
		for (let i = 0; i < this.n; i++) {
			cb(this.popIds[i], this.sourceSubIds[i], this.targetSubIds[i], this.amounts[i]);
		}
	}

	forEachStockpileDelta(cb: (stockId: number, amount: number) => void): void {
		for (let i = 0; i < this.nStock; i++) {
			cb(this.stockIds[i], this.stockAmounts[i]);
		}
	}

	isEmpty(): boolean {
		return this.n === 0 && this.nStock === 0;
	}

	/**
	 * Clear all accumulators without releasing TypedArray capacity. Allows the
	 * same PhaseDelta to be reused across phases / days.
	 */
	reset(): void {
		this.n = 0;
		this.nStock = 0;
		this.popDedup.clear();
		if (this.popDedupFallback !== null) this.popDedupFallback.clear();
		this.stockDedup.clear();
	}

	private growPop(): void {
		const next = this.capacity * 2;
		const nextPopIds = new Int32Array(next);
		const nextSourceSubIds = new Int32Array(next);
		const nextTargetSubIds = new Int32Array(next);
		const nextAmounts = new Float32Array(next);
		nextPopIds.set(this.popIds);
		nextSourceSubIds.set(this.sourceSubIds);
		nextTargetSubIds.set(this.targetSubIds);
		nextAmounts.set(this.amounts);
		this.popIds = nextPopIds;
		this.sourceSubIds = nextSourceSubIds;
		this.targetSubIds = nextTargetSubIds;
		this.amounts = nextAmounts;
		this.capacity = next;
	}

	private growStock(): void {
		const next = this.stockCapacity * 2;
		const nextStockIds = new Int32Array(next);
		const nextStockAmounts = new Float32Array(next);
		nextStockIds.set(this.stockIds);
		nextStockAmounts.set(this.stockAmounts);
		this.stockIds = nextStockIds;
		this.stockAmounts = nextStockAmounts;
		this.stockCapacity = next;
	}
}
