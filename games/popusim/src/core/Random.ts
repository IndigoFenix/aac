/**
 * Seeded pseudo-random number generator using linear congruential method.
 * Useful for reproducible randomness in simulations.
 */
export class Random {
	private s: number = 0;
	private v: number = 0;

	constructor(seed?: number) {
		this.seed(seed);
	}

	/**
	 * Set the random seed. If not provided, generates from Math.random()
	 * @returns The seed value used
	 */
	seed(s?: number): number {
		if (!s) s = Math.random() * 1000000000;
		this.s = this.v = s % 2147483647;
		if (this.s <= 0) this.s += 2147483646;
		this.v = this.s;
		return this.s;
	}

	/**
	 * Get next random number in range [0, 1)
	 */
	get(): number {
		this.v = (this.v * 16807) % 2147483647;
		return (this.v - 1) / 2147483646;
	}

	/**
	 * Get random integer in range [min, max] inclusive
	 */
	getInt(min: number, max: number): number {
		return Math.floor(this.get() * (max - min + 1)) + min;
	}

	/**
	 * Get random float in range [min, max)
	 */
	getFloat(min: number, max: number): number {
		return this.get() * (max - min) + min;
	}

	/**
	 * Get current seed value
	 */
	getSeed(): number {
		return this.s;
	}
}

/** Default random instance */
export const rand = new Random();

export default Random;
