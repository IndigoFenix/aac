/**
 * wireup — registers every factory the simulation needs.
 *
 * The codebase uses a dependency-injection pattern: classes that own
 * collections (e.g. World owns sites, traits, syndromes) take factory
 * functions via `setXDependencies({ createY: ... })` rather than importing
 * the concrete classes. This breaks circular imports and keeps the core
 * decoupled from UI/scenarios.
 *
 * Importing this module registers every factory once, side-effect style.
 * It must be imported BEFORE any World/System construction. Idempotent —
 * importing again is safe but does nothing extra.
 *
 * Note on type assertions: each `Like` interface in `controller/interfaces.ts`
 * is a structural snapshot of what the calling site uses. The concrete classes
 * implement the *behavioral* contract but TS's structural matching surfaces
 * minor declaration drifts (HistoryLike duplicated across modules, Trait's
 * req_count missing in some interfaces, etc.). Resolving every drift would
 * require a sweep through ~80 files; for wireup purposes we erase the
 * boundary with `as never`, which is faithful to the runtime behavior.
 */

import { setSystemDependencies } from './controller/System';
import { setWorldDependencies, World } from './controller/World';
import { setSiteDependencies, Site } from './game/world/Site';
import { setStockpileDependencies, Stockpile } from './game/resources/Stockpile';
import { setPlayerActionDependencies, PlayerAction } from './game/actions/PlayerAction';

import { Trait } from './game/traits/Trait';
import { Vector } from './game/transmission/Vector';
import { Resource } from './game/resources/Resource';
import { Syndrome } from './game/simulation/Syndrome';
import { Population } from './game/simulation/Population';
import { Shed } from './game/simulation/Shed';
import { SynTransmit } from './game/simulation/SynTransmit';
import { Tracker } from './game/tracking/Tracker';
import { History } from './game/tracking/History';
import { Expression, ExpressionValue } from './game/tracking/Expression';
import { CustomMetric } from './game/tracking/CustomMetric';
import { IndexedPhase } from './game/organization/IndexedPhase';
import { GUIGroup } from './game/organization/GUIGroup';
import { Filter } from './game/organization/Filter';
import { Cluster } from './game/simulation/Cluster';

let wired = false;

export function wireup(): void {
	if (wired) return;
	wired = true;

	setWorldDependencies({
		createVector: ((world: never, data: never) => new Vector(world, data)) as never,
		createTrait: ((world: never, data: never) => new Trait(world, data)) as never,
		createSite: ((world: never, data: never) => new Site(world, data)) as never,
		createResource: ((world: never, data: never) => new Resource(world, data)) as never,
		createPlayerAction: ((world: never, data: never) => new PlayerAction(world, data)) as never,
		createStockpile: ((resource: never, parent: never, value: never) => new Stockpile(resource, parent, value)) as never,
		createSyndrome: ((world: never, traits: never, key: never) => new Syndrome(world, traits, key)) as never,
		createTracker: ((world: never, obj: never) => new Tracker(world, obj)) as never,
		createHistory: ((parent: never, tracker: never) => new History(parent, tracker)) as never,
		createIndexedPhase: ((world: never, key: never, index: never) => new IndexedPhase(world, key, index)) as never,
		createGUIGroup: ((world: never, data: never) => new GUIGroup(world, data)) as never,
		createFilter: ((key: never, required: never, forbidden: never) => new Filter(key, required, forbidden)) as never,
		createCluster: ((trait: never, level: never) => new Cluster(trait, level)) as never,
		createExpression: ((world: never, values: never) => new Expression(world, values)) as never,
		createExpressionValue: ((world: never, type: never, subtype: never, value: never) => new ExpressionValue(world, type, subtype, value)) as never,
		createCustomMetric: ((world: never, data: never) => new CustomMetric(world, data)) as never,
	});

	setSiteDependencies({
		createStockpile: ((resource: never, parent: never, value: never) => new Stockpile(resource, parent, value)) as never,
		createPlayerAction: ((site: never, data: never) => new PlayerAction(site, data)) as never,
		createHistory: ((parent: never, tracker: never) => new History(parent, tracker)) as never,
		createPopulation: ((site: never, size: never, syndrome: never) => new Population(site, size, syndrome)) as never,
		createShed: ((origin: never, key: never, amount: never, vectors: never, vectorKeys: never, traits: never, traitKeys: never, cures: never, cureKeys: never, seek: never, precise: never, relevantClusters: never) =>
			new Shed(origin, key, amount, vectors, vectorKeys, traits, traitKeys, cures, cureKeys, seek, precise, relevantClusters)) as never,
	});

	setStockpileDependencies({
		createShed: ((stockpile: never, key: never, amount: never, vectors: never, vectorKeys: never, traits: never, traitKeys: never, cures: never, cureKeys: never, seek: never, precise: never, relevantClusters: never) =>
			new Shed(stockpile, key, amount, vectors, vectorKeys, traits, traitKeys, cures, cureKeys, seek, precise, relevantClusters)) as never,
	});

	setSystemDependencies({
		createWorld: ((system: never, data: never) => new World(system, data)) as never,
		// createPanelsGUI is UI-only; smoke tests don't need it.
	});

	setPlayerActionDependencies({
		createSynTransmit: ((creator: never, source: never) => new SynTransmit(creator, source)) as never,
	});
}

// Auto-wire on import for convenience.
wireup();
