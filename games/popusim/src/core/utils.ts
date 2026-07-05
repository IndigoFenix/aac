import { FULL_CIRCLE, VARARRAY, KEY_CODES, KEY_STATUS } from '../types/constants';
import type {
	Point2D,
	StatsResult,
	EventListenerTuple,
	HasEventListeners,
	ClickEvent,
	RectBounds,
	JSONData,
	RGBAArray,
} from '../types/interfaces';

// ============================================================================
// Browser Detection
// ============================================================================

const ua = window.navigator.userAgent;
const msie = ua.indexOf("MSIE ");
const isMSIE = msie > 0;

/** Left mouse button code (varies by browser) */
export const LEFT_BUTTON = isMSIE ? 1 : 0;
/** Right mouse button code */
export const RIGHT_BUTTON = 2;

// ============================================================================
// Touch Device Detection
// ============================================================================

export let isTouchDevice: boolean;
export let ev_mousedown: 'mousedown' | 'touchstart';
export let ev_mouseup: 'mouseup' | 'touchend';
export let ev_mousemove: 'mousemove' | 'touchmove';

export function setAsMouse(): void {
	ev_mousedown = 'mousedown';
	ev_mouseup = 'mouseup';
	ev_mousemove = 'mousemove';
	isTouchDevice = false;
}

export function setAsTouch(): void {
	ev_mousedown = 'touchstart';
	ev_mouseup = 'touchend';
	ev_mousemove = 'touchmove';
	isTouchDevice = true;
}

export function checkIfTouch(): boolean {
	isTouchDevice = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
	if (isTouchDevice) setAsTouch();
	else setAsMouse();
	return isTouchDevice;
}

// Initialize touch detection
export const IS_TOUCHDEVICE = checkIfTouch();
export const IS_NARROW = (): boolean => window.innerWidth <= 500;

// ============================================================================
// Math Utilities
// ============================================================================

/** Reusable point for vector calculations */
const vectorPoint: Point2D = [0, 0];

/**
 * Calculate the difference between two angles in radians
 */
export function radDif(a1: number, a2: number): number {
	if (a1 < 0) a1 += 2 * Math.PI;
	else if (a1 >= 2 * Math.PI) a1 -= 2 * Math.PI;
	if (a2 < 0) a2 += 2 * Math.PI;
	else if (a2 >= 2 * Math.PI) a2 -= 2 * Math.PI;

	let dif = a2 - a1;
	if (dif > Math.PI) {
		dif = -((2 * Math.PI) - dif);
	} else if (dif < -Math.PI) {
		dif = (2 * Math.PI) + dif;
	}
	return -dif;
}

/**
 * Calculate angle between two points
 */
export function pointAngle(p1: Point2D, p2: Point2D): number {
	if (pointsEqual(p1, p2)) return 0;
	return Math.atan2(p2[1] - p1[1], p2[0] - p1[0]);
}

/**
 * Calculate distance between two 2D points
 */
export function pointDistance(p1: Point2D, p2: Point2D): number {
	if (pointsEqual(p1, p2)) return 0;
	return Math.sqrt(Math.pow(p2[0] - p1[0], 2) + Math.pow(p2[1] - p1[1], 2));
}

/**
 * Calculate distance between two 3D points
 */
export function pointDistance3D(p1: Point2D, z1: number, p2: Point2D, z2: number): number {
	return Math.sqrt(
		Math.pow(p2[0] - p1[0], 2) +
		Math.pow(p2[1] - p1[1], 2) +
		Math.pow(z2 - z1, 2)
	);
}

/**
 * Convert degrees to radians
 */
export function degToRad(deg: number): number {
	return deg * (Math.PI / 180);
}

/**
 * Convert radians to degrees
 */
export function radToDeg(rad: number): number {
	return rad * (180 / Math.PI);
}

/**
 * Calculate velocity vector from speed and angle
 * Note: Returns a shared array - do not store reference
 */
export function vector(speed: number, angle: number): Point2D {
	vectorPoint[0] = speed * Math.cos(angle);
	vectorPoint[1] = speed * Math.sin(angle);
	return vectorPoint;
}

/**
 * Rotate point by angle in radians
 */
export function rotatePointRad(pt: Point2D, angle: number): Point2D {
	const cosa = Math.cos(angle);
	const sina = Math.sin(angle);
	return [pt[0] * cosa - pt[1] * sina, pt[0] * sina + pt[1] * cosa];
}

/**
 * Rotate point by angle in degrees
 */
export function rotatePointDeg(pt: Point2D, angle: number): Point2D {
	const a = angle * (Math.PI / 180);
	const cosa = Math.cos(a);
	const sina = Math.sin(a);
	return [pt[0] * cosa - pt[1] * sina, pt[0] * sina + pt[1] * cosa];
}

/**
 * Check if two points are equal
 */
export function pointsEqual(p1: Point2D, p2: Point2D): boolean {
	return p1[0] === p2[0] && p1[1] === p2[1];
}

/**
 * Generate random number with normal distribution (Box-Muller transform)
 * Requires a Random instance for seeded randomness
 */
export function generateRandom(mean: number, stddev: number, getRandom: () => number): number {
	if (stddev === 0) return mean;

	let u = 0, v = 0;
	while (u === 0) u = getRandom();
	while (v === 0) v = getRandom();
	const value = Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);

	return (value * stddev) + mean;
}

// ============================================================================
// Type Checking & Conversion
// ============================================================================

/**
 * Check if value is numeric
 */
export function isNumeric(n: unknown): boolean {
	return !isNaN(parseFloat(n as string)) && isFinite(n as number);
}

/**
 * Check if two points are equal
 */
export function points_eq(p1: [number, number], p2: [number, number]): boolean {
	return p1[0] === p2[0] && p1[1] === p2[1];
}

/**
 * Check if value is defined (not null or undefined)
 */
export function isDefined<T>(v: T | null | undefined): v is T {
	return v !== undefined && v !== null;
}

/**
 * Get length of array or BArray-like object
 */
export function lengthOf(arr: unknown): number {
	if (!isDefined(arr)) return 0;
	if (Array.isArray(arr)) return arr.length;
	if (typeof arr === 'object' && arr !== null && 'arr' in arr) {
		const barray = arr as { arr: unknown[] };
		return barray.arr.length;
	}
	return 0;
}

/**
 * Convert value to array, optionally parsing as numbers
 */
export function makeArray(arr: unknown, numeric?: boolean): (string | number)[] {
	let result: (string | number)[];

	if (!isDefined(arr) || arr === '') {
		result = [];
	} else if (Array.isArray(arr)) {
		result = arr;
	} else if (typeof arr === 'string') {
		result = arr.split(',');
	} else {
		console.error('Invalid array', arr);
		return [];
	}

	if (numeric) {
		for (let i = 0; i < result.length; i++) {
			let v = parseFloat(result[i] as string);
			if (isNaN(v)) v = 0;
			result[i] = v;
		}
	}

	return result;
}

/**
 * Shallow clone an object
 */
export function clone<T extends object>(obj: T): T {
	const result = {} as T;
	for (const key in obj) {
		result[key] = obj[key];
	}
	return result;
}

/**
 * Parse JSON data, returning empty object if invalid
 */
export function getJSON(data: JSONData): Record<string, unknown> {
	if (!data) return {};
	if (typeof data === 'object') return data as Record<string, unknown>;
	try {
		return JSON.parse(data);
	} catch {
		return {};
	}
}

/**
 * Convert string value with default
 */
export function stringVal(str: unknown, def: string): string {
	if (!str) return def;
	return String(str);
}

/**
 * Convert to float with default
 */
export function floatVal(num: unknown, def: number): number {
	const n = parseFloat(num as string);
	if (isNaN(n)) return def;
	return n;
}

/**
 * Ensure value is an array
 */
export function arrayVal<T>(arr: T | T[] | null | undefined): T[] {
	if (!arr) return [];
	if (Array.isArray(arr)) return arr;
	return [arr];
}

/**
 * Parse RGBA from string or array
 * Handles: "transparent", "rgba(...)", "#hex", "r,g,b,a", arrays
 */
export function toRGBA(value: unknown): RGBAArray | undefined {
	if (!value) return undefined;

	if (typeof value === 'string') {
		if (value === 'transparent') {
			return [0, 0, 0, 0];
		}

		if (value.startsWith('rgba')) {
			const cleaned = value.replace(/[^0-9,.]/g, '');
			const arr = cleaned.split(',');
			return [
				parseFloat(arr[0]) || 0,
				parseFloat(arr[1]) || 0,
				parseFloat(arr[2]) || 0,
				arr[3] !== undefined ? parseFloat(arr[3]) : 1
			];
		}

		if (value.startsWith('#')) {
			if (/^#([A-Fa-f0-9]{3}){1,2}$/.test(value)) {
				let c = value.substring(1).split('');
				if (c.length === 3) {
					c = [c[0], c[0], c[1], c[1], c[2], c[2]];
				}
				const hex = parseInt('0x' + c.join(''), 16);
				return [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255, 1];
			}
			return undefined;
		}

		// Comma-separated values
		const parts = value.split(',');
		if (parts.length >= 3) {
			return [
				parseFloat(parts[0]) || 0,
				parseFloat(parts[1]) || 0,
				parseFloat(parts[2]) || 0,
				parts[3] !== undefined ? parseFloat(parts[3]) : 1
			];
		}
	} else if (Array.isArray(value) && value.length >= 3) {
		return [
			value[0] as number,
			value[1] as number,
			value[2] as number,
			(value[3] as number) ?? 1
		];
	}

	return undefined;
}

// ============================================================================
// Array Utilities
// ============================================================================

/**
 * Check if item is in array
 */
export function inArray<T>(arr: T[], obj: T): boolean {
	for (let i = 0, len = arr.length; i < len; i++) {
		if (arr[i] === obj) return true;
	}
	return false;
}

/**
 * Insert item into array only if not already present
 * Returns true if inserted
 */
export function insertUnique<T>(arr: T[], obj: T): boolean {
	if (!obj) return false;
	const unique = !inArray(arr, obj);
	if (unique) arr.push(obj);
	return unique;
}

/**
 * Merge multiple arrays, keeping only unique values
 */
export function mergeArraysUnique<T>(arrays: T[][]): T[] {
	const result = Array.from(arrays[0]);
	for (let i = 1; i < arrays.length; i++) {
		const arr = arrays[i];
		for (let j = 0; j < arr.length; j++) {
			insertUnique(result, arr[j]);
		}
	}
	return result;
}

/**
 * Remove item from array
 * Returns the removed item or null
 */
export function removeFrom<T>(arr: T[], obj: T): T | null {
	for (let i = arr.length - 1; i >= 0; i--) {
		if (arr[i] === obj) {
			arr.splice(i, 1);
			return obj;
		}
	}
	return null;
}

/**
 * Remove first item matching predicate
 * Returns the removed item or null
 */
export function removeFromWhere<T>(arr: T[], predicate: (item: T) => boolean): T | null {
	for (let i = arr.length - 1; i >= 0; i--) {
		const obj = arr[i];
		if (predicate(obj)) {
			arr.splice(i, 1);
			return obj;
		}
	}
	return null;
}

/**
 * Check if two arrays have any overlapping elements
 */
export function arraysOverlap<T>(a: T[], b: T[]): boolean {
	for (let i = a.length - 1; i >= 0; i--) {
		if (b.indexOf(a[i]) !== -1) return true;
	}
	return false;
}

/**
 * Sort numbers ascending
 */
export function sortNumber(a: number, b: number): number {
	return a - b;
}

/**
 * Insert key-value pair if key doesn't exist
 */
export function insertKVIfNew<T>(
	key: string,
	val: T,
	arr: T[],
	kv: Record<string, T>
): boolean {
	if (kv[key] === undefined) {
		kv[key] = val;
		arr.push(val);
		return true;
	}
	return false;
}

// ============================================================================
// Statistics
// ============================================================================

/**
 * Calculate basic statistics for an array of numbers
 */
export function getValues(points: number[]): StatsResult {
	if (points.length === 0) throw new Error('Less than 1 data point');

	let total = 0;
	let min = points[0];
	let max = points[0];

	for (let i = 0; i < points.length; i++) {
		total += points[i];
		if (points[i] < min) min = points[i];
		if (points[i] > max) max = points[i];
	}

	const mean = total / points.length;
	let sum = 0;

	for (let i = 0; i < points.length; i++) {
		const variance = points[i] - mean;
		sum += Math.pow(variance, 2);
	}

	const std = Math.sqrt(sum / points.length);

	return { mean, min, max, std };
}

// ============================================================================
// Time Utilities
// ============================================================================

/**
 * Get current Unix timestamp in seconds
 */
export function unixTime(): number {
	return Math.floor(Date.now() / 1000);
}

/**
 * Convert Unix timestamp to readable string
 */
export function timeConverter(unixTimestamp: number): string {
	const a = new Date(unixTimestamp * 1000);
	const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
	const year = a.getFullYear();
	const month = months[a.getMonth()];
	const date = a.getDate();
	const hour = a.getHours();
	const min = a.getMinutes();
	const sec = a.getSeconds();
	return `${date} ${month} ${year} ${hour}:${min}:${sec}`;
}

/**
 * Wait for specified milliseconds
 */
export function wait(ms: number): Promise<boolean> {
	return new Promise(resolve => {
		window.setTimeout(() => resolve(true), ms);
	});
}

// ============================================================================
// DOM Utilities
// ============================================================================

/**
 * Create and append an element
 * Overloads ensure proper return type based on element type
 */
export function appendElement(
	type: 'svg' | 'line',
	className?: string,
	to?: Element,
	inner?: string
): SVGElement;
export function appendElement(
	type: string,
	className?: string,
	to?: Element,
	inner?: string
): HTMLElement;
export function appendElement(
	type: string,
	className?: string,
	to?: Element,
	inner?: string
): HTMLElement | SVGElement {
	let el: HTMLElement | SVGElement;

	if (type === 'svg' || type === 'line') {
		el = document.createElementNS("http://www.w3.org/2000/svg", type);
		if (className !== undefined) el.setAttribute("class", className);
	} else {
		el = document.createElement(type);
		if (className !== undefined) (el as HTMLElement).className = className;
	}

	if (to) to.appendChild(el);
	if (inner !== undefined) el.innerHTML = inner;
	return el;
}

/**
 * Create and prepend an element
 */
export function prependElement(
	type: string,
	className: string,
	to: Element,
	inner?: string
): HTMLElement {
	const el = document.createElement(type);
	el.className = className;
	to.insertBefore(el, to.firstChild);
	if (inner !== undefined) el.innerHTML = inner;
	return el;
}

/**
 * Create and insert an element before another
 */
export function appendElementBefore(
	type: string,
	className: string,
	to: Element,
	before: Element,
	inner?: string
): HTMLElement {
	const el = document.createElement(type);
	el.className = className;
	to.insertBefore(el, before);
	if (inner !== undefined) el.innerHTML = inner;
	return el;
}

/**
 * Remove an element from its parent
 */
export function removeElement(element: Element | null): void {
	if (element?.parentNode) {
		element.parentNode.removeChild(element);
	}
}

/**
 * Check if element has class
 */
export function hasClass(el: Element, className: string): boolean {
	if (el.classList) {
		return el.classList.contains(className);
	}
	return !!(el.className as string).match(new RegExp('(\\s|^)' + className + '(\\s|$)'));
}

/**
 * Add class to element
 */
export function addClass(el: Element, className: string): void {
	if (el.classList) {
		el.classList.add(className);
	} else if (!hasClass(el, className)) {
		(el as HTMLElement).className += " " + className;
	}
}

/**
 * Remove class from element
 */
export function removeClass(el: Element, className: string): void {
	if (el.classList) {
		el.classList.remove(className);
	} else if (hasClass(el, className)) {
		const reg = new RegExp('(\\s|^)' + className + '(\\s|$)');
		(el as HTMLElement).className = (el.className as string).replace(reg, ' ');
	}
}

/**
 * Toggle class on element
 */
export function toggleClass(el: Element, className: string): void {
	if (hasClass(el, className)) {
		removeClass(el, className);
	} else {
		addClass(el, className);
	}
}

/**
 * Set CSS custom property on root
 */
export function setRootStyle(variable: string, value: string): void {
	const root = document.querySelector(':root') as HTMLElement;
	if (root) {
		root.style.setProperty(variable, value);
	}
}

/**
 * Parse pixel value to number
 */
export function styleToNumber(style: string): number {
	return parseFloat(style.replace('px', ''));
}

// ============================================================================
// Event Listener Management
// ============================================================================

/**
 * Bind event listener and track for cleanup
 */
export function bindListener(
	obj: HasEventListeners,
	input: EventTarget,
	type: string,
	func: EventListener
): EventListenerTuple | undefined {
	if (!('addEventListener' in input)) return undefined;

	if (!obj.ev_listeners) {
		obj.ev_listeners = [];
	}

	input.addEventListener(type, func);
	const listener: EventListenerTuple = [input, type, func];
	obj.ev_listeners.push(listener);
	return listener;
}

/**
 * Remove a specific tracked listener
 */
export function removeListener(obj: HasEventListeners, listener: EventListenerTuple): void {
	if (!obj.ev_listeners) return;

	for (let i = 0; i < obj.ev_listeners.length; i++) {
		const e = obj.ev_listeners[i];
		if (e === listener) {
			e[0].removeEventListener(e[1], e[2]);
			obj.ev_listeners.splice(i, 1);
			break;
		}
	}
}

/**
 * Remove all tracked listeners from object
 */
export function removeListeners(obj: HasEventListeners): void {
	if (!obj.ev_listeners) return;

	for (let i = 0; i < obj.ev_listeners.length; i++) {
		const e = obj.ev_listeners[i];
		e[0].removeEventListener(e[1], e[2]);
	}
	obj.ev_listeners = [];
}

// ============================================================================
// Canvas/Drawing Utilities
// ============================================================================

/**
 * Draw a circle on canvas context
 */
export function drawCircle(
	context: CanvasRenderingContext2D,
	center: Point2D,
	radius: number
): void {
	if (radius > 0) {
		context.arc(center[0], center[1], radius, 0, 2 * Math.PI);
	}
}

/**
 * Check if point is inside bounding box
 */
export function pointInsideBoundingBox(point: Point2D, rect: RectBounds): boolean {
	return (
		rect.left < point[0] &&
		rect.right > point[0] &&
		rect.top < point[1] &&
		rect.bottom > point[1]
	);
}

// ============================================================================
// Touch Utilities
// ============================================================================

/**
 * Convert touch event to click-like event
 */
export function touchToClick(e: TouchEvent | MouseEvent | ClickEvent): ClickEvent {
	if (!('changedTouches' in e) || !e.changedTouches || e.changedTouches.length < 1) {
		return e as ClickEvent;
	}

	const touch = e.changedTouches[0];
	return {
		x: touch.pageX,
		y: touch.pageY,
		clientX: touch.clientX,
		clientY: touch.clientY,
		button: LEFT_BUTTON,
	};
}

// ============================================================================
// Fullscreen Utilities
// ============================================================================

/**
 * Toggle fullscreen mode
 */
export function toggleFullScreen(): void {
	const doc = window.document;
	const docEl = doc.documentElement as HTMLElement & {
		mozRequestFullScreen?: () => Promise<void>;
		webkitRequestFullScreen?: () => Promise<void>;
		msRequestFullscreen?: () => Promise<void>;
	};

	const requestFullScreen =
		docEl.requestFullscreen ||
		docEl.mozRequestFullScreen ||
		docEl.webkitRequestFullScreen ||
		docEl.msRequestFullscreen;

	const cancelFullScreen = (doc as Document & {
		mozCancelFullScreen?: () => Promise<void>;
		webkitExitFullscreen?: () => Promise<void>;
		msExitFullscreen?: () => Promise<void>;
	}).exitFullscreen ||
		(doc as Document & { mozCancelFullScreen?: () => Promise<void> }).mozCancelFullScreen ||
		(doc as Document & { webkitExitFullscreen?: () => Promise<void> }).webkitExitFullscreen ||
		(doc as Document & { msExitFullscreen?: () => Promise<void> }).msExitFullscreen;

	const fullscreenElement = (doc as Document & {
		mozFullScreenElement?: Element;
		webkitFullscreenElement?: Element;
		msFullscreenElement?: Element;
	}).fullscreenElement ||
		(doc as Document & { mozFullScreenElement?: Element }).mozFullScreenElement ||
		(doc as Document & { webkitFullscreenElement?: Element }).webkitFullscreenElement ||
		(doc as Document & { msFullscreenElement?: Element }).msFullscreenElement;

	if (!fullscreenElement) {
		requestFullScreen?.call(docEl);
	} else {
		cancelFullScreen?.call(doc);
	}
}

// ============================================================================
// File Loading
// ============================================================================

/**
 * Load JSON file from URL
 */
export async function getFileContents(url: string): Promise<Record<string, unknown>> {
	return new Promise((resolve, reject) => {
		const request = new XMLHttpRequest();
		request.open('GET', url, true);
		request.send(null);

		request.onreadystatechange = function () {
			if (request.readyState === 4 && request.status === 200) {
				const type = request.getResponseHeader('Content-Type');
				if (type && type.indexOf("json") !== -1) {
					try {
						const obj = JSON.parse(request.responseText);
						resolve(obj);
					} catch (e) {
						console.error(e);
						reject(e);
					}
				} else {
					reject(new Error('Invalid content type'));
				}
			} else if (request.status === 404) {
				reject(new Error('Not found'));
			}
		};
	});
}

// ============================================================================
// Variable Type Detection
// ============================================================================

/**
 * Get variable array type from variable name prefix
 */
export function getVarArray(str: string | null | undefined): string {
	const f = str?.charAt(0) ?? '';
	switch (f) {
		case '_': return VARARRAY.vars;
		case '#': return VARARRAY.privatevars;
		case '$': return VARARRAY.inventoryvars;
		default: return VARARRAY.customvars;
	}
}

// ============================================================================
// String Utilities
// ============================================================================

/**
 * Escape special regex characters
 */
export function escapeRegExp(str: string): string {
	return str.replace(/([.*+?^=!:${}()|\[\]\/\\])/g, "\\$1");
}

/**
 * Replace all occurrences of a substring
 */
export function replaceAll(str: string, find: string, replace: string): string {
	return str.replace(new RegExp(escapeRegExp(find), 'g'), replace);
}

// ============================================================================
// Bezier Curve Utilities
// ============================================================================

/**
 * Calculate epsilon for bezier solving based on duration
 */
export function solveEpsilon(duration: number): number {
	return 1.0 / (200.0 * duration);
}

/**
 * Create a cubic bezier curve function
 * First and last control points are implicitly (0,0) and (1,1)
 */
export function unitBezier(
	p1x: number,
	p1y: number,
	p2x: number,
	p2y: number
): (x: number, duration: number) => number {
	const cx = 3.0 * p1x;
	const bx = 3.0 * (p2x - p1x) - cx;
	const ax = 1.0 - cx - bx;
	const cy = 3.0 * p1y;
	const by = 3.0 * (p2y - p1y) - cy;
	const ay = 1.0 - cy - by;

	const sampleCurveX = (t: number): number => ((ax * t + bx) * t + cx) * t;
	const sampleCurveY = (t: number): number => ((ay * t + by) * t + cy) * t;
	const sampleCurveDerivativeX = (t: number): number => (3.0 * ax * t + 2.0 * bx) * t + cx;

	const solveCurveX = (x: number, epsilon: number): number => {
		let t2 = x;

		// Newton-Raphson iteration
		for (let i = 0; i < 8; i++) {
			const x2 = sampleCurveX(t2) - x;
			if (Math.abs(x2) < epsilon) return t2;

			const d2 = sampleCurveDerivativeX(t2);
			if (Math.abs(d2) < 1e-6) break;

			t2 = t2 - x2 / d2;
		}

		// Fall back to bisection
		let t0 = 0.0;
		let t1 = 1.0;
		t2 = x;

		if (t2 < t0) return t0;
		if (t2 > t1) return t1;

		while (t0 < t1) {
			const x2 = sampleCurveX(t2);
			if (Math.abs(x2 - x) < epsilon) return t2;

			if (x > x2) t0 = t2;
			else t1 = t2;

			t2 = (t1 - t0) * 0.5 + t0;
		}

		return t2;
	};

	const solve = (x: number, epsilon: number): number => {
		return sampleCurveY(solveCurveX(x, epsilon));
	};

	return (x: number, duration: number): number => {
		return solve(x, solveEpsilon(duration));
	};
}
