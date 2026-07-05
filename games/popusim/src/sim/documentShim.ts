/**
 * Minimal browser-globals shim for Worker context.
 *
 * Workers don't have `window` or `document`. `src/core/utils.ts` reads
 * `window.navigator.userAgent` at module top to set browser-detection
 * constants. System and BColor call `document.getElementById` and
 * `document.createElement` at construction for UI placeholders. None of
 * those values are read in the simulation hot path, so a stand-in that
 * absorbs every write and returns itself for any method call is sufficient.
 *
 * This module has no imports, so importing it FIRST in `worker.ts` /
 * `workerSim.ts` runs its top-level side effect before any sibling
 * import's dependency graph evaluates.
 *
 * Once a proper headless-System path is built this whole file goes away.
 */

// Alias `window` to `self` in the Worker. `self` exists in Workers and has
// the navigator object, so `window.navigator.userAgent` works as expected.
if (typeof (globalThis as { window?: unknown }).window === 'undefined') {
	(globalThis as { window?: unknown }).window = globalThis;
}

if (typeof (globalThis as { document?: unknown }).document === 'undefined') {
	// Properties that callers read as strings — empty default so e.g.
	// `document.cookie.split(';')` doesn't crash in CookieManager.
	const STRING_PROPS = new Set([
		'innerHTML', 'textContent', 'className',
		'cookie', 'title', 'URL', 'baseURI', 'characterSet', 'contentType',
		'src', 'href', 'value', 'id',
	]);

	// DOMTokenList-shaped no-op for `classList` — callers do .add/.remove/
	// .contains/.toggle. Returning a plain array breaks .remove() because
	// Array.prototype.remove doesn't exist.
	const classListStub = {
		add: () => undefined,
		remove: () => undefined,
		contains: () => false,
		toggle: () => false,
		replace: () => false,
		length: 0,
	};

	const stand: Record<string | symbol, unknown> = {};
	const proxyHandler: ProxyHandler<Record<string | symbol, unknown>> = {
		get(target, prop) {
			if (prop in target) return target[prop];
			if (typeof prop === 'string' && STRING_PROPS.has(prop)) return '';
			if (prop === 'style') return new Proxy({}, proxyHandler);
			if (prop === 'children' || prop === 'childNodes') return [];
			if (prop === 'classList') return classListStub;
			if (prop === 'dataset') return {};
			// Default: a no-op function that returns the same proxy so chained
			// calls (.append(...).addClass(...)) don't blow up.
			return () => fakeElement;
		},
		set(target, prop, value) {
			target[prop] = value;
			return true;
		},
	};
	const fakeElement: Record<string | symbol, unknown> = new Proxy(stand, proxyHandler);

	// `document` is itself a proxy now, sharing the fallback. Specific
	// methods (getElementById, createElement, ...) come back via the
	// own-property store; anything else falls through the same handler so
	// new module-init reads of unfamiliar globals don't crash the worker.
	const docStore: Record<string | symbol, unknown> = {
		getElementById: () => fakeElement,
		createElement: () => fakeElement,
		querySelector: () => fakeElement,
		querySelectorAll: () => [],
		body: fakeElement,
		head: fakeElement,
		documentElement: fakeElement,
		addEventListener: () => undefined,
		removeEventListener: () => undefined,
	};
	(globalThis as { document?: unknown }).document = new Proxy(docStore, proxyHandler);
}
