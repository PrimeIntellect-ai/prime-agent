import type { TUI } from "@earendil-works/pi-tui";

export class CountdownTimer {
	private intervalId: ReturnType<typeof setInterval> | undefined;
	private remainingSeconds: number;

	constructor(
		timeoutMs: number,
		private tui: TUI | undefined,
		private onTick: (seconds: number) => void,
		private onExpire: () => void,
	) {
		this.remainingSeconds = Math.ceil(timeoutMs / 1000);
		this.onTick(this.remainingSeconds);

		this.intervalId = setInterval(() => {
			this.remainingSeconds--;
			this.onTick(this.remainingSeconds);
			this.tui?.requestRender();

			if (this.remainingSeconds <= 0) {
				this.dispose();
				this.onExpire();
			}
		}, 1000);
	}

	dispose(): void {
		if (this.intervalId) {
			clearInterval(this.intervalId);
			this.intervalId = undefined;
		}
	}
}
