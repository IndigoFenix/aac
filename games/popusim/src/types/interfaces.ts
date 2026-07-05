/**
 * A 2D point as [x, y]
 */
export type Point2D = [number, number];

/**
 * A 3D point as [x, y, z]
 */
export type Point3D = [number, number, number];

/**
 * RGBA color as [r, g, b, a]
 */
export type RGBAArray = [number, number, number, number];

/**
 * Rectangle bounds
 */
export interface RectBounds {
	left: number;
	right: number;
	top: number;
	bottom: number;
}

/**
 * Basic statistics result
 */
export interface StatsResult {
	mean: number;
	min: number;
	max: number;
	std: number;
}

/**
 * Event listener tuple: [element, eventType, handler]
 */
export type EventListenerTuple = [EventTarget, string, EventListener];

/**
 * Object with managed event listeners
 */
export interface HasEventListeners {
	ev_listeners?: EventListenerTuple[];
}

/**
 * Cookie options
 */
export interface CookieOptions {
	name: string;
	value?: string;
	days?: number;
	path?: string;
}

/**
 * Mouse button states
 */
export interface MouseButtons {
	left: boolean;
	right: boolean;
}

/**
 * Touch/Click event minimal interface
 */
export interface ClickEvent {
	x: number;
	y: number;
	clientX: number;
	clientY: number;
	button: number;
}

/**
 * Object that can be dragged
 */
export interface Draggable {
	dragMove?(mouse: MouseState): void;
	dragRelease?(mouse: MouseState): void;
}

/**
 * Mouse state interface
 */
export interface MouseState {
	buttons: MouseButtons;
	pos: Point2D;
	clientpos: Point2D;
	dragging: Draggable | null;
	grabpos: Point2D;
}

/**
 * Object that can have sounds
 */
export interface HasSounds {
	sounds: SoundLike[];
}

/**
 * Minimal sound interface
 */
export interface SoundLike {
	update(slice: number): void;
	pause(): void;
	unpause(): void;
	destroy(): void;
}

/**
 * Canvas rendering context alias
 */
export type RenderContext = CanvasRenderingContext2D;

/**
 * JSON data that can be loaded
 */
export type JSONData = Record<string, unknown> | string | null | undefined;

/**
 * Generic constructor type
 */
export type Constructor<T = object> = new (...args: unknown[]) => T;

/**
 * Menu sound effect definition
 */
export interface MenuSFX {
	name: string;
	file: string;
	audio: HTMLAudioElement;
}

/**
 * Base sound effect definition
 */
export interface BaseSFX {
	name: string;
	file: string;
}
