/**
 * cpuApplyShed — canonical CPU implementation of the per-(shed, pop)
 * applyShed math.
 *
 * Mirrors `applyShedKernel.ts` line-for-line so the two paths produce
 * the same results given identical inputs. The CPU path remains the
 * authoritative implementation and is used:
 *   - As the fallback when WebGPU is unavailable.
 *   - As a reference for tests verifying GPU-CPU agreement.
 *
 * Post-Stage-A+D, this is a tiny pure function: hit count from popCount,
 * vectorCount, multiplier, isPrecise. The CPU pre-pass / post-pass in
 * applyShedBatch handles target-mask materialization separately.
 */

export function cpuApplyShed(
	popCount: number,
	vectorCount: number,
	multiplier: number,
	precise: boolean,
): number {
	if (popCount <= 0 || vectorCount <= 0) return 0;

	let hits: number;
	if (precise) {
		hits = vectorCount * multiplier;
	} else {
		const p = (1 / popCount) * multiplier;
		const prob = 1 - Math.pow(1 - p, vectorCount);
		hits = popCount * prob;
	}
	if (hits > vectorCount) hits = vectorCount;
	if (hits <= 0 || isNaN(hits)) return 0;
	return hits;
}
