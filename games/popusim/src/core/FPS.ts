/**
 * Frame rate tracker for game loop timing.
 * Calculates and optionally displays FPS.
 */
export class FPS {
	private el: HTMLElement | null;
	private lastTick: number = 0;
	private lastFpsTick: number = 0;
	private frames: number = 0;

	/** Current frames per second */
	fps: number = 0;

	/** Time slice of last frame in milliseconds */
	slice: number = 0;

	constructor(elSelector?: string) {
		this.el = elSelector ? document.getElementById(elSelector) : null;
	}

	/**
	 * Get current timestamp in milliseconds
	 */
	static getTick(): number {
		return Date.now();
	}

	/**
	 * Start timing from current moment
	 */
	start(): void {
		this.lastTick = this.lastFpsTick = FPS.getTick();
	}

	/**
	 * Call at start of each frame.
	 * @returns Time since last frame in milliseconds
	 */
	enterFrame(): number {
		this.frames += 1;

		const currentTick = FPS.getTick();
		const timeSlice = currentTick - this.lastTick;
		this.lastTick = currentTick;

		// Update FPS calculation every 20 frames
		if (this.frames % 20 === 0) {
			this.fps = ~~(this.frames / ((currentTick - this.lastFpsTick) / 1000));
			this.frames = 0;
			this.lastFpsTick = currentTick;
			this.slice = timeSlice;
			this.render();
		}

		return timeSlice;
	}

	/**
	 * Render FPS to element (if configured)
	 */
	render(): void {
		if (this.el) {
			this.el.innerHTML = String(this.fps);
		}
	}
}

export default FPS;
