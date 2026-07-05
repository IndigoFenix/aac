/**
 * Simulation worker entry.
 *
 * Bootstraps a WorkerSim and wires it to `self.postMessage` /
 * `self.addEventListener('message', ...)`. All protocol logic lives in
 * `./workerSim` so it can be unit-tested without spawning a real Worker.
 *
 * Import order: `./documentShim` is imported first by `./workerSim` (and
 * also imported by `./../wireup`'s indirect dependents) so System and
 * BColor have a `document` to read at module-init time.
 */

import { WorkerSim } from './workerSim';
import type { ClientMsg, WorkerMsg } from './protocol';

const post = (msg: WorkerMsg): void => {
	(self as unknown as { postMessage(msg: WorkerMsg): void }).postMessage(msg);
};

const sim = new WorkerSim(post);

self.addEventListener('message', (ev: MessageEvent) => {
	const msg = ev.data as ClientMsg;
	sim.handle(msg).catch((err: unknown) => {
		const e = err as Error;
		post({
			type: 'error',
			message: e?.message ?? String(err),
			stack: e?.stack,
		});
	});
});
