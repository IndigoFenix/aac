/**
 * applyShedKernel — WGSL compute kernel for batched shed-application math.
 *
 * Output layout (one entry per pair, 20 bytes each, stride 20):
 *   hits: f32          — 0 when unchanged / no hits, kernel-computed otherwise
 *   mask: 4 × u32      — target trait mask. CPU post-pass resolves this to a
 *                        SubSyndrome.id via `materializeSubSyndromeByMask`.
 *
 * The kernel does the heavy per-pair math (hit count + mask-bit ops) in
 * parallel; resolving the resulting mask to a stable id is left to the CPU
 * so we don't pay a `mapAsync` readback to discover GPU-assigned ids on
 * every dispatch. The pre-Phase-2b design.
 *
 * Pair struct (16 bytes, stride 16):
 *   vectorCount: f32, modPairId: u32, isPrecise: u32, popId: u32
 *
 * Mod struct (48 bytes, stride 48):
 *   multiplier: f32 + 3 pad + applyMask: vec4<u32> + removeMask: vec4<u32>
 */

import type { GpuContext } from './GpuContext';
import { GpuKernel, type GpuBufferRef } from './GpuKernel';
import { MASK_WORDS } from './traitMask';

if (MASK_WORDS !== 4) {
	throw new Error(`MASK_WORDS=${MASK_WORDS} but applyShedKernel.wgsl assumes 4`);
}

/** Pair struct stride in u32 slots: 4 scalars = 16 bytes. */
const PAIR_FLOATS_PER_ENTRY = 4;
/** Mod struct stride in u32 slots: 12 = 48 bytes. */
const MOD_FLOATS_PER_ENTRY = 12;
/** Output struct stride in u32 slots: hits(f32) + 4 mask u32 = 5 = 20 bytes. */
const OUT_FLOATS_PER_ENTRY = 5;

const APPLY_SHED_WGSL = /* wgsl */ `
struct Uniforms { n: u32, _pad0: u32, _pad1: u32, _pad2: u32 };

struct Pair {
    vectorCount: f32,
    modPairId: u32,
    isPrecise: u32,
    popId: u32,
};

struct ModEntry {
    multiplier: f32,
    _pad0: u32,
    _pad1: u32,
    _pad2: u32,
    applyMask: vec4<u32>,
    removeMask: vec4<u32>,
};

struct OutEntry {
    hits: f32,
    mask0: u32,
    mask1: u32,
    mask2: u32,
    mask3: u32,
};

@group(0) @binding(0) var<uniform> U : Uniforms;
@group(0) @binding(1) var<storage, read>       pairs        : array<Pair>;
@group(0) @binding(2) var<storage, read>       mods         : array<ModEntry>;
@group(0) @binding(3) var<storage, read>       pop_count    : array<u32>;
@group(0) @binding(4) var<storage, read>       pop_mask     : array<vec4<u32>>;
@group(0) @binding(5) var<storage, read_write> outs         : array<OutEntry>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let i = gid.x;
    if (i >= U.n) { return; }

    let p = pairs[i];
    let popCount = f32(pop_count[p.popId]);
    if (popCount <= 0.0 || p.vectorCount <= 0.0) { outs[i].hits = 0.0; return; }

    let m = mods[p.modPairId];

    var h: f32;
    if (p.isPrecise == 1u) {
        h = p.vectorCount * m.multiplier;
    } else {
        let pp   = (1.0 / popCount) * m.multiplier;
        let prob = 1.0 - pow(1.0 - pp, p.vectorCount);
        h = popCount * prob;
    }
    if (h > p.vectorCount) { h = p.vectorCount; }
    if (h <= 0.0) { outs[i].hits = 0.0; return; }

    let src = pop_mask[p.popId];
    let tgt = (src | m.applyMask) & ~m.removeMask;
    let diff   = tgt ^ src;
    let isSame = (diff.x | diff.y | diff.z | diff.w) == 0u;
    if (isSame) { outs[i].hits = 0.0; return; }

    outs[i].hits = h;
    outs[i].mask0 = tgt.x;
    outs[i].mask1 = tgt.y;
    outs[i].mask2 = tgt.z;
    outs[i].mask3 = tgt.w;
}
`;

export interface ApplyShedInputs {
	vectorCounts: Float32Array;    // length n
	modPairId: Uint32Array;        // length n
	precise: Uint32Array;          // length n
	popIds: Uint32Array;           // length n — note: this is also the source SubSyndrome.id
	popCountBuffer: GpuBufferRef;
	popMaskBuffer: GpuBufferRef;
	modMultipliers: Float32Array;
	modApplyMask: Uint32Array;
	modRemoveMask: Uint32Array;
}

export interface ApplyShedOutputs {
	hitCounts: Float32Array;   // length n
	targetMasks: Uint32Array;  // length n * MASK_WORDS, packed row-major
}

export class ApplyShedKernel {
	private kernel: GpuKernel;

	constructor(ctx: GpuContext) {
		this.kernel = new GpuKernel(ctx, {
			label: 'applyShed',
			wgsl: APPLY_SHED_WGSL,
			entryPoint: 'main',
			workgroupSize: 64,
			bindings: [
				{ binding: 0, kind: 'uniform' },
				{ binding: 1, kind: 'read' },
				{ binding: 2, kind: 'read' },
				{ binding: 3, kind: 'read' },
				{ binding: 4, kind: 'read' },
				{ binding: 5, kind: 'read_write' },
			],
		});
	}

	async run(inputs: ApplyShedInputs): Promise<ApplyShedOutputs> {
		const n = inputs.vectorCounts.length;
		if (n === 0) {
			return { hitCounts: new Float32Array(0), targetMasks: new Uint32Array(0) };
		}
		const nMod = inputs.modMultipliers.length;

		const pairBuf = new ArrayBuffer(n * PAIR_FLOATS_PER_ENTRY * 4);
		const pairF32 = new Float32Array(pairBuf);
		const pairU32 = new Uint32Array(pairBuf);
		for (let i = 0; i < n; i++) {
			const o = i * PAIR_FLOATS_PER_ENTRY;
			pairF32[o]     = inputs.vectorCounts[i];
			pairU32[o + 1] = inputs.modPairId[i] >>> 0;
			pairU32[o + 2] = inputs.precise[i] >>> 0;
			pairU32[o + 3] = inputs.popIds[i] >>> 0;
		}

		const modBuf = new ArrayBuffer(Math.max(MOD_FLOATS_PER_ENTRY * 4, nMod * MOD_FLOATS_PER_ENTRY * 4));
		const modF32 = new Float32Array(modBuf);
		const modU32 = new Uint32Array(modBuf);
		for (let i = 0; i < nMod; i++) {
			const o = i * MOD_FLOATS_PER_ENTRY;
			modF32[o] = inputs.modMultipliers[i];
			const maskOff = i * MASK_WORDS;
			for (let w = 0; w < MASK_WORDS; w++) {
				modU32[o + 4 + w] = inputs.modApplyMask[maskOff + w] >>> 0;
				modU32[o + 8 + w] = inputs.modRemoveMask[maskOff + w] >>> 0;
			}
		}

		const uniforms = new Uint32Array([n >>> 0, 0, 0, 0]);

		const result = await this.kernel.dispatch(
			[
				{ binding: 0, data: uniforms },
				{ binding: 1, data: new Uint32Array(pairBuf) },
				{ binding: 2, data: new Uint32Array(modBuf) },
				{ binding: 3, buffer: inputs.popCountBuffer },
				{ binding: 4, buffer: inputs.popMaskBuffer },
			],
			[{ binding: 5, floatLength: n * OUT_FLOATS_PER_ENTRY }],
			n,
		);

		const outRaw = result.get(5) ?? new Float32Array(n * OUT_FLOATS_PER_ENTRY);
		const outF32 = outRaw;
		const outU32 = new Uint32Array(outRaw.buffer, outRaw.byteOffset, outRaw.length);
		const hitCounts = new Float32Array(n);
		const targetMasks = new Uint32Array(n * MASK_WORDS);
		for (let i = 0; i < n; i++) {
			const o = i * OUT_FLOATS_PER_ENTRY;
			hitCounts[i] = outF32[o];
			const mOff = i * MASK_WORDS;
			targetMasks[mOff + 0] = outU32[o + 1];
			targetMasks[mOff + 1] = outU32[o + 2];
			targetMasks[mOff + 2] = outU32[o + 3];
			targetMasks[mOff + 3] = outU32[o + 4];
		}
		return { hitCounts, targetMasks };
	}
}
