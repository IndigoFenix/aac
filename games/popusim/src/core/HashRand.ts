/**
 * HashRand — counter-based pseudo-random number generator.
 *
 * Unlike a stateful LCG (`Random`), HashRand draws are derived purely from a
 * seed plus a tuple of keys. Two calls with the same seed and keys always
 * return the same stream. Two calls with different keys are statistically
 * independent. This makes it usable for order-independent simulation work:
 * each draw can be tagged with a stable identity (e.g. site_id, day, phase,
 * population_key) and the order in which draws are issued does not affect
 * the result.
 *
 * The mixing is a Murmur3-style 32-bit finalizer. Quality is good enough
 * for simulation work and the math ports trivially to GPU shaders later.
 */

function mix32(x: number): number {
	x = Math.imul(x ^ (x >>> 16), 0x85ebca6b);
	x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
	x = x ^ (x >>> 16);
	return x >>> 0;
}

function hashKeys(seed: number, keys: ReadonlyArray<number | string>): number {
	let h = seed | 0;
	for (const k of keys) {
		if (typeof k === 'string') {
			for (let i = 0; i < k.length; i++) {
				h = Math.imul(h ^ k.charCodeAt(i), 0x01000193) | 0;
			}
			h = Math.imul(h ^ k.length, 0x01000193) | 0;
		} else {
			h = Math.imul(h ^ (k | 0), 0x01000193) | 0;
		}
	}
	return mix32(h);
}

/**
 * A draw stream rooted at a (seed, keys) tuple. Successive `next()` calls
 * return uniform doubles in [0, 1) and advance an internal counter. Two
 * `HashRand` instances with the same seed and keys produce the same stream.
 */
export class HashRand {
	private readonly state: number;
	private counter: number = 0;

	constructor(seed: number, keys: ReadonlyArray<number | string>) {
		this.state = hashKeys(seed, keys);
	}

	/** Uniform double in [0, 1). Successive calls advance an internal counter. */
	next(): number {
		const h = mix32(this.state ^ Math.imul(this.counter++, 0x9e3779b9));
		return h / 0x100000000;
	}

	/**
	 * Box-Muller normal sample with given mean and standard deviation.
	 * Consumes 2 uniform draws when sd != 0. Returns mean exactly when sd == 0.
	 */
	nextNormal(mean: number, sd: number): number {
		if (sd === 0) return mean;
		let u = 0;
		let v = 0;
		while (u === 0) u = this.next();
		while (v === 0) v = this.next();
		const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
		return z * sd + mean;
	}
}

/** Convenience: build a stream from a seed and an arbitrary key tuple. */
export function rngStream(seed: number, ...keys: (number | string)[]): HashRand {
	return new HashRand(seed, keys);
}

/** One-shot uniform draw without instantiating a HashRand. */
export function hashUniform(seed: number, ...keys: (number | string)[]): number {
	return mix32(hashKeys(seed, keys)) / 0x100000000;
}
