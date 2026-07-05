import type { Point2D, RectBounds } from '../types/interfaces';

/**
 * A rectangle with position, dimensions, and utility methods.
 * Includes a convert method for expanding/inverting from origin point.
 * Mainly used for click-and-drag operations.
 */
export class Rect implements RectBounds {
	x: number;
	y: number;
	width: number;
	height: number;
	left: number;
	right: number;
	top: number;
	bottom: number;
	pos: unknown;

	constructor(
		x: number | string = 0,
		y: number | string = 0,
		w: number | string = 0,
		h: number | string = 0,
		pos?: unknown
	) {
		this.x = parseFloat(x as string) || 0;
		this.y = parseFloat(y as string) || 0;
		this.width = parseFloat(w as string) || 0;
		this.height = parseFloat(h as string) || 0;
		this.left = this.x;
		this.right = this.x + this.width;
		this.top = this.y;
		this.bottom = this.y + this.height;
		this.pos = pos;
	}

	/**
	 * Create a new rectangle expanded to the given endpoint.
	 * Handles negative dimensions by flipping the origin.
	 */
	convert(endX: number, endY: number): Rect {
		let cx = this.x;
		let cy = this.y;
		let cw: number;
		let ch: number;

		if (endX < this.x) {
			cx = endX;
			cw = this.x - endX;
		} else {
			cw = endX - this.x;
		}

		if (endY < this.y) {
			cy = endY;
			ch = this.y - endY;
		} else {
			ch = endY - this.y;
		}

		return new Rect(cx, cy, cw, ch, this.pos);
	}

	/**
	 * Get comma-separated string representation
	 */
	getString(): string {
		return `${this.x},${this.y},${this.width},${this.height}`;
	}

	/**
	 * Check if a point is inside this rectangle
	 */
	containsPoint(pos: Point2D): boolean {
		return (
			this.left <= pos[0] &&
			this.right >= pos[0] &&
			this.top <= pos[1] &&
			this.bottom >= pos[1]
		);
	}

	/**
	 * Check if this rectangle is entirely inside another
	 */
	isInside(rect: RectBounds): boolean {
		return (
			this.left >= rect.left &&
			this.right <= rect.right &&
			this.top >= rect.top &&
			this.bottom <= rect.bottom
		);
	}

	/**
	 * Create a copy of this rectangle
	 */
	copy(): Rect {
		return new Rect(this.x, this.y, this.width, this.height, this.pos);
	}

	/**
	 * Create rectangle from array [x, y, width, height]
	 */
	static fromArray(arr: number[], pos?: unknown): Rect {
		return new Rect(
			arr[0] ?? 0,
			arr[1] ?? 0,
			arr[2] ?? 0,
			arr[3] ?? 0,
			pos
		);
	}

	/**
	 * Create rectangle from comma-separated string
	 */
	static fromString(str: string, pos?: unknown): Rect {
		const parts = str.split(',').map(s => parseFloat(s) || 0);
		return Rect.fromArray(parts, pos);
	}
}

export default Rect;
