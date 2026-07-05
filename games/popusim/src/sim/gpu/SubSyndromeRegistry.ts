/**
 * SubSyndromeRegistry — flat open-addressing hash table mapping
 * 4-word trait masks → SubSyndrome id.
 *
 * Replaces the previous 4-level nested `Map<u32, Map<u32, Map<u32, Map<u32,
 * SubSyndrome>>>>` registry. The nested form:
 *   - Walked 4 `Map.get` calls per lookup (~200 ns).
 *   - Allocated up to 3 new `Map` instances per inserted mask (~150 ns each),
 *     plus the SubSyndrome itself. In gpu-test the post-pass creates ~80 k
 *     SubSyndromes/day, so allocator + GC pressure was the dominant cost.
 *
 * This flat form:
 *   - One typed-array probe per lookup (1 hash + 4-word compare; ~50-80 ns).
 *   - Zero allocations on insert beyond the SubSyndrome itself — the table
 *     storage is pre-allocated and grows geometrically.
 *
 * Hash collisions resolved by linear probing within the same TypedArray, so
 * a chain stays cache-friendly. Capacity stays a power of two so `slot =
 * hash & (cap-1)` replaces `% cap`.
 *
 * The structure also serves as a staging step toward a WASM port: the API
 * is intentionally TypedArray-friendly so it lifts cleanly into linear
 * memory once we move the hot loop into a wasm module.
 */

import { MASK_WORDS } from './traitMask';
import type { SubSyndrome } from '../../game/simulation/SubSyndrome';

const EMPTY = 0;
const FILLED = 1;
const INITIAL_CAPACITY = 1024; // power of two
const LOAD_FACTOR_NUM = 3;
const LOAD_FACTOR_DEN = 4;

export class SubSyndromeRegistry {
	private capacity: number = INITIAL_CAPACITY;
	private mask: Uint32Array = new Uint32Array(INITIAL_CAPACITY * MASK_WORDS);
	private subs: (SubSyndrome | null)[] = new Array(INITIAL_CAPACITY).fill(null);
	private state: Uint8Array = new Uint8Array(INITIAL_CAPACITY);
	private size: number = 0;

	/**
	 * Find the SubSyndrome interned for a given mask, or `null` if not yet
	 * registered. No insertion.
	 */
	get(mask: Uint32Array, off: number): SubSyndrome | null {
		const m0 = mask[off] >>> 0;
		const m1 = mask[off + 1] >>> 0;
		const m2 = mask[off + 2] >>> 0;
		const m3 = mask[off + 3] >>> 0;
		const cap = this.capacity;
		const mask2 = this.mask;
		const state = this.state;
		let slot = hashMask(m0, m1, m2, m3) & (cap - 1);
		for (let probes = 0; probes < cap; probes++) {
			if (state[slot] === EMPTY) return null;
			const base = slot * MASK_WORDS;
			if (mask2[base] === m0 && mask2[base + 1] === m1
				&& mask2[base + 2] === m2 && mask2[base + 3] === m3) {
				return this.subs[slot];
			}
			slot = (slot + 1) & (cap - 1);
		}
		return null;
	}

	/**
	 * Look up `mask`. If new, calls `factory()` to construct the SubSyndrome,
	 * interns it, and returns it. Otherwise returns the interned instance.
	 *
	 * Hot path is one Murmur-style hash + a typed-array compare. The factory
	 * closure is only invoked on inserts.
	 */
	getOrInsert(
		mask: Uint32Array,
		off: number,
		factory: () => SubSyndrome,
	): SubSyndrome {
		const m0 = mask[off] >>> 0;
		const m1 = mask[off + 1] >>> 0;
		const m2 = mask[off + 2] >>> 0;
		const m3 = mask[off + 3] >>> 0;

		if ((this.size + 1) * LOAD_FACTOR_DEN >= this.capacity * LOAD_FACTOR_NUM) {
			this.grow();
		}

		const cap = this.capacity;
		const mask2 = this.mask;
		const state = this.state;
		let slot = hashMask(m0, m1, m2, m3) & (cap - 1);
		for (; ;) {
			if (state[slot] === EMPTY) {
				const sub = factory();
				const base = slot * MASK_WORDS;
				mask2[base] = m0;
				mask2[base + 1] = m1;
				mask2[base + 2] = m2;
				mask2[base + 3] = m3;
				state[slot] = FILLED;
				this.subs[slot] = sub;
				this.size++;
				return sub;
			}
			const base = slot * MASK_WORDS;
			if (mask2[base] === m0 && mask2[base + 1] === m1
				&& mask2[base + 2] === m2 && mask2[base + 3] === m3) {
				return this.subs[slot] as SubSyndrome;
			}
			slot = (slot + 1) & (cap - 1);
		}
	}

	/** Active entry count. Used by tests that check "no new SubSyndromes
	 * were created" invariants. */
	get count(): number { return this.size; }

	/** Clear back to empty. Used by tests and World.destroy. */
	clear(): void {
		this.capacity = INITIAL_CAPACITY;
		this.mask = new Uint32Array(INITIAL_CAPACITY * MASK_WORDS);
		this.subs = new Array(INITIAL_CAPACITY).fill(null);
		this.state = new Uint8Array(INITIAL_CAPACITY);
		this.size = 0;
	}

	private grow(): void {
		const oldCap = this.capacity;
		const oldMask = this.mask;
		const oldSubs = this.subs;
		const oldState = this.state;

		this.capacity = oldCap * 2;
		this.mask = new Uint32Array(this.capacity * MASK_WORDS);
		this.subs = new Array(this.capacity).fill(null);
		this.state = new Uint8Array(this.capacity);
		// Rehash. We don't decrement size; just re-insert everything raw.
		this.size = 0;
		for (let s = 0; s < oldCap; s++) {
			if (oldState[s] === EMPTY) continue;
			const off = s * MASK_WORDS;
			const m0 = oldMask[off];
			const m1 = oldMask[off + 1];
			const m2 = oldMask[off + 2];
			const m3 = oldMask[off + 3];
			let slot = hashMask(m0, m1, m2, m3) & (this.capacity - 1);
			while (this.state[slot] !== EMPTY) {
				slot = (slot + 1) & (this.capacity - 1);
			}
			const base2 = slot * MASK_WORDS;
			this.mask[base2] = m0;
			this.mask[base2 + 1] = m1;
			this.mask[base2 + 2] = m2;
			this.mask[base2 + 3] = m3;
			this.state[slot] = FILLED;
			this.subs[slot] = oldSubs[s];
			this.size++;
		}
	}
}

/** 4-word Murmur-style finalizer; `Math.imul` keeps it 32-bit-wrap exact. */
function hashMask(m0: number, m1: number, m2: number, m3: number): number {
	let h = Math.imul(m0, 2654435761) >>> 0;
	h = (h ^ (Math.imul(m1, 40503) >>> 0)) >>> 0;
	h = (h ^ (Math.imul(m2, 1597334677) >>> 0)) >>> 0;
	h = (h ^ m3) >>> 0;
	// One pass of avalanche so power-of-two slot mapping doesn't degenerate
	// when masks have low entropy in their high bits.
	h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
	h = (h ^ (h >>> 13)) >>> 0;
	return h >>> 0;
}
