/**
 * GpuKernel — compile-once dispatch helper for a WGSL compute shader.
 *
 * A kernel is described declaratively (shader source + entry point +
 * binding layout). The first dispatch compiles the pipeline; subsequent
 * dispatches reuse it. Buffers are allocated/written/read per call; pooling
 * is a future optimization that callers can add transparently.
 *
 * Bindings come in three flavors:
 *   - `uniform`: small Uint32Array passed in @group(0) @binding=N as `var<uniform>`.
 *   - `read`:    Float32Array or Uint32Array passed as `var<storage, read>`.
 *   - `read_write`: writeable buffer; readback into a fresh ArrayBuffer.
 *
 * The dispatch input/output names are typed via the BindingShape generic.
 */

import type { GpuContext } from './GpuContext';

// Minimal subset of the WebGPU type surface — vite/browser provides the real
// thing at runtime.
interface MinimalDevice {
	createBuffer(desc: { size: number; usage: number; mappedAtCreation?: boolean }): MinimalBuffer;
	createBindGroup(desc: { layout: unknown; entries: { binding: number; resource: { buffer: MinimalBuffer } }[] }): unknown;
	createCommandEncoder(): MinimalCommandEncoder;
	createComputePipeline(desc: { layout: 'auto'; compute: { module: unknown; entryPoint: string } }): MinimalPipeline;
}
interface MinimalBuffer {
	destroy?(): void;
	mapAsync(mode: number): Promise<void>;
	getMappedRange(offset?: number, size?: number): ArrayBuffer;
	unmap(): void;
}
interface MinimalCommandEncoder {
	beginComputePass(): MinimalComputePass;
	copyBufferToBuffer(src: MinimalBuffer, srcOffset: number, dst: MinimalBuffer, dstOffset: number, size: number): void;
	finish(): unknown;
}
interface MinimalComputePass {
	setPipeline(p: MinimalPipeline): void;
	setBindGroup(group: number, bg: unknown): void;
	dispatchWorkgroups(x: number, y?: number, z?: number): void;
	end(): void;
}
interface MinimalPipeline {
	getBindGroupLayout(group: number): unknown;
}

// WebGPU buffer usage flags (browser-defined; we hard-code so the file
// doesn't depend on @webgpu/types being present).
const USAGE = {
	UNIFORM: 0x40,
	STORAGE: 0x80,
	COPY_SRC: 0x04,
	COPY_DST: 0x08,
	MAP_READ: 0x01,
} as const;

const MAP_MODE_READ = 0x01;

export type BindingKind = 'uniform' | 'read' | 'read_write';
export interface BindingDef {
	binding: number;
	kind: BindingKind;
}

/**
 * Minimal handle for a caller-owned GPU buffer passed into `dispatch`. We
 * deliberately don't require the readback methods (`mapAsync` etc.) here
 * since input bindings never need them — `GpuPopState` returns a writeable
 * storage buffer that satisfies only this narrower contract. */
export interface GpuBufferRef {
	destroy?(): void;
}

/**
 * One input binding for `dispatch`. Provide exactly one of `data` (the
 * wrapper will create a fresh buffer and upload the typed array) or
 * `buffer` (a pre-allocated, caller-owned GPUBuffer that survives across
 * dispatches — used for the GpuPopState population state arrays).
 */
export interface DispatchInput {
	binding: number;
	data?: Float32Array | Uint32Array;
	buffer?: GpuBufferRef;
}

export interface KernelDescriptor {
	label: string;
	wgsl: string;
	entryPoint: string;
	bindings: ReadonlyArray<BindingDef>;
	workgroupSize: number;
}

/** Pooled per-kernel buffer. `cap` is the buffer's byte size; if a later
 * dispatch needs more we destroy + reallocate, otherwise we reuse and
 * just `writeBuffer` the new contents on top. */
interface PooledBuffer {
	buf: MinimalBuffer;
	cap: number;
	usage: number;
}

export class GpuKernel {
	private pipeline: MinimalPipeline | null = null;
	/** Pooled input/output buffers, keyed by binding index. `dispatch`
	 * grows them geometrically; they outlive the dispatch and survive
	 * across calls so we don't pay `createBuffer + destroy` for every
	 * frame. At scale this is the dominant non-mapAsync cost — the
	 * applyShed kernel's mod buffer is ~6.7 MB at 4 k pops, and
	 * recreating it every dispatch was ~50 ms of pure allocation churn. */
	private pooledInputs: Map<number, PooledBuffer> = new Map();
	private pooledOutputs: Map<number, PooledBuffer> = new Map();
	private pooledReadbacks: Map<number, PooledBuffer> = new Map();

	constructor(
		private readonly ctx: GpuContext,
		private readonly desc: KernelDescriptor,
	) { }

	/**
	 * Run the kernel. `inputs` is keyed by binding index; the value type
	 * tells us how to upload it. `n` is the number of work items (used for
	 * workgroup count). `readBindings` lists which output bindings to read
	 * back; the result is keyed by binding index. Output buffers are
	 * Float32Array unless the binding name ends with 'U32' (caller-side
	 * convention — we pick byte size based on the input shape).
	 */
	async dispatch(
		inputs: ReadonlyArray<DispatchInput>,
		readback: ReadonlyArray<{ binding: number; floatLength: number }>,
		n: number,
	): Promise<Map<number, Float32Array>> {
		const device = this.ctx.device as unknown as MinimalDevice;
		if (!this.pipeline) {
			const shaderModule = await this.ctx.getShaderModule(this.desc.wgsl);
			this.pipeline = device.createComputePipeline({
				layout: 'auto',
				compute: { module: shaderModule, entryPoint: this.desc.entryPoint },
			});
		}

		const entries: { binding: number; resource: { buffer: MinimalBuffer } }[] = [];

		// Inputs (uniform / storage-read). For data-backed bindings we
		// pull a pooled buffer of matching usage; for caller-owned buffers
		// (e.g. GpuPopState.popCountBuffer) we bind them directly.
		for (const inp of inputs) {
			let buf: MinimalBuffer;
			if (inp.buffer !== undefined) {
				buf = inp.buffer as MinimalBuffer;
			} else {
				const data = inp.data;
				if (data === undefined) {
					throw new Error(`Binding ${inp.binding} in kernel ${this.desc.label} needs either data or buffer`);
				}
				const def = this.desc.bindings.find(b => b.binding === inp.binding);
				if (!def) throw new Error(`No binding for binding ${inp.binding} in kernel ${this.desc.label}`);
				const usage = def.kind === 'uniform'
					? USAGE.UNIFORM | USAGE.COPY_DST
					: USAGE.STORAGE | USAGE.COPY_DST;
				buf = ensurePooled(device, this.pooledInputs, inp.binding, data.byteLength, usage);
				this.ctx.queue.writeBuffer(buf, 0, data);
			}
			entries.push({ binding: inp.binding, resource: { buffer: buf } });
		}

		// Output buffers (storage read_write)
		const outputs = new Map<number, MinimalBuffer>();
		for (const r of readback) {
			const size = r.floatLength * 4;
			const buf = ensurePooled(device, this.pooledOutputs, r.binding, size, USAGE.STORAGE | USAGE.COPY_SRC);
			outputs.set(r.binding, buf);
			entries.push({ binding: r.binding, resource: { buffer: buf } });
		}

		const bindGroup = device.createBindGroup({
			layout: this.pipeline.getBindGroupLayout(0),
			entries,
		});

		// Dispatch.
		const encoder = device.createCommandEncoder();
		const pass = encoder.beginComputePass();
		pass.setPipeline(this.pipeline);
		pass.setBindGroup(0, bindGroup);
		const groups = Math.ceil(n / this.desc.workgroupSize);
		pass.dispatchWorkgroups(groups);
		pass.end();

		// Copy output buffers to mappable readback buffers. The readback
		// buffers are also pooled so we don't churn on a 1-2 MB allocation
		// every applyShed dispatch.
		const readBuffers = new Map<number, MinimalBuffer>();
		for (const r of readback) {
			const size = r.floatLength * 4;
			const out = outputs.get(r.binding)!;
			const rb = ensurePooled(device, this.pooledReadbacks, r.binding, size, USAGE.MAP_READ | USAGE.COPY_DST);
			encoder.copyBufferToBuffer(out, 0, rb, 0, Math.max(16, size));
			readBuffers.set(r.binding, rb);
		}

		this.ctx.queue.submit([encoder.finish()]);

		// Read results.
		const results = new Map<number, Float32Array>();
		for (const r of readback) {
			const rb = readBuffers.get(r.binding)!;
			await rb.mapAsync(MAP_MODE_READ);
			// `slice` is intentional — the mapped range is invalidated by
			// `unmap` below, and we need the caller to keep the data after
			// we move on to the next dispatch (which will re-map the same
			// pooled readback buffer).
			const view = new Float32Array(rb.getMappedRange().slice(0, r.floatLength * 4));
			rb.unmap();
			results.set(r.binding, view);
		}

		return results;
	}

	/** Release every pooled buffer. Called from GpuContext.dispose() —
	 * leave the JIT'd pipeline alone so we don't pay recompilation if
	 * someone reinstantiates the kernel later in the session. */
	dispose(): void {
		for (const p of this.pooledInputs.values()) p.buf.destroy?.();
		for (const p of this.pooledOutputs.values()) p.buf.destroy?.();
		for (const p of this.pooledReadbacks.values()) p.buf.destroy?.();
		this.pooledInputs.clear();
		this.pooledOutputs.clear();
		this.pooledReadbacks.clear();
	}
}

/** Return a pooled buffer at least `byteLength` bytes (rounded to 16-byte
 * minimum, geometric growth). Destroy + reallocate when we outgrow the
 * existing slot or when the usage flags differ (we can't mix
 * uniform/storage/read/write). */
function ensurePooled(
	device: MinimalDevice,
	pool: Map<number, PooledBuffer>,
	binding: number,
	byteLength: number,
	usage: number,
): MinimalBuffer {
	const need = Math.max(16, byteLength);
	const existing = pool.get(binding);
	if (existing && existing.usage === usage && existing.cap >= need) return existing.buf;
	// Grow geometrically so a slowly increasing workload doesn't trigger a
	// realloc every frame.
	let cap = existing?.cap ?? 16;
	while (cap < need) cap *= 2;
	existing?.buf.destroy?.();
	const buf = device.createBuffer({ size: cap, usage });
	pool.set(binding, { buf, cap, usage });
	return buf;
}
