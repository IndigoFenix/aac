/**
 * GpuPopState — GPU-resident population state.
 *
 * Phase 1 of the GPU-resident refactor: instead of re-uploading per-pair
 * `popCount` and `synMask` arrays inside every kernel dispatch, we keep
 * a single set of buffers on the GPU indexed by `Population.id`:
 *
 *   pop_count[id]  → u32 — Population.pop count for that id
 *   pop_mask[id*W .. id*W+W) → u32 — Population.primary_subsyndrome.trait_mask
 *
 * The buffers are refreshed at the start of every phase by walking
 * `World.populations_by_id` (typically 1k-5k entries, so the upload itself
 * is in the tens of microseconds). Within a phase the kernels read these
 * buffers directly; the CPU does not touch them until the next phase
 * starts.
 *
 * Phases 2+ will let kernels *write* into these buffers (atomic-update
 * applyDeltaShift on GPU). For now they're read-only from the kernels'
 * point of view.
 *
 * Test mode (jsdom, no WebGPU) instantiates this with `ctx === null`. The
 * staging arrays still get populated so CPU paths in the batch wrappers
 * have a single source of truth; the buffer fields stay null and GPU
 * paths are simply not taken.
 */

import { MASK_WORDS } from './traitMask';
import type { GpuContext } from './GpuContext';

interface PopulationLike {
	id: number;
	pop: number;
	primary_subsyndrome: { trait_mask: Uint32Array };
}

interface MinimalGPUDevice {
	createBuffer(desc: { size: number; usage: number }): MinimalGPUBuffer;
}

interface MinimalGPUBuffer {
	destroy?(): void;
}

interface MinimalGPUQueue {
	writeBuffer(buffer: MinimalGPUBuffer, offset: number, data: ArrayBufferView): void;
}

const USAGE_STORAGE_COPY_DST = 0x80 | 0x08;

const INITIAL_CAPACITY = 256;

export class GpuPopState {
	/** May be null in jsdom / non-WebGPU environments. */
	readonly ctx: GpuContext | null;

	/** Current allocation capacity (entries, not bytes). Grows geometrically. */
	capacity: number;

	/** CPU-side staging mirror. Always populated; the source of truth for the
	 * "what would the GPU see right now" view. CPU fallback paths can read
	 * directly from these arrays. */
	popCount: Uint32Array;
	popMask: Uint32Array;

	/** GPU buffer holding `popCount`. Null when WebGPU is unavailable. */
	popCountBuffer: MinimalGPUBuffer | null = null;
	/** GPU buffer holding `popMask`. Null when WebGPU is unavailable. */
	popMaskBuffer: MinimalGPUBuffer | null = null;

	constructor(ctx: GpuContext | null, initialCapacity: number = INITIAL_CAPACITY) {
		this.ctx = ctx;
		this.capacity = initialCapacity;
		this.popCount = new Uint32Array(initialCapacity);
		this.popMask = new Uint32Array(initialCapacity * MASK_WORDS);
		if (ctx) {
			const device = ctx.device as unknown as MinimalGPUDevice;
			this.popCountBuffer = device.createBuffer({
				size: initialCapacity * 4,
				usage: USAGE_STORAGE_COPY_DST,
			});
			this.popMaskBuffer = device.createBuffer({
				size: initialCapacity * MASK_WORDS * 4,
				usage: USAGE_STORAGE_COPY_DST,
			});
		}
	}

	/** Grow the underlying buffers so that at least `n` Population slots fit. */
	ensureCapacity(n: number): void {
		if (n <= this.capacity) return;
		let cap = this.capacity;
		while (cap < n) cap *= 2;
		this.capacity = cap;

		const newCount = new Uint32Array(cap);
		const newMask = new Uint32Array(cap * MASK_WORDS);
		newCount.set(this.popCount);
		newMask.set(this.popMask);
		this.popCount = newCount;
		this.popMask = newMask;

		if (this.ctx) {
			this.popCountBuffer?.destroy?.();
			this.popMaskBuffer?.destroy?.();
			const device = this.ctx.device as unknown as MinimalGPUDevice;
			this.popCountBuffer = device.createBuffer({
				size: cap * 4,
				usage: USAGE_STORAGE_COPY_DST,
			});
			this.popMaskBuffer = device.createBuffer({
				size: cap * MASK_WORDS * 4,
				usage: USAGE_STORAGE_COPY_DST,
			});
		}
	}

	/**
	 * Refresh the mirror + GPU buffers from the world's population list.
	 * Call at phase boundaries — after `applyPhaseDelta` mutates pop state
	 * and before the next phase's kernels run.
	 *
	 * Per call cost: O(n * MASK_WORDS) staging-array writes + a single
	 * writeBuffer per buffer (GPU-side memcpy of the full capacity range).
	 * At 2,500 pops with MASK_WORDS=4 the staging step is ~10 µs and the
	 * uploads are bounded by PCIe bandwidth (~µs).
	 */
	uploadFromPopulations(populations: ReadonlyArray<PopulationLike | null | undefined>): void {
		// Find highest live id so we know how much to grow / how much to upload.
		let maxId = -1;
		for (let i = 0; i < populations.length; i++) {
			const p = populations[i];
			if (p && p.id > maxId) maxId = p.id;
		}
		if (maxId < 0) return; // no populations to upload
		this.ensureCapacity(maxId + 1);

		for (let i = 0; i < populations.length; i++) {
			const p = populations[i];
			if (!p) continue;
			const id = p.id;
			this.popCount[id] = p.pop >>> 0;
			const dst = id * MASK_WORDS;
			const src = p.primary_subsyndrome.trait_mask;
			for (let w = 0; w < MASK_WORDS; w++) {
				this.popMask[dst + w] = src[w];
			}
		}

		if (this.ctx && this.popCountBuffer && this.popMaskBuffer) {
			const queue = this.ctx.queue as unknown as MinimalGPUQueue;
			// Upload the whole capacity range — fixed cost is dominated by the
			// dispatch path anyway and avoids tracking dirty slots.
			queue.writeBuffer(this.popCountBuffer, 0, this.popCount);
			queue.writeBuffer(this.popMaskBuffer, 0, this.popMask);
		}
	}

	dispose(): void {
		this.popCountBuffer?.destroy?.();
		this.popMaskBuffer?.destroy?.();
		this.popCountBuffer = null;
		this.popMaskBuffer = null;
	}
}
