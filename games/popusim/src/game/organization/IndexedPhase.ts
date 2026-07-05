import type { BWObj } from '../../core/BWObj';

// Forward references for types (actual classes imported where needed)
interface Transmit { }
interface Progress { }
interface Syndrome { }
interface Impact { }
interface GameEvent { }

/**
 * Runtime phase data with indexed collections.
 * Collects all transmissions, progressions, syndromes, impacts, and events 
 * that should execute during this phase.
 */
export class IndexedPhase {
	world: BWObj;
	key: string;
	index: number;

	transmit: Transmit[] = [];
	progress: Progress[] = [];
	syndromes: Syndrome[] = [];
	impacts: Impact[] = [];
	events: GameEvent[] = [];

	constructor(world: BWObj, key: string, index: number) {
		this.world = world;
		this.key = key;
		this.index = index;
	}

	/**
	 * Clear all collections for reuse
	 */
	clear(): void {
		this.transmit = [];
		this.progress = [];
		this.syndromes = [];
		this.impacts = [];
		this.events = [];
	}
}

export default IndexedPhase;
