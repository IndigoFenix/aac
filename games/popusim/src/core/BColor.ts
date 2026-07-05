import type { RGBAArray } from '../types/interfaces';
import { BWObj } from './BWObj';

/**
 * RGBA Color with conversion utilities.
 */
export class BColor extends BWObj {
	tag: string = 'color';
	composite: string = 'source-atop';

	// Color components
	r: number = 0;
	g: number = 0;
	b: number = 0;
	a: number = 1;
	inh: boolean = false;  // Inherit flag

	constructor(parent: BWObj | null, data?: Record<string, unknown>) {
		super(parent, data);
		const d = this.data;
		this.r = numField(d.r, 0);
		this.g = numField(d.g, 0);
		this.b = numField(d.b, 0);
		this.a = numField(d.a, 1);
		this.inh = boolField(d.inh);
	}

	/**
	 * Get CSS rgba() string, or empty string if inherited
	 */
	getColor(): string {
		if (this.inh) return "";
		return `rgba(${Math.floor(this.r)},${Math.floor(this.g)},${Math.floor(this.b)},${this.a})`;
	}

	/**
	 * Get comma-separated name, or empty string if inherited
	 */
	getName(): string {
		if (this.inh) return "";
		return `${this.r},${this.g},${this.b},${this.a}`;
	}

	/**
	 * Convert a single component to 2-digit hex
	 */
	private componentToHex(c: number): string {
		const hex = c.toString(16);
		return hex.length === 1 ? "0" + hex : hex;
	}

	/**
	 * Get hex color string (#RRGGBB)
	 */
	getHex(): string {
		let r = Math.floor(this.r);
		let g = Math.floor(this.g);
		let b = Math.floor(this.b);
		if (r > 255) r = 255;
		if (g > 255) g = 255;
		if (b > 255) b = 255;
		return "#" + this.componentToHex(r) + this.componentToHex(g) + this.componentToHex(b);
	}

	/**
	 * Copy this color's values to another BColor
	 */
	copyTo(color: BColor): void {
		color.r = this.r;
		color.g = this.g;
		color.b = this.b;
		color.a = this.a;
		color.composite = this.composite;
	}

	/**
	 * Copy values from another BColor or array
	 */
	copyFrom(val: BColor | RGBAArray | string | null | undefined): void {
		if (!val) return;

		if (val instanceof BColor) {
			val.copyTo(this);
		} else {
			// Handle array or string
			let arr: number[];
			if (Array.isArray(val)) {
				arr = val.map(v => typeof v === 'number' ? v : parseFloat(v) || 0);
			} else if (typeof val === 'string') {
				arr = val.split(',').map(v => parseFloat(v) || 0);
			} else {
				return;
			}

			if (arr.length >= 3) {
				this.r = arr[0];
				this.g = arr[1];
				this.b = arr[2];
				if (arr[3] !== undefined) this.a = arr[3];
			}
		}
	}

	/**
	 * Create a copy of this color
	 */
	clone(): BColor {
		const color = new BColor(this.parent);
		this.copyTo(color);
		color.inh = this.inh;
		return color;
	}

	/**
	 * Set from RGBA values
	 */
	setRGBA(r: number, g: number, b: number, a: number = 1): this {
		this.r = r;
		this.g = g;
		this.b = b;
		this.a = a;
		this.inh = false;
		return this;
	}

	/**
	 * Get as array [r, g, b, a]
	 */
	toArray(): RGBAArray {
		return [this.r, this.g, this.b, this.a];
	}

	destroy(): void {
		super.destroy();
	}
}

function numField(v: unknown, def: number): number {
	if (v === undefined || v === null || v === '') return def;
	const n = Number(v);
	return isNaN(n) ? def : n;
}

function boolField(v: unknown): boolean {
	if (v === undefined || v === null) return false;
	if (v === '' || v === 0 || v === '0' || v === false) return false;
	return true;
}

export default BColor;
