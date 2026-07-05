import { BWObj } from '../../core/BWObj';
import { strVal } from '../../core/parse';
import { removeFrom } from '../../core/utils';

/**
 * GUI grouping for organizing displayed items in the UI.
 * Used to group related stats, actions, etc. together.
 */
export class GUIGroup extends BWObj {
	declare parent: BWObj & { guigroups: GUIGroup[] };
	name: string = '';

	constructor(world: BWObj, data?: Record<string, unknown>) {
		super(world, data);
		const d = this.data;
		this.key = strVal(d, 'key', 'group');
		this.name = strVal(d, 'name', '');
	}

	/**
	 * Get display name (falls back to key if name is empty)
	 */
	getName(): string {
		return this.name !== "" ? this.name : this.key;
	}

	destroy(): void {
		super.destroy();
		removeFrom(this.parent.guigroups, this);
	}
}

export default GUIGroup;
