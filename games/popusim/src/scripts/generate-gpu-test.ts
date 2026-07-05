/**
 * Generates a "GPU Test" scenario for stress-testing the simulator with large
 * trait counts.
 *
 * Usage:
 *   npx tsx src/scripts/generate-gpu-test.ts <X> <Y>
 *     X = site population
 *     Y = number of identical transmitting traits
 *
 * Writes to example-scenarios/gpu-test.json.
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..', '..');
const OUT_PATH = path.join(ROOT, 'example-scenarios', 'gpu-test.json');

function parsePositiveInt(raw: string | undefined, name: string): number {
	const n = Number(raw);
	if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
		throw new Error(`Expected ${name} to be a non-negative integer, got: ${raw}`);
	}
	return n;
}

function main() {
	const [, , xArg, yArg] = process.argv;
	if (xArg === undefined || yArg === undefined) {
		console.error('Usage: tsx src/scripts/generate-gpu-test.ts <X> <Y>');
		process.exit(1);
	}
	const X = parsePositiveInt(xArg, 'X (population)');
	const Y = parsePositiveInt(yArg, 'Y (trait count)');

	const traits: unknown[] = [
		{
			key: 'alive',
			name: 'Population',
			color: '60,150,0,1',
			prob: 1,
		},
	];

	const siteTransmits: unknown[] = [];

	for (let i = 1; i <= Y; i++) {
		const key = `trait_${i}`;
		traits.push({
			key,
			name: `Trait ${i}`,
			transmit: [
				{
					apply: key,
					value: 0.1,
				},
			],
		});
		siteTransmits.push({
			apply: key,
			value: 10,
		});
	}

	const scenario = {
		name: 'GPU Test',
		start_date: '2025-01-01',
		phase: [],
		guigroup: [],
		resource: [],
		trait: traits,
		vector: [],
		action: [],
		site: [
			{
				key: 'site',
				name: 'Test Site',
				pop: X,
				startpop: [
					{
						size: X,
						apply: 'alive',
					},
				],
				transmit: siteTransmits,
			},
		],
		event: [],
	};

	fs.writeFileSync(OUT_PATH, JSON.stringify(scenario, null, '\t') + '\n', 'utf-8');
	console.log(`Wrote ${OUT_PATH} (population ${X}, ${Y} traits).`);
}

main();
