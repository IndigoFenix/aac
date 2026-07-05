/**
 * shedAmountKernel — WGSL compute kernel + JS wrapper for batched shed
 * amount generation.
 *
 * The WGSL implementation mirrors `cpuShedAmount.ts` line for line so the
 * GPU and CPU paths produce identical results given identical inputs and
 * keys. RNG is HashRand-style: pure counter-based hashing, deterministic
 * regardless of iteration order, GPU-portable.
 *
 * Phase-1 update: pop counts are now read from `GpuPopState.popCountBuffer`
 * (binding 1) by indexing with `popIds[i]`. Callers no longer pass a
 * per-pair `popCounts` Float32Array — the per-population values live on
 * the GPU between phases and we just bind the buffer directly.
 *
 * Inputs (per dispatch):
 *   - uniforms: [seed, day, phase, n]
 *   - popCount:    GPU buffer of u32 length >= max(popId)+1 (caller-owned)
 *   - values:      Float32Array length n
 *   - sds:         Float32Array length n
 *   - popIds:      Uint32Array  length n
 *   - txKindIds:   Uint32Array  length n
 * Output:
 *   - amounts:     Float32Array length n
 */

import type { GpuContext } from './GpuContext';
import { GpuKernel } from './GpuKernel';

interface MinimalGPUBuffer { destroy?(): void }

const SHED_AMOUNT_WGSL = /* wgsl */ `
struct Uniforms {
    seed: u32,
    day: u32,
    phase: u32,
    n: u32,
};

@group(0) @binding(0) var<uniform> U : Uniforms;
@group(0) @binding(1) var<storage, read>  pop_count : array<u32>;
@group(0) @binding(2) var<storage, read>  values    : array<f32>;
@group(0) @binding(3) var<storage, read>  sds       : array<f32>;
@group(0) @binding(4) var<storage, read>  popIds    : array<u32>;
@group(0) @binding(5) var<storage, read>  txKindIds : array<u32>;
@group(0) @binding(6) var<storage, read_write> amounts : array<f32>;

fn mix32(x: u32) -> u32 {
    var v = x;
    v = (v ^ (v >> 16u)) * 0x85ebca6bu;
    v = (v ^ (v >> 13u)) * 0xc2b2ae35u;
    v = v ^ (v >> 16u);
    return v;
}

fn hash_keys_6(seed: u32, day: u32, phase: u32, popId: u32, txKindId: u32, draw: u32) -> u32 {
    var h = seed;
    h = (h ^ day)       * 0x01000193u;
    h = (h ^ phase)     * 0x01000193u;
    h = (h ^ popId)     * 0x01000193u;
    h = (h ^ txKindId)  * 0x01000193u;
    h = (h ^ draw)      * 0x01000193u;
    return mix32(h);
}

fn uniform01(h: u32) -> f32 {
    return f32(h) * (1.0 / 4294967296.0);
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
    let i = gid.x;
    if (i >= U.n) { return; }

    let popId = popIds[i];
    let pop = f32(pop_count[popId]);
    if (pop <= 0.0) { amounts[i] = 0.0; return; }

    let val  = values[i];
    let sd   = sds[i];
    let mean = val * pop;
    if (sd == 0.0) { amounts[i] = mean; return; }

    let stddev = sd * sqrt(pop);
    let u_raw = hash_keys_6(U.seed, U.day, U.phase, popId, txKindIds[i], 0u);
    let v_raw = hash_keys_6(U.seed, U.day, U.phase, popId, txKindIds[i], 1u);
    let u = uniform01(u_raw);
    let v = uniform01(v_raw);
    let safeU = max(u, 1e-30);
    let z = sqrt(-2.0 * log(safeU)) * cos(6.283185307179586 * v);
    amounts[i] = z * stddev + mean;
}
`;

export interface ShedAmountInputs {
	/** Caller-owned GPU buffer of u32, length >= max(popId)+1. Typically
	 * `world.gpuPopState.popCountBuffer`. */
	popCountBuffer: MinimalGPUBuffer;
	values: Float32Array;
	sds: Float32Array;
	popIds: Uint32Array;
	txKindIds: Uint32Array;
	seed: number;
	day: number;
	phase: number;
}

export class ShedAmountKernel {
	private kernel: GpuKernel;

	constructor(ctx: GpuContext) {
		this.kernel = new GpuKernel(ctx, {
			label: 'shedAmount',
			wgsl: SHED_AMOUNT_WGSL,
			entryPoint: 'main',
			workgroupSize: 64,
			bindings: [
				{ binding: 0, kind: 'uniform' },
				{ binding: 1, kind: 'read' },
				{ binding: 2, kind: 'read' },
				{ binding: 3, kind: 'read' },
				{ binding: 4, kind: 'read' },
				{ binding: 5, kind: 'read' },
				{ binding: 6, kind: 'read_write' },
			],
		});
	}

	async run(inputs: ShedAmountInputs): Promise<Float32Array> {
		const n = inputs.values.length;
		if (n === 0) return new Float32Array(0);
		const uniforms = new Uint32Array([
			inputs.seed >>> 0,
			inputs.day >>> 0,
			inputs.phase >>> 0,
			n >>> 0,
		]);

		const result = await this.kernel.dispatch(
			[
				{ binding: 0, data: uniforms },
				{ binding: 1, buffer: inputs.popCountBuffer },
				{ binding: 2, data: inputs.values },
				{ binding: 3, data: inputs.sds },
				{ binding: 4, data: inputs.popIds },
				{ binding: 5, data: inputs.txKindIds },
			],
			[{ binding: 6, floatLength: n }],
			n,
		);

		return result.get(6) ?? new Float32Array(n);
	}
}
