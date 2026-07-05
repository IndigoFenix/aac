import { BWObj } from '../../core/BWObj';
import { strVal } from '../../core/parse';
import { removeFrom } from '../../core/utils';

/**
 * A named phase for ordering game events.
 * Phases determine when transmissions, progressions, and impacts occur.
 */
export class Phase extends BWObj {
	declare parent: BWObj & { phases: Phase[] };

	constructor(world: BWObj, data?: Record<string, unknown>) {
		super(world, data);
		this.key = strVal(this.data, 'key', 'group');
	}

	destroy(): void {
		super.destroy();
		removeFrom(this.parent.phases, this);
	}
}

export default Phase;
