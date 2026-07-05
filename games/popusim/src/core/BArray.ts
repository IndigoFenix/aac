/**
 * Array wrapper class that can store varmods and provides chainable methods.
 * Used throughout the codebase for managed arrays.
 */
export class BArray<T = unknown> {
	arr: T[];

	constructor(arr?: T[]) {
		this.arr = arr ?? [];
	}

	/**
	 * Add item to end of array
	 * @returns this for chaining
	 */
	push(item: T): this {
		this.arr.push(item);
		return this;
	}

	/**
	 * Clear all items from array
	 * @returns this for chaining
	 */
	clear(): this {
		this.arr.length = 0;
		return this;
	}

	/**
	 * Alias for clear()
	 * @returns this for chaining
	 */
	empty(): this {
		this.arr.length = 0;
		return this;
	}

	/**
	 * Get item at index
	 */
	get(index: number): T | undefined {
		return this.arr[index];
	}

	/**
	 * Remove and return last item
	 */
	pop(): T | undefined {
		return this.arr.pop();
	}

	/**
	 * Copy contents to another BArray
	 */
	copyTo(other: BArray<T>): void {
		other.empty();
		for (let i = 0, len = this.arr.length; i < len; i++) {
			other.push(this.arr[i]);
		}
	}

	/**
	 * Get array length
	 */
	length(): number {
		return this.arr.length;
	}

	/**
	 * Check if array contains item
	 */
	contains(item: T): boolean {
		return this.arr.indexOf(item) !== -1;
	}

	/**
	 * Add item only if not already present
	 * @returns true if item was added
	 */
	addUnique(item: T): boolean {
		if (!this.contains(item)) {
			this.arr.push(item);
			return true;
		}
		return false;
	}

	/**
	 * Remove first occurrence of item
	 * @returns true if item was removed
	 */
	remove(item: T): boolean {
		const index = this.arr.indexOf(item);
		if (index !== -1) {
			this.arr.splice(index, 1);
			return true;
		}
		return false;
	}

	/**
	 * Execute function for each item
	 */
	forEach(fn: (item: T, index: number) => void): void {
		for (let i = 0; i < this.arr.length; i++) {
			fn(this.arr[i], i);
		}
	}

	/**
	 * Get underlying array
	 */
	toArray(): T[] {
		return this.arr;
	}

	/**
	 * Called when array contents change (override in subclass)
	 */
	changed(): void {
		// Override in subclass if needed
	}
}

export default BArray;
