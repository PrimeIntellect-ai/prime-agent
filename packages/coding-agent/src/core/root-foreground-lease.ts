import { AsyncLocalStorage } from "node:async_hooks";

export type RootForegroundActor = "root-turn" | "root-cell" | "compaction";

interface ForegroundHolder {
	token: symbol;
	actDepth: number;
	releaseWaiters: Set<() => void>;
}

interface ForegroundWaiter {
	token: symbol;
	resolve: (handle: RootForegroundHandle) => void;
	reject: (error: Error) => void;
	signal?: AbortSignal;
	abort?: () => void;
}

export interface RootForegroundHandle {
	readonly token: symbol;
	readonly owned: boolean;
	run<T>(work: () => Promise<T>): Promise<T>;
	release(): void;
}

/** RootForegroundLease serializes mutation in one root session while allowing nested work from its current actor. */
export class RootForegroundLease {
	private readonly context = new AsyncLocalStorage<symbol>();
	private readonly waiters: ForegroundWaiter[] = [];
	private holder: ForegroundHolder | undefined;
	private disposedError: Error | undefined;

	constructor(private readonly onChange: () => void = () => {}) {}

	get busy(): boolean {
		return this.holder !== undefined;
	}

	get actActive(): boolean {
		return (this.holder?.actDepth ?? 0) > 0;
	}

	get pendingCount(): number {
		return this.waiters.length;
	}

	get blocksCurrentContext(): boolean {
		return this.holder !== undefined && this.context.getStore() !== this.holder.token;
	}

	get currentToken(): symbol | undefined {
		return this.context.getStore();
	}

	async acquire(actor: RootForegroundActor, signal?: AbortSignal): Promise<RootForegroundHandle> {
		if (this.disposedError) throw this.disposedError;
		const current = this.context.getStore();
		if (this.holder && current === this.holder.token) return this.handle(this.holder.token, false);
		if (signal?.aborted) throw new Error("Root foreground admission aborted");
		const token = Symbol(actor);
		return new Promise<RootForegroundHandle>((resolve, reject) => {
			const waiter: ForegroundWaiter = { token, resolve, reject, signal };
			if (signal) {
				waiter.abort = () => {
					const index = this.waiters.indexOf(waiter);
					if (index >= 0) this.waiters.splice(index, 1);
					reject(new Error("Root foreground admission aborted"));
				};
				signal.addEventListener("abort", waiter.abort, { once: true });
			}
			this.waiters.push(waiter);
			this.admitNext();
		});
	}

	async run<T>(actor: RootForegroundActor, work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
		const handle = await this.acquire(actor, signal);
		try {
			return await handle.run(work);
		} finally {
			handle.release();
		}
	}

	enterAct(token: symbol): () => void {
		if (!this.holder || this.holder.token !== token) {
			throw new Error("Act host request is not correlated to the active root foreground execution");
		}
		const holder = this.holder;
		holder.actDepth++;
		this.onChange();
		let exited = false;
		return () => {
			if (exited) return;
			exited = true;
			if (this.holder !== holder || holder.actDepth === 0) return;
			holder.actDepth--;
			this.onChange();
		};
	}

	waitForCurrentActorRelease(): Promise<void> {
		const holder = this.holder;
		if (!holder) return Promise.resolve();
		return new Promise((resolve) => holder.releaseWaiters.add(resolve));
	}

	dispose(error = new Error("Root foreground lease disposed")): void {
		if (this.disposedError) return;
		this.disposedError = error;
		for (const waiter of this.waiters.splice(0)) {
			if (waiter.abort) waiter.signal?.removeEventListener("abort", waiter.abort);
			waiter.reject(error);
		}
		this.onChange();
	}

	private admitNext(): void {
		if (this.holder || this.disposedError) return;
		const waiter = this.waiters.shift();
		if (!waiter) return;
		if (waiter.abort) waiter.signal?.removeEventListener("abort", waiter.abort);
		this.holder = { token: waiter.token, actDepth: 0, releaseWaiters: new Set() };
		waiter.resolve(this.handle(waiter.token, true));
		this.onChange();
	}

	private handle(token: symbol, owned: boolean): RootForegroundHandle {
		let released = false;
		return {
			token,
			owned,
			run: (work) => this.context.run(token, work),
			release: () => {
				if (released) return;
				released = true;
				if (!owned || this.holder?.token !== token) return;
				const holder = this.holder;
				this.holder = undefined;
				for (const resolve of holder.releaseWaiters) resolve();
				holder.releaseWaiters.clear();
				this.onChange();
				this.admitNext();
			},
		};
	}
}
