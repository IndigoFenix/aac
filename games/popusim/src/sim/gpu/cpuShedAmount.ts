/**
 * cpuShedAmount — canonical CPU implementation of the shed-amount math.
 *
 * Mirrors the WGSL kernel in `shedAmountKernel.ts` line for line so that
 * GPU and CPU paths produce the same results. Uses HashRand-style
 * counter-based hashing keyed by `(seed, day, phase, popId, txKindId, draw)`,
 * so the result is order-independent and deterministic.
 *
 * One important property: this replaces the legacy `generateRandom` calls
 * in `Population.updateTransmission` that used the LCG-based `system.rand`.
 * That replacement is the second half of Phase A's order-independence
 * goal: shed amounts are now structurally invariant to iteration order,
 * matching the rounding RNG that Phase A already moved to HashRand.
 */

// 32-bit Murmur3-style finalizer; identical to mix32 in src/core/HashRand.ts.
function mix32(x: number): number {
	x = Math.imul(x ^ (x >>> 16), 0x85ebca6b);
	x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
	x = x ^ (x >>> 16);
	return x >>> 0;
}

/**
 * 6-key hash matching the WGSL `hash_keys_u32`. Mixes seed, day, phase,
 * popId, txKindId, drawIndex into a single u32. The mixing pattern uses
 * the FNV-1a prime (0x01000193) the same way HashRand does.
 */
export function hashKeys6(
	seed: number,
	day: number,
	phase: number,
	popId: number,
	txKindId: number,
	draw: number,
): number {
	let h = seed | 0;
	h = Math.imul(h ^ (day | 0), 0x01000193) | 0;
	h = Math.imul(h ^ (phase | 0), 0x01000193) | 0;
	h = Math.imul(h ^ (popId | 0), 0x01000193) | 0;
	h = Math.imul(h ^ (txKindId | 0), 0x01000193) | 0;
	h = Math.imul(h ^ (draw | 0), 0x01000193) | 0;
	return mix32(h);
}

/** Convert a u32 hash to a uniform double in [0, 1). */
export function uniform01(h: number): number {
	return (h >>> 0) / 0x100000000;
}

/**
 * Box-Muller normal sample with given mean and standard deviation,
 * driven by two uniform draws. When sd is 0 the result is `mean` exactly.
 */
export function boxMullerNormal(u: number, v: number, mean: number, sd: number): number {
	if (sd === 0) return mean;
	const safeU = u > 1e-30 ? u : 1e-30;
	const z = Math.sqrt(-2 * Math.log(safeU)) * Math.cos(2 * Math.PI * v);
	return z * sd + mean;
}

/**
 * Compute the shed amount for one (population, transmit) pair.
 *
 *   amount = boxMuller( value*pop, sd*sqrt(pop) )
 *
 * Two RNG draws are consumed (Box-Muller) keyed by
 * (seed, day, phase, popId, txKindId, drawIndex). Drawing exactly two
 * values per call (drawIndex = 0 and 1) keeps the GPU and CPU paths in
 * lockstep.
 */
export function cpuShedAmount(
	popCount: number,
	value: number,
	sd: number,
	seed: number,
	day: number,
	phase: number,
	popId: number,
	txKindId: number,
): number {
	if (popCount <= 0) return 0;
	const mean = value * popCount;
	if (sd === 0) return mean;
	const stddev = sd * Math.sqrt(popCount);
	const u = uniform01(hashKeys6(seed, day, phase, popId, txKindId, 0));
	const v = uniform01(hashKeys6(seed, day, phase, popId, txKindId, 1));
	return boxMullerNormal(u, v, mean, stddev);
}
