import { floatVal, arrayVal } from '../../core/utils';
import type { BWObj } from '../../core/BWObj';

/**
 * Imply - helper class for trait implications
 * Used internally during trait processing
 */
export class Imply {
	world: BWObj;
	data: Record<string, unknown>;

	trait_keys: string[];
	cure_keys: string[];

	value: number;
	sd: number;
	imply: unknown[] = [];

	constructor(world: BWObj, data: Record<string, unknown>) {
		this.world = world;
		this.data = data;

		// Support multiple naming conventions from data
		this.trait_keys = arrayVal(
			(data.apply || data.traits || data.trait) as string | string[]
		) as string[];
		this.cure_keys = arrayVal(
			(data.remove || data.cures || data.cure) as string | string[]
		) as string[];

		this.value = floatVal(data.value, 1);
		this.sd = floatVal(data.sd, 0);
	}
}

export default Imply;
