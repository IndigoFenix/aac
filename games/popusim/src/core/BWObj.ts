import type {
	JSONData,
	HasEventListeners,
	SoundLike,
	RenderContext,
} from '../types/interfaces';
import { getJSON } from './utils';

/**
 * Base class for all game/world objects.
 *
 * Provides parent/child links, sound bookkeeping, the per-frame update hooks,
 * and the simulation lifecycle flags. JSON parsing lives in each subclass's
 * constructor — typically by calling helpers from `core/parse.ts` against
 * `this.data`. The legacy `getAttrs`/`AttrDef` machinery has been removed; see
 * SYSTEM_OUTLINE §13 for the rationale.
 */
export class BWObj implements HasEventListeners {
	// Parent/child relationships
	parent: BWObj | null;
	system: BWObj | null = null;
	world: BWObj | null = null;

	// Raw JSON the object was constructed from. Subclasses read fields out of
	// this in their constructors. Kept around for introspection and for the
	// few legacy callers that still consult it.
	data: Record<string, unknown>;

	// Stable identifier within its parent collection (e.g. "employed").
	key: string = '';
	// Free-form type tag used in a couple of legacy display paths.
	type: string = '';

	// State flags
	started: boolean = false;
	exists: boolean = true;
	hidden: boolean = false;
	paused?: boolean;

	// Internal tracking
	timer: number = 0;
	sounds: SoundLike[] = [];
	currentThread: unknown = null;

	// Variable storage (legacy event-handler scoping; preserved for the few
	// runtime paths that touch it).
	vars: Record<string, unknown> = {};
	customvars: Record<string, unknown> = {};
	varmods: Record<string, unknown> = {};
	varmods_external: unknown[] = [];
	inventory: unknown[] = [];

	// Misc
	credit_groups: unknown[] = [];
	references: unknown[] = [];
	nodes: unknown[] = [];
	ev_listeners?: [EventTarget, string, EventListener][];

	// Index in parent array (set by parseChildren in core/parse.ts)
	index?: number;
	parent_array?: BWObj[];

	constructor(parent: BWObj | null, data?: JSONData) {
		this.parent = parent;
		this.data = getJSON(data);

		if (this.parent) {
			this.system = this.parent.system;
			if (this.constructor.name === 'World') {
				this.world = this;
			} else {
				this.world = this.parent.world;
			}
		} else if (this.constructor.name === 'System') {
			this.system = this;
		}
	}

	setParent(p: BWObj): void {
		this.parent = p;
		this.vars._parent = p;
	}

	update_before(_slice: number): boolean | void {
		if (this.paused) return false;
	}

	update(slice: number): boolean | void {
		if (this.paused) return false;
		this.timer++;
		for (const sound of this.sounds) {
			sound.update(slice);
		}
	}

	update_after(_slice: number): boolean | void {
		if (this.paused) return false;
	}

	render(_context: RenderContext): void {}

	start(): void {
		this.started = true;
	}

	setPaused(set: boolean): void {
		if (this.paused && !set) {
			this.paused = false;
			this.unpauseAllSounds();
		} else if (!this.paused && set) {
			this.paused = true;
			this.pauseAllSounds();
		}
	}

	pauseAllSounds(): void {
		for (let i = this.sounds.length - 1; i >= 0; i--) {
			this.sounds[i].pause();
		}
	}

	unpauseAllSounds(): void {
		for (let i = this.sounds.length - 1; i >= 0; i--) {
			this.sounds[i].unpause();
		}
	}

	destroyAllSounds(): void {
		for (let i = this.sounds.length - 1; i >= 0; i--) {
			this.sounds[i].destroy();
		}
	}

	destroy(): void {
		this.destroyAllSounds();
		this.exists = false;
	}
}

export default BWObj;
