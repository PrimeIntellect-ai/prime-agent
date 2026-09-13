interface SessionInputSchedulerDependencies {
	canSchedule(): boolean;
	run(epoch: number): Promise<void>;
}

export class SessionInputScheduler {
	private _pump: Promise<void> = Promise.resolve();
	private _requested = false;
	private _epoch = 0;
	private _suspended = false;
	private _suspendedForUpdateRestart = false;
	private readonly _queuedWorkPauses = new Set<symbol>();
	private readonly _admissionPauses = new Set<symbol>();

	constructor(private readonly dependencies: SessionInputSchedulerDependencies) {}

	get pendingPump(): Promise<void> {
		return this._pump;
	}

	get requested(): boolean {
		return this._requested;
	}

	get epoch(): number {
		return this._epoch;
	}

	get suspended(): boolean {
		return this._suspended;
	}

	get suspendedForUpdateRestart(): boolean {
		return this._suspendedForUpdateRestart;
	}

	get queuedWorkPauseCount(): number {
		return this._queuedWorkPauses.size;
	}

	get admissionPaused(): boolean {
		return this._admissionPauses.size > 0;
	}

	schedule(): void {
		if (this._suspended || this._queuedWorkPauses.size > 0) return;
		if (this._requested || !this.dependencies.canSchedule()) return;
		this._requested = true;
		const epoch = this._epoch;
		const pump = async () => {
			this._requested = false;
			await this.dependencies.run(epoch);
		};
		this._pump = this._pump.then(pump, pump);
		this._pump.catch(() => {});
	}

	// The runner checks this epoch after asynchronous preparation, including pauses
	// that have already been released by the time preparation finishes.
	invalidatePreparation(): void {
		this._epoch++;
	}

	acquireAdmissionPause(onRelease: () => void): { release(): void } {
		const token = Symbol("session-input-admission-pause");
		this._admissionPauses.add(token);
		this._requested = false;
		this._epoch++;
		let released = false;
		return {
			release: () => {
				if (released) return;
				released = true;
				this._admissionPauses.delete(token);
				this._epoch++;
				onRelease();
			},
		};
	}

	acquireQueuedWorkPause(onRelease: () => void): { release(): void } {
		const token = Symbol("queued-work-pause");
		this._queuedWorkPauses.add(token);
		this._requested = false;
		this._epoch++;
		let released = false;
		return {
			release: () => {
				if (released) return;
				released = true;
				this._queuedWorkPauses.delete(token);
				onRelease();
			},
		};
	}

	suspend(reason: "abort" | "update-restart"): void {
		this._requested = false;
		this._epoch++;
		this._suspended = true;
		this._suspendedForUpdateRestart = reason === "update-restart";
	}

	resume(): boolean {
		if (!this._suspended) return false;
		this._suspended = false;
		this._suspendedForUpdateRestart = false;
		this._epoch++;
		return true;
	}

	async waitForIdle(): Promise<void> {
		while (true) {
			const pump = this._pump;
			await pump;
			if (pump === this._pump && !this._requested) return;
		}
	}
}
