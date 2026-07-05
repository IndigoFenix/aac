/**
 * seekModKernel — WGSL compute kernel for batched seek_mod calculation.
 *
 * Computes `seek_mod` per (shed, population) pair. The CPU equivalent is
 * `Syndrome.getSeekMod(shed)`: walk the shed's seek list, and for each
 * Seek entry test whether the population's syndrome contains any required
 * trait or lacks any forbidden trait. If so, multiply by the seek's mult.
 *
 * Phase-1 update: population masks are now read from
 * `GpuPopState.popMaskBuffer` (binding 1) by indexing with `popIds[i]`.
 * Pre-Phase-1 we uploaded a per-pair `synMask: Uint32Array` of length
 * `n * MASK_WORDS` per dispatch — at 2,500 pops × 70 sheds that was a
 * 2.8 MB allocation + copy + writeBuffer every phase. Now it's a single
 * `popIds: Uint32Array` of length n (~700 KB) and we reuse the buffer
 * that the world already maintains.
 *
 * GPU layout:
 *   per-pair:    popIds[i]    = u32 (index into pop_mask)
 *                shedIndex[i] = u32
 *   global:      pop_mask     = array<vec4<u32>>, indexed by Population.id
 *   per-shed:    shedRange[s] = vec2<u32>(offset, count)
 *   per-seek:    seekHas[k]   = vec4<u32>  (has mask)
 *                seekNot[k]   = vec4<u32>  (not mask)
 *                seekMults[k] = f32
 *   output:      outMods[i]   = f32 = seek_mod for pair i
 *
 * If the shed has no seek entries (count == 0), seek_mod is 1.0.
 */

import type { GpuContext } from './GpuContext';
import { GpuKernel, type GpuBufferRef } from './GpuKernel';
import { MASK_WORDS } from './traitMask';

if (MASK_WORDS !== 4) {
	throw new Error(`MASK_WORDS=${MASK_WORDS} but seekModKernel.wgsl assumes 4`);
}

const SEEK_MOD_WGSL = /* wgsl */ `
struct Uniforms { n: u32, _pad0: u32, _pad1: u32, _pad2: u32 };

@group(0) @binding(0) var<uniform> U : Uniforms;
// world-wide: pop_mask indexed by Population.id
@group(0) @binding(1) var<storage, read> pop_mask  : array<vec4<u32>>;
// per-pair: which population this pair refers to
@group(0) @binding(2) var<storage, read> popIds    : array<u32>;
// per-pair: shed index
@group(0) @binding(3) var<storage, read> shedIndex : array<u32>;
// per-shed: vec2<u32>(offset, count)
@group(0) @binding(4) var<storage, read> shedRange : array<vec2<u32>>;
// per-seek: vec4<u32> has-mask
@group(0) @binding(5) var<storage, read> seekHas   : array<vec4<u32>>;
// per-seek: vec4<u32> not-mask
@group(0) @binding(6) var<storage, read> seekNot   : array<vec4<u32>>;
// per-seek: mult
@group(0) @binding(7) var<storage, read> seekMults : array<f32>;
// output
@group(0) @binding(8) var<storage, read_write> outMods : array<f32>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
    let i = gid.x;
    if (i >= U.n) { return; }

    let shed = shedIndex[i];
    let range = shedRange[shed];
    let off   = range.x;
    let count = range.y;
    if (count == 0u) { outMods[i] = 1.0; return; }

    let syn = pop_mask[popIds[i]];
    let invSyn = ~syn;

    var v: f32 = 1.0;
    for (var k: u32 = 0u; k < count; k = k + 1u) {
        let idx = off + k;
        let has = seekHas[idx];
        let notM = seekNot[idx];

        let hasOverlap = (has & syn);
        let notMissing = (notM & invSyn);
        let anyHas  = (hasOverlap.x | hasOverlap.y | hasOverlap.z | hasOverlap.w) != 0u;
        let anyNot  = (notMissing.x | notMissing.y | notMissing.z | notMissing.w) != 0u;

        if (anyHas || anyNot) {
            v = v * seekMults[idx];
        }
    }
    outMods[i] = v;
}
`;

export interface SeekModInputs {
	/** Caller-owned GPU buffer of u32 mask words, length >= (maxPopId+1) ×
	 * MASK_WORDS. Typically `world.gpuPopState.popMaskBuffer`. */
	popMaskBuffer: GpuBufferRef;
	/** Per-pair: which population this pair refers to (index into pop_mask). */
	popIds: Uint32Array;
	/** Per-pair: which shed in the batch this pair belongs to. */
	shedIndex: Uint32Array;

	/** Per-shed: offset into the flattened seek arrays. */
	seekOffsets: Uint32Array;
	/** Per-shed: number of seeks. */
	seekCounts: Uint32Array;

	/** Flattened per-seek mask arrays. Length `totalSeeks * MASK_WORDS`. */
	seekHas: Uint32Array;
	seekNot: Uint32Array;
	seekMults: Float32Array;
}

export class SeekModKernel {
	private kernel: GpuKernel;

	constructor(ctx: GpuContext) {
		this.kernel = new GpuKernel(ctx, {
			label: 'seekMod',
			wgsl: SEEK_MOD_WGSL,
			entryPoint: 'main',
			workgroupSize: 64,
			bindings: [
				{ binding: 0, kind: 'uniform' },
				{ binding: 1, kind: 'read' },
				{ binding: 2, kind: 'read' },
				{ binding: 3, kind: 'read' },
				{ binding: 4, kind: 'read' },
				{ binding: 5, kind: 'read' },
				{ binding: 6, kind: 'read' },
				{ binding: 7, kind: 'read' },
				{ binding: 8, kind: 'read_write' },
			],
		});
	}

	async run(inputs: SeekModInputs): Promise<Float32Array> {
		const n = inputs.shedIndex.length;
		if (n === 0) return new Float32Array(0);

		// Pack shed offset/count into vec2<u32>[nSheds].
		const nSheds = inputs.seekOffsets.length;
		const shedRangePacked = new Uint32Array(nSheds * 2);
		for (let s = 0; s < nSheds; s++) {
			shedRangePacked[s * 2]     = inputs.seekOffsets[s] >>> 0;
			shedRangePacked[s * 2 + 1] = inputs.seekCounts[s] >>> 0;
		}

		const uniforms = new Uint32Array([n >>> 0, 0, 0, 0]);

		const result = await this.kernel.dispatch(
			[
				{ binding: 0, data: uniforms },
				{ binding: 1, buffer: inputs.popMaskBuffer },
				{ binding: 2, data: inputs.popIds },
				{ binding: 3, data: inputs.shedIndex },
				{ binding: 4, data: shedRangePacked },
				{ binding: 5, data: inputs.seekHas },
				{ binding: 6, data: inputs.seekNot },
				{ binding: 7, data: inputs.seekMults },
			],
			[{ binding: 8, floatLength: n }],
			n,
		);
		return result.get(8) ?? new Float32Array(n);
	}
}
