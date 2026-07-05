/**
 * applyShedBatch — pre-pass / dispatch / post-pass for the applyShed math.
 *
 * Site.updateContact collects (shed, pop) pairs after seek-weight
 * allocation and the per-pair vectorCount. This module handles the rest in
 * batch form, with the hot loops living inside WASM linear memory.
 *
 * Pipeline (WASM path — present whenever the WASM module loaded; about
 * everywhere except jsdom-without-fs):
 *   1. Pre-pass writes per-pair inputs (popIds, sourceIds, vectorCounts,
 *      modPairId, precise) and the sparse mod table (multipliers +
 *      apply/remove masks) **directly into WASM linear-memory views**, with
 *      no JS-side scratch.
 *   2a. GPU path: WGSL kernel dispatches with the same WASM views as input
 *       buffers; output (hits + targetMasks) comes back via mapAsync and is
 *       copied into the WASM views. `processPostPass(n)` walks them to
 *       resolve target ids and emit `(popId, sourceId, targetId, hits)`
 *       tuples into the WASM out-buffers.
 *   2b. CPU path: no kernel. `cpuApplyAndPostPass(n)` runs the entire
 *       dispatch math (hit counts, target mask, unchanged check) plus id
 *       resolution and tuple emission in a single WASM call.
 *   3. After the WASM batch, the CPU SubSyndrome registry catches up for
 *      any newly-allocated ids (one SubSyndrome construction per new
 *      target). The deduplicated output tuples are then pumped into
 *      PhaseDelta via `addPopShift`.
 *
 * Pure-JS fallback (no WASM) keeps the old per-pair `materializeSubSyndrome
 * ByMask` semantics so tests in environments without WASM still pass.
 */

import { cpuApplyShed } from './cpuApplyShed';
import type { ApplyShedKernel } from './applyShedKernel';
import { MASK_WORDS } from './traitMask';
import type { PhaseDelta } from '../../game/simulation/PhaseDelta';
import type { SubsynRegistryWasm } from './subsynRegistryWasm';
import { gpuDebugShouldLog, gpuDebugLog, gpuDebugCompare } from './gpuDebug';
import { profiler } from '../../core/Profiler';

interface SubSyndromeRuntime {
	id: number;
	trait_mask: Uint32Array;
}

interface PopulationRuntime {
	id: number;
	pop: number;
	primary_subsyndrome: SubSyndromeRuntime;
	syndrome: SyndromeRuntime;
}

export interface SyndromeRuntime {
	getContactMod(shed: ShedRuntime, site: SiteRuntime): ModifiedShedRuntime;
}

interface ShedRuntime {
	key: string;
	precise: boolean;
}

interface SiteRuntime {
	key: string;
}

interface ModifiedShedRuntime {
	multiplier: number;
	apply_mask: Uint32Array;
	remove_mask: Uint32Array;
}

interface WorldRuntime {
	traits_kv: Record<string, { index: number } | undefined>;
	materializeSubSyndromeByMask(mask: Uint32Array, offset?: number): SubSyndromeRuntime;
	gpuPopState: import('./GpuPopState').GpuPopState | null;
	subsynWasm: SubsynRegistryWasm | null;
	materializeSubsynRange?(from: number, to: number, scratch: Uint32Array): void;
}

export interface ApplyShedBatchInputs {
	world: WorldRuntime;
	site: SiteRuntime;
	sheds: ShedRuntime[];
	syndromes: SyndromeRuntime[];
	pairCount: number;
	pairShedIdx: Uint32Array;
	pairSynIdx: Uint32Array;
	pairVectorCount: Float32Array;
	pairPops: PopulationRuntime[];
	pairSheds: ShedRuntime[];
	/** Pre-flattened pop ids, populated by `Site.updateContact`. Avoids a
	 * `pairPops[i].id` property access per pair in the pre-pass. */
	pairPopId: Uint32Array;
	/** Pre-flattened source SubSyndrome ids
	 * (`pairPops[i].primary_subsyndrome.id`). */
	pairSourceId: Uint32Array;
	/** Pre-flattened `shed.precise` flag (0 or 1). */
	pairPrecise: Uint8Array;
	delta: PhaseDelta;
	gpuKernel: ApplyShedKernel | null;
	/** Deterministic-rng inputs threaded through from `World.updateAllPhases`.
	 * WASM uses them to stochastically round each emitted amount to an
	 * integer in place, so the JS `applyDeltaShift` path skips its own rng
	 * draw. JS `hashUniform` is bit-equivalent for these inputs whether the
	 * caller passes a signed `-1` (init synthetic phase) or unsigned u32. */
	seed: number;
	day: number;
	phase: number;
}

/** JS-side scratch for the no-WASM fallback path. Only `touched` and the
 * per-pair JS arrays are needed since the legacy fallback re-derives target
 * masks inline. */
interface JsFallbackPool {
	modCap: number;
	pairCap: number;
	modMultipliers: Float32Array;
	modApplyMask: Uint32Array;
	modRemoveMask: Uint32Array;
	touched: Uint8Array;
	modPairId: Uint32Array;
	hitCounts: Float32Array;
	targetMasks: Uint32Array;
	tempMask: Uint32Array;
}
let jsPool: JsFallbackPool | null = null;
function ensureJsPool(nMod: number, n: number): JsFallbackPool {
	if (jsPool === null) {
		jsPool = {
			modCap: 0, pairCap: 0,
			modMultipliers: new Float32Array(0),
			modApplyMask: new Uint32Array(0),
			modRemoveMask: new Uint32Array(0),
			touched: new Uint8Array(0),
			modPairId: new Uint32Array(0),
			hitCounts: new Float32Array(0),
			targetMasks: new Uint32Array(0),
			tempMask: new Uint32Array(MASK_WORDS),
		};
	}
	if (jsPool.modCap < nMod) {
		let cap = Math.max(jsPool.modCap, 1);
		while (cap < nMod) cap *= 2;
		jsPool.modCap = cap;
		jsPool.modMultipliers = new Float32Array(cap);
		jsPool.modApplyMask = new Uint32Array(cap * MASK_WORDS);
		jsPool.modRemoveMask = new Uint32Array(cap * MASK_WORDS);
		jsPool.touched = new Uint8Array(cap);
	}
	if (jsPool.pairCap < n) {
		let cap = Math.max(jsPool.pairCap, 1);
		while (cap < n) cap *= 2;
		jsPool.pairCap = cap;
		jsPool.modPairId = new Uint32Array(cap);
		jsPool.hitCounts = new Float32Array(cap);
		jsPool.targetMasks = new Uint32Array(cap * MASK_WORDS);
	}
	return jsPool;
}

/**
 * Run the batch. Side effects only: writes popShifts into the delta.
 */
export async function runApplyShedBatch(b: ApplyShedBatchInputs): Promise<void> {
	const n = b.pairCount;
	if (n === 0) return;

	const wasm = b.world.subsynWasm;
	if (wasm !== null) {
		await runApplyShedBatchWasm(b, wasm);
	} else {
		await runApplyShedBatchJsFallback(b);
	}
}

async function runApplyShedBatchWasm(b: ApplyShedBatchInputs, wasm: SubsynRegistryWasm): Promise<void> {
	const n = b.pairCount;
	const nSheds = b.sheds.length;
	const nSyn = b.syndromes.length;
	const nMod = nSheds * nSyn;

	const stopPre = profiler.start('applyShed/pre-pass');
	// Write per-pair / per-mod data to JS-heap pool arrays first, then bulk
	// memcpy into WASM linear memory once. V8 optimizes regular typed-array
	// writes more aggressively than writes into WASM-backed buffer views
	// (per-element writes through the latter were ~2-3× slower in tsx
	// benchmarks), so the staging-then-copy pattern is a clear win at scale.
	const pool = ensureStagePool(nMod, n);
	const touched = pool.touched;
	touched.fill(0, 0, nMod);

	const pairShedIdx = b.pairShedIdx;
	const pairSynIdx = b.pairSynIdx;
	const pairSheds = b.pairSheds;
	const pairVectorCount = b.pairVectorCount;
	const pairPopId = b.pairPopId;
	const pairSourceId = b.pairSourceId;
	const pairPrecise = b.pairPrecise;

	// Reserve WASM capacity *before* the loop so we can write everything
	// directly into linear-memory views.
	const popState = b.world.gpuPopState;
	const popViewCap = popState ? popState.popCount.length : Math.max(n, 1);
	const caps = wasm.ensureCapacities(n, nMod, popViewCap);
	const pair = caps.pair;
	const mod = caps.mod;

	// Bulk-copy the per-pair source typed arrays straight into WASM linear
	// memory — `set(...)` calls into native memcpy regardless of whether
	// the destination is JS-heap or WASM-backed, so the heap-vs-WASM speed
	// gap doesn't apply here. Done up-front so the loop body has fewer
	// dependencies + fewer stores per iter.
	pair.popIds.subarray(0, n).set(pairPopId.subarray(0, n));
	pair.sourceIds.subarray(0, n).set(pairSourceId.subarray(0, n));
	pair.vectorCounts.subarray(0, n).set(pairVectorCount.subarray(0, n));
	// `precise` is Uint8 upstream, Uint32 in WASM; widen via a per-element
	// copy (a `.set()` between mismatched types would convert anyway, but
	// requires a fresh typed-array allocation — the loop is faster here).
	const wPrecise = pair.precise;
	for (let i = 0; i < n; i++) wPrecise[i] = pairPrecise[i];

	const wModMul = mod.multipliers;
	const wModApply = mod.applyMask;
	const wModRemove = mod.removeMask;
	const wModPairId = pair.modPairId;

	let maxPopId = 0;
	for (let i = 0; i < n; i++) {
		const synIdx = pairSynIdx[i];
		const m = pairShedIdx[i] * nSyn + synIdx;
		const popId = pairPopId[i];
		if (popId > maxPopId) maxPopId = popId;

		wModPairId[i] = m;

		if (touched[m]) continue;
		touched[m] = 1;
		const ms = b.syndromes[synIdx].getContactMod(pairSheds[i], b.site);
		wModMul[m] = ms.multiplier;
		const modOff = m * MASK_WORDS;
		const am = ms.apply_mask;
		const rm = ms.remove_mask;
		wModApply[modOff] = am[0];
		wModApply[modOff + 1] = am[1];
		wModApply[modOff + 2] = am[2];
		wModApply[modOff + 3] = am[3];
		wModRemove[modOff] = rm[0];
		wModRemove[modOff + 1] = rm[1];
		wModRemove[modOff + 2] = rm[2];
		wModRemove[modOff + 3] = rm[3];
	}
	stopPre();

	const canRunGpu = b.gpuKernel !== null && popState !== null
		&& popState.popCountBuffer !== null
		&& popState.popMaskBuffer !== null;

	const counterBefore = wasm.getCounter();
	let result;
	if (canRunGpu && b.gpuKernel && popState && popState.popCountBuffer && popState.popMaskBuffer) {
		const stopGpu = profiler.start('applyShed/gpu-dispatch');
		const out = await b.gpuKernel.run({
			vectorCounts: pair.vectorCounts.subarray(0, n),
			modPairId: pair.modPairId.subarray(0, n),
			precise: pair.precise.subarray(0, n),
			popIds: pair.popIds.subarray(0, n),
			popCountBuffer: popState.popCountBuffer,
			popMaskBuffer: popState.popMaskBuffer,
			modMultipliers: mod.multipliers.subarray(0, nMod),
			modApplyMask: mod.applyMask.subarray(0, nMod * MASK_WORDS),
			modRemoveMask: mod.removeMask.subarray(0, nMod * MASK_WORDS),
		});
		stopGpu();

		// Copy kernel output into the WASM-memory input views so
		// processPostPass can iterate without extra FFI passing. Views may
		// have been invalidated if the kernel.run path triggered an
		// internal grow; refresh by re-fetching from the cached pair ref.
		pair.hits.subarray(0, n).set(out.hitCounts);
		pair.targetMasks.subarray(0, n * MASK_WORDS).set(out.targetMasks);

		if (gpuDebugShouldLog('applyShed')) {
			gpuDebugLog('applyShed', `pairs=${n} mods=${nMod}`,
				{ hits: gpuDebugCompare(out.hitCounts, out.hitCounts, 0) });
		}

		const stopPost = profiler.start('applyShed/post-pass');
		result = wasm.runPostPass(n, b.seed, b.day, b.phase);
		stopPost();
	} else {
		// CPU path: stage pop state into WASM. Pop view was already
		// allocated above in ensureCapacities, so just grab it.
		const popView = caps.pop;
		if (popState !== null) {
			// Copy from GpuPopState's staging mirror (always populated,
			// even when no WebGPU device). One memcpy per phase.
			const popCnt = popState.popCount;
			const popMsk = popState.popMask;
			const cnt = popView.counts;
			const msk = popView.masks;
			cnt.subarray(0, maxPopId + 1).set(popCnt.subarray(0, maxPopId + 1));
			msk.subarray(0, (maxPopId + 1) * MASK_WORDS).set(popMsk.subarray(0, (maxPopId + 1) * MASK_WORDS));
		} else {
			// Without GpuPopState (standalone tests, no worker harness):
			// pull pop state per pop from JS. Writes are idempotent for the
			// same id, so we don't need a "already-set" check — same pop
			// appearing in many pairs just rewrites the same values.
			const cnt = popView.counts;
			const msk = popView.masks;
			const fallbackPairPops = b.pairPops;
			for (let i = 0; i < n; i++) {
				const popObj = fallbackPairPops[i];
				const id = popObj.id;
				cnt[id] = popObj.pop >>> 0;
				const src = popObj.primary_subsyndrome.trait_mask;
				const off = id * MASK_WORDS;
				msk[off] = src[0];
				msk[off + 1] = src[1];
				msk[off + 2] = src[2];
				msk[off + 3] = src[3];
			}
		}

		const stopCpu = profiler.start('applyShed/cpu-dispatch');
		result = wasm.runCpuApplyAndPostPass(n, b.seed, b.day, b.phase);
		stopCpu();
	}

	const counterAfter = wasm.getCounter();
	if (counterAfter > counterBefore && b.world.materializeSubsynRange) {
		b.world.materializeSubsynRange(counterBefore, counterAfter, wasm.tempMask);
	}

	const stopFlush = profiler.start('applyShed/flush-delta');
	// WASM dedup'd outputs internally — no key collisions in the returned
	// view. We still go through `bulkAddPopShifts` rather than blasting
	// directly into the delta's TypedArrays so any earlier same-batch
	// entries (progression sheds via `addPopShift`) merge correctly.
	b.delta.bulkAddPopShifts(
		result.outPopIds,
		result.outSourceIds,
		result.outTargetIds,
		result.outAmounts,
		result.count,
	);
	stopFlush();
}

/** Pure-JS fallback for environments where the WASM module can't load.
 * Mirrors the pre-WASM behavior. */
async function runApplyShedBatchJsFallback(b: ApplyShedBatchInputs): Promise<void> {
	const n = b.pairCount;
	const nSheds = b.sheds.length;
	const nSyn = b.syndromes.length;
	const nMod = nSheds * nSyn;

	const stopPre = profiler.start('applyShed/pre-pass');
	const pool = ensureJsPool(nMod, n);
	const modMultipliers = pool.modMultipliers;
	const modApplyMask = pool.modApplyMask;
	const modRemoveMask = pool.modRemoveMask;
	const touched = pool.touched;
	touched.fill(0, 0, nMod);

	const modPairId = pool.modPairId;
	const pairShedIdx = b.pairShedIdx;
	const pairSynIdx = b.pairSynIdx;
	const pairPops = b.pairPops;
	const pairSheds = b.pairSheds;
	const pairVectorCount = b.pairVectorCount;
	const pairPrecise = b.pairPrecise;
	for (let i = 0; i < n; i++) {
		const synIdx = pairSynIdx[i];
		const m = pairShedIdx[i] * nSyn + synIdx;
		modPairId[i] = m;

		if (touched[m]) continue;
		touched[m] = 1;
		const ms = b.syndromes[synIdx].getContactMod(pairSheds[i], b.site);
		modMultipliers[m] = ms.multiplier;
		const modOff = m * MASK_WORDS;
		for (let w = 0; w < MASK_WORDS; w++) {
			modApplyMask[modOff + w] = ms.apply_mask[w];
			modRemoveMask[modOff + w] = ms.remove_mask[w];
		}
	}
	stopPre();

	const stopCpu = profiler.start('applyShed/cpu-loop');
	const hitsBuf = pool.hitCounts;
	const tgtBuf = pool.targetMasks;
	for (let i = 0; i < n; i++) {
		const m = modPairId[i];
		const h = cpuApplyShed(
			pairPops[i].pop, pairVectorCount[i], modMultipliers[m],
			pairPrecise[i] === 1,
		);
		if (h <= 0 || isNaN(h)) { hitsBuf[i] = 0; continue; }
		const modOff = m * MASK_WORDS;
		const src = pairPops[i].primary_subsyndrome.trait_mask;
		const mOff = i * MASK_WORDS;
		let same = true;
		for (let w = 0; w < MASK_WORDS; w++) {
			const t = ((src[w] | modApplyMask[modOff + w]) & ~modRemoveMask[modOff + w]) >>> 0;
			tgtBuf[mOff + w] = t;
			if (t !== src[w]) same = false;
		}
		hitsBuf[i] = same ? 0 : h;
	}
	stopCpu();

	const stopPost = profiler.start('applyShed/post-pass');
	const materialize = b.world.materializeSubSyndromeByMask.bind(b.world);
	const addPopShift = b.delta.addPopShift.bind(b.delta);
	for (let i = 0; i < n; i++) {
		const h = hitsBuf[i];
		if (h <= 0) continue;
		const pop = pairPops[i];
		const targetId = materialize(tgtBuf, i).id;
		addPopShift(pop.id, pop.primary_subsyndrome.id, targetId, h);
	}
	stopPost();
}

/** Stage pool — pre-pass writes go here, then bulk-copy into WASM views.
 * Separate from `JsFallbackPool` to keep their lifecycles independent. */
interface StagePool {
	modCap: number;
	pairCap: number;
	touched: Uint8Array;
	popIds: Uint32Array;
	sourceIds: Uint32Array;
	vectorCounts: Float32Array;
	modPairId: Uint32Array;
	precise: Uint32Array;
	modMultipliers: Float32Array;
	modApplyMask: Uint32Array;
	modRemoveMask: Uint32Array;
}
let stagePool: StagePool | null = null;
function ensureStagePool(nMod: number, n: number): StagePool {
	if (stagePool === null) {
		stagePool = {
			modCap: 0, pairCap: 0,
			touched: new Uint8Array(0),
			popIds: new Uint32Array(0),
			sourceIds: new Uint32Array(0),
			vectorCounts: new Float32Array(0),
			modPairId: new Uint32Array(0),
			precise: new Uint32Array(0),
			modMultipliers: new Float32Array(0),
			modApplyMask: new Uint32Array(0),
			modRemoveMask: new Uint32Array(0),
		};
	}
	if (stagePool.modCap < nMod) {
		let cap = Math.max(stagePool.modCap, 1);
		while (cap < nMod) cap *= 2;
		stagePool.modCap = cap;
		stagePool.touched = new Uint8Array(cap);
		stagePool.modMultipliers = new Float32Array(cap);
		stagePool.modApplyMask = new Uint32Array(cap * MASK_WORDS);
		stagePool.modRemoveMask = new Uint32Array(cap * MASK_WORDS);
	}
	if (stagePool.pairCap < n) {
		let cap = Math.max(stagePool.pairCap, 1);
		while (cap < n) cap *= 2;
		stagePool.pairCap = cap;
		stagePool.popIds = new Uint32Array(cap);
		stagePool.sourceIds = new Uint32Array(cap);
		stagePool.vectorCounts = new Float32Array(cap);
		stagePool.modPairId = new Uint32Array(cap);
		stagePool.precise = new Uint32Array(cap);
	}
	return stagePool;
}
