import { BWObj } from '../../core/BWObj';
import { arrayVal, intVal } from '../../core/parse';
import { removeFrom } from '../../core/utils';

/**
 * Initial population definition for a site.
 * Defines starting traits and relative size.
 */
export class PopInit extends BWObj {
	declare parent: BWObj & { startpops: PopInit[] };
	declare world: BWObj;

	// From attrs
	size: number = 0;
	apply: string[] = [];

	constructor(parent: BWObj, data?: Record<string, unknown>) {
		super(parent, data);
		this.world = (parent as unknown as { world: BWObj }).world;
		const d = this.data;
		this.size = intVal(d, 'size', 0);
		this.apply = arrayVal(d, 'apply');
	}

	getName(): string {
		if (this.apply.length > 0) {
			return this.apply.join(',') + ' * ' + this.size;
		}
		return 'None * ' + this.size;
	}

	destroy(): void {
		super.destroy();
		removeFrom(this.parent.startpops, this);
	}
}

export default PopInit;
