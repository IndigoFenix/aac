/**
 * Tracker - Links history tracking to trackable objects (Trait, Resource, Metric)
 * TrackerCalc - Wraps a tracker with calculation parameters for expressions
 */

import { HIST_TYPE, INCDEC } from '../../types/constants';
import type { IncDecMode } from '../../types/constants';

// Forward references
interface WorldLike {
	day_string: string;
}

interface TraitLike {
	base_key: string;
	guigroup: string | null;
	inactive?: boolean;
	hidden: boolean;
	color: ColorLike;
}

interface ResourceLike {
	base_key: string;
	guigroup: string | null;
	global: boolean;
	inactive?: boolean;
	hidden: boolean;
	color: ColorLike;
}

interface MetricLike {
	base_key: string;
	inactive?: boolean;
	hidden?: boolean;
	color: ColorLike;
}

interface ColorLike {
	getColor(): string;
}

interface HistoryLike {
	getDayVal(day: number, incdec?: IncDecMode): number;
	current: number;
	current_inc: number;
	current_dec: number;
}

interface SiteLike {
	key: string;
}

type TrackableObject = TraitLike | ResourceLike | MetricLike;

/**
 * Tracker - Links a trackable object to its history data
 */
export class Tracker {
	world: WorldLike;
	obj: TrackableObject;
	trait: TraitLike | null = null;
	resource: ResourceLike | null = null;
	metric: MetricLike | null = null;
	guigroup: string | null = null;
	type: number;
	global: boolean;
	graph_hidden: boolean;
	hidden: boolean;
	color: string;
	key: string;
	global_hist: HistoryLike | null = null;
	site_hists: Record<string, HistoryLike> = {};

	constructor(world: WorldLike, obj: TrackableObject) {
		this.world = world;
		this.obj = obj;

		// Determine type based on object structure
		if ('global' in obj && 'guigroup' in obj) {
			// Resource
			this.resource = obj as ResourceLike;
			this.guigroup = this.resource.guigroup || null;
			this.type = HIST_TYPE.RESOURCE;
			this.global = this.resource.global;
			this.graph_hidden = !!this.resource.inactive;
		} else if ('base_key' in obj && !('global' in obj) && 'guigroup' in obj) {
			// Trait
			this.trait = obj as TraitLike;
			this.guigroup = this.trait.guigroup || null;
			this.type = HIST_TYPE.TRAIT;
			this.global = false;
			this.graph_hidden = !!this.trait.inactive;
		} else {
			// Metric
			this.metric = obj as MetricLike;
			this.guigroup = null;
			this.type = HIST_TYPE.METRIC;
			this.global = true;
			this.graph_hidden = !!this.metric.inactive;
		}

		this.hidden = obj.hidden ?? false;
		this.color = obj.color.getColor();
		this.key = obj.base_key;
	}

	getHist(site: SiteLike | null): HistoryLike | null {
		if (!site) return this.global_hist;
		return this.site_hists[site.key] || null;
	}

	getName(): string {
		const obj = this.obj as { name?: string; key?: string };
		return obj.name && obj.name !== '' ? obj.name : '{' + (obj.key || this.key) + '}';
	}

	getColor(): string {
		return this.obj?.color?.getColor() || '#000';
	}
}

/**
 * TrackerCalc - Wraps a Tracker with calculation parameters for use in expressions
 */
export class TrackerCalc {
	tracker: Tracker;
	neg_offset: number;
	offset: number;
	incdec: IncDecMode;
	calc: string | null;

	constructor(tracker: Tracker, values: {
		neg_offset?: number;
		offset?: number;
		incdec?: IncDecMode;
		calc?: string | null;
	}) {
		this.tracker = tracker;
		this.neg_offset = values.neg_offset || 0;
		this.offset = values.offset || 0;
		this.incdec = values.incdec || INCDEC.CURRENT;
		this.calc = values.calc || null;
		if (this.calc === '') this.calc = null;
	}

	getName(): string {
		if (this.neg_offset === 0) return this.tracker.getName();

		let incdec_string = '';
		if (this.incdec === INCDEC.INC) incdec_string = 'increase ';
		else if (this.incdec === INCDEC.DEC) incdec_string = 'decrease ';

		const str = this.tracker.getName() + ' ' + incdec_string + this.neg_offset + ' ' + this.tracker.world.day_string;

		if (!this.calc) return str;
		if (this.calc === 'avg') return 'avg(' + str + ')';
		if (this.calc === 'sum') return 'sum(' + str + ')';
		return str;
	}
}

export default Tracker;
