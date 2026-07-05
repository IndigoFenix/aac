import type { SoundLike } from '../types/interfaces';

/**
 * Sound event for playing audio.
 * This is a placeholder - the full implementation may be in another file.
 */
export class BSoundEvt implements SoundLike {
	src: string;
	private audio: HTMLAudioElement | null = null;
	private paused: boolean = false;

	constructor(data: { src: string }) {
		this.src = data.src || '';
		if (this.src) {
			this.audio = new Audio(this.src);
		}
	}

	play(): void {
		if (this.audio && !this.paused) {
			this.audio.play().catch(() => {
				// Ignore autoplay errors
			});
		}
	}

	stop(): void {
		if (this.audio) {
			this.audio.pause();
			this.audio.currentTime = 0;
		}
	}

	pause(): void {
		this.paused = true;
		if (this.audio) {
			this.audio.pause();
		}
	}

	unpause(): void {
		this.paused = false;
	}

	update(slice: number): void {
		// Override in full implementation
	}

	destroy(): void {
		this.stop();
		this.audio = null;
	}
}

export default BSoundEvt;
