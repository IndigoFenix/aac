import type { Point2D, MouseButtons, Draggable, ClickEvent } from '../types/interfaces';
import { ev_mousedown, ev_mouseup, ev_mousemove, touchToClick, LEFT_BUTTON } from './utils';

/**
 * Painting state for each mouse button
 */
interface PaintingState {
	left: unknown;
	right: unknown;
}

/**
 * Mouse/touch state tracker.
 * Handles button states, position tracking, and drag operations.
 */
export class Mouse {
	/** Button states */
	buttons: MouseButtons = { left: false, right: false };

	/** Current page position [x, y] */
	pos: Point2D = [0, 0];

	/** Current client position [x, y] */
	clientpos: Point2D = [0, 0];

	/** Currently dragged object */
	dragging: Draggable | null = null;

	/** Position where drag started relative to element */
	grabpos: Point2D = [0, 0];

	/** Painting state for tools */
	painting: PaintingState = { left: null, right: null };

	constructor() {
		this.setupEventListeners();
	}

	/**
	 * Set up global mouse/touch event listeners
	 */
	private setupEventListeners(): void {
		window.addEventListener(ev_mousedown, (e: Event) => {
			const click = touchToClick(e as TouchEvent | MouseEvent);
			if (click.button === LEFT_BUTTON) {
				this.buttons.left = true;
			} else {
				this.buttons.right = true;
			}
			this.updatePosition(click);
		}, false);

		window.addEventListener(ev_mouseup, (e: Event) => {
			const click = touchToClick(e as TouchEvent | MouseEvent);
			if (click.button === LEFT_BUTTON) {
				this.buttons.left = false;
			} else {
				this.buttons.right = false;
			}
			this.updatePosition(click);

			if (this.dragging?.dragRelease) {
				this.dragging.dragRelease(this);
			}
			this.dragging = null;
		}, false);

		window.addEventListener(ev_mousemove, (e: Event) => {
			const click = touchToClick(e as TouchEvent | MouseEvent);
			this.updatePosition(click);

			if (this.dragging?.dragMove) {
				this.dragging.dragMove(this);
			}
		}, false);
	}

	/**
	 * Update position from event
	 */
	updatePosition(e: ClickEvent): void {
		this.pos[0] = e.x;
		this.pos[1] = e.y;
		this.clientpos[0] = e.clientX;
		this.clientpos[1] = e.clientY;
	}

	/**
	 * Start grabbing an element, recording offset from element origin
	 */
	grab(el: HTMLElement): void {
		const rect = el.getBoundingClientRect();
		this.grabpos = [
			this.clientpos[0] - rect.left,
			this.clientpos[1] - rect.top
		];
	}

	/**
	 * Start dragging an object
	 */
	startDrag(obj: Draggable): void {
		this.dragging = obj;
	}

	/**
	 * Get current page position as copy
	 */
	getPosition(): Point2D {
		return [this.pos[0], this.pos[1]];
	}

	/**
	 * Get current client position as copy
	 */
	getClientPosition(): Point2D {
		return [this.clientpos[0], this.clientpos[1]];
	}

	/**
	 * Check if left button is pressed
	 */
	isLeftDown(): boolean {
		return this.buttons.left;
	}

	/**
	 * Check if right button is pressed
	 */
	isRightDown(): boolean {
		return this.buttons.right;
	}

	/**
	 * Check if any button is pressed
	 */
	isDown(): boolean {
		return this.buttons.left || this.buttons.right;
	}
}

export default Mouse;
