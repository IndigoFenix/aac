/**
 * Reference to a gate (connection point between rooms/areas).
 * This is a placeholder - the full implementation may be in another file.
 */
export class BGateRef {
	private value: string;

	constructor(value: unknown) {
		if (typeof value === 'string') {
			this.value = value;
		} else if (value && typeof value === 'object' && 'getString' in value) {
			this.value = (value as BGateRef).getString();
		} else {
			this.value = '';
		}
	}

	getString(): string {
		return this.value;
	}

	isEmpty(): boolean {
		return !this.value;
	}
}

export default BGateRef;
