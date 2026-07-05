/**
 * Vitest config for the PopuSim engine suites.
 *
 * Scope: engine-level tests only (simulation, clustering, routes). The
 * packaged source came without `example-scenarios/` and without the
 * Preact UI toolchain, so suites that import either are excluded below —
 * re-include them if/when those assets are restored.
 *
 * Run from repo root: `npm run test:popusim`
 */

import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		environment: 'node',
		// core/utils.ts reads window.navigator.userAgent at import; the
		// worker shim provides window/document stand-ins in node too.
		setupFiles: ['./src/sim/documentShim.ts'],
		include: [
			'src/__tests__/**/*.test.ts',
			'src/game/**/__tests__/**/*.test.ts',
			'src/sim/**/__tests__/**/*.test.ts',
		],
		exclude: [
			// Import ../../example-scenarios/*.json, which was not packaged.
			'**/covid.test.ts',
			'**/covidReset.test.ts',
			'**/covidScenarioPop.test.ts',
			'**/covidNews.test.ts',
			'**/clusterDetector.test.ts',
			'**/clusterVerifier.test.ts',
		],
		testTimeout: 60000,
	},
});
