/**
 * GpuContext — WebGPU device + queue holder for the simulation worker.
 *
 * Constructed via the static `create()` factory which performs the async
 * adapter/device handshake. Returns null when WebGPU is unavailable
 * (jsdom, Firefox without flag, older Safari) — callers must handle
 * the null case and fall back to the CPU path.
 */

interface MinimalGPU {
	requestAdapter(): Promise<MinimalGPUAdapter | null>;
}

interface MinimalGPUAdapter {
	readonly limits?: Record<string, number>;
	requestDevice(desc?: { requiredLimits?: Record<string, number> }): Promise<MinimalGPUDevice>;
}

interface MinimalGPUDevice {
	queue: MinimalGPUQueue;
	createShaderModule(desc: { code: string; label?: string }): MinimalShaderModule;
	createComputePipeline(desc: unknown): unknown;
	createBuffer(desc: { size: number; usage: number; mappedAtCreation?: boolean }): MinimalGPUBuffer;
	createBindGroup(desc: unknown): unknown;
	destroy?(): void;
	addEventListener?(type: 'uncapturederror', listener: (ev: { error?: { message?: string } }) => void): void;
}

interface MinimalShaderModule {
	getCompilationInfo?(): Promise<{ messages: { type: string; message: string; lineNum: number; linePos: number }[] }>;
}

interface MinimalGPUQueue {
	writeBuffer(buffer: MinimalGPUBuffer, offset: number, data: ArrayBufferView): void;
	submit(commandBuffers: unknown[]): void;
}

interface MinimalGPUBuffer {
	destroy?(): void;
	mapAsync(mode: number): Promise<void>;
	getMappedRange(offset?: number, size?: number): ArrayBuffer;
	unmap(): void;
}

export class GpuContext {
	readonly device: MinimalGPUDevice;
	readonly queue: MinimalGPUQueue;
	private shaderCache = new Map<string, unknown>();

	private constructor(device: MinimalGPUDevice) {
		this.device = device;
		this.queue = device.queue;
	}

	/**
	 * Try to acquire a WebGPU device. Returns null when WebGPU is not
	 * available or the adapter/device request fails. Never throws on
	 * unsupported environments.
	 */
	static async create(): Promise<GpuContext | null> {
		const gpu = (globalThis as { navigator?: { gpu?: MinimalGPU } }).navigator?.gpu;
		if (!gpu) return null;
		try {
			const adapter = await gpu.requestAdapter();
			if (!adapter) return null;
			// Request the adapter's full advertised limits for the kernels
			// that exceed the WebGPU defaults. The applyShed kernel binds
			// 15 storage buffers and the seekMod kernel binds 12; the spec
			// default for `maxStorageBuffersPerShaderStage` is 8, so without
			// these requests the pipelines silently misbehave on a default
			// device (sheds aren't applied, transmissions never propagate).
			//
			// Limits are *opt-in*: calling requestDevice without them leaves
			// you on the spec defaults regardless of what the adapter
			// supports. We forward the adapter's reported maximums for
			// every limit the simulation actually depends on.
			const wanted = [
				'maxStorageBuffersPerShaderStage',
				'maxStorageBufferBindingSize',
				'maxBindingsPerBindGroup',
				'maxBufferSize',
				'maxComputeWorkgroupStorageSize',
				'maxComputeInvocationsPerWorkgroup',
				'maxComputeWorkgroupSizeX',
				'maxComputeWorkgroupsPerDimension',
			];
			const requiredLimits: Record<string, number> = {};
			const adapterLimits = adapter.limits ?? {};
			for (const name of wanted) {
				const v = adapterLimits[name];
				if (typeof v === 'number') requiredLimits[name] = v;
			}
			const device = await adapter.requestDevice({ requiredLimits });
			if (!device) return null;
			// Surface validation / out-of-memory errors instead of letting
			// them disappear into a console message. Without this, a failing
			// pipeline silently produces zero outputs and the simulation
			// looks "broken" with no log signal.
			device.addEventListener?.('uncapturederror', (ev) => {
				console.error('[gpu] uncaptured device error:', ev.error?.message ?? ev);
			});
			return new GpuContext(device);
		} catch {
			return null;
		}
	}

	/**
	 * Compile a WGSL shader module, caching by source so the same kernel
	 * doesn't recompile across calls. Awaits compilation info so any WGSL
	 * errors / warnings surface in the console *before* the pipeline tries
	 * to use the module — without that, a bad kernel just produces
	 * "Invalid ComputePipeline (previous error)" later, with no clue why.
	 */
	async getShaderModule(code: string): Promise<unknown> {
		const cached = this.shaderCache.get(code);
		if (cached) return cached;
		const mod = this.device.createShaderModule({ code });
		this.shaderCache.set(code, mod);
		const infoFn = (mod as MinimalShaderModule).getCompilationInfo;
		if (infoFn) {
			try {
				const r = await infoFn.call(mod);
				let hadError = false;
				for (const m of r.messages) {
					const tag = `[gpu] WGSL ${m.type}`;
					const where = `(line ${m.lineNum}:${m.linePos})`;
					if (m.type === 'error') { console.error(tag, where, m.message); hadError = true; }
					else if (m.type === 'warning') console.warn(tag, where, m.message);
					else console.log(tag, where, m.message);
				}
				if (hadError) {
					// Dump the offending WGSL with line numbers so we can match the
					// reported coordinates without guessing.
					const lines = code.split('\n');
					const numbered = lines.map((l, i) => `${String(i + 1).padStart(3, ' ')}  ${l}`).join('\n');
					console.error('[gpu] WGSL source:\n' + numbered);
				}
			} catch { /* non-fatal */ }
		}
		return mod;
	}

	dispose(): void {
		this.shaderCache.clear();
		this.device.destroy?.();
	}
}
