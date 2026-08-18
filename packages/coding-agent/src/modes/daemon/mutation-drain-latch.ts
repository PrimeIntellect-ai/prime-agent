/** Counts in-flight mutating commands so update-restart preparation can wait for them to drain. */
export class MutationDrainLatch {
	private active = 0;
	private readonly waiters = new Set<() => void>();

	begin(): void {
		this.active++;
	}

	end(): void {
		this.active--;
		for (const resolve of this.waiters) resolve();
		this.waiters.clear();
	}

	async waitForDrain(remaining: number, signal: AbortSignal, abortMessage: string): Promise<void> {
		if (signal.aborted) throw new Error(abortMessage);
		while (this.active > remaining) {
			await new Promise<void>((resolve, reject) => {
				let settled = false;
				const settle = (error?: Error) => {
					if (settled) return;
					settled = true;
					this.waiters.delete(onDrained);
					signal.removeEventListener("abort", onAbort);
					if (error) reject(error);
					else resolve();
				};
				const onDrained = () => settle();
				const onAbort = () => settle(new Error(abortMessage));
				this.waiters.add(onDrained);
				signal.addEventListener("abort", onAbort, { once: true });
			});
			if (signal.aborted) throw new Error(abortMessage);
		}
	}
}
