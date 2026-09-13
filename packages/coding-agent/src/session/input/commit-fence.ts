import { AsyncLocalStorage } from "node:async_hooks";
import { waitForPromiseOrAbort } from "../../utils/wait-for-abort.js";

export interface SessionCommitLease {
	readonly owner: symbol;
	release(): void;
}

export class SessionCommitFence {
	private _tail: Promise<void> = Promise.resolve();
	private _owner: symbol | undefined;
	private _pendingWaiters = 0;
	private readonly _context = new AsyncLocalStorage<symbol>();
	private readonly _disposeAbortController = new AbortController();

	get disposeSignal(): AbortSignal {
		return this._disposeAbortController.signal;
	}

	get hasPendingWork(): boolean {
		return this._owner !== undefined || this._pendingWaiters > 0;
	}

	get isHeldByCurrentContext(): boolean {
		const inheritedOwner = this._context.getStore();
		return inheritedOwner !== undefined && inheritedOwner === this._owner;
	}

	run<T>(lease: SessionCommitLease, callback: () => T): T {
		return this._context.run(lease.owner, callback);
	}

	async acquire(signal?: AbortSignal): Promise<SessionCommitLease> {
		const inheritedOwner = this._context.getStore();
		if (inheritedOwner !== undefined && inheritedOwner === this._owner) {
			return { owner: inheritedOwner, release: () => {} };
		}
		const previous = this._tail;
		let resolve = () => {};
		this._tail = new Promise<void>((release) => {
			resolve = release;
		});
		const disposeSignal = this._disposeAbortController.signal;
		const waitSignal = signal ? AbortSignal.any([signal, disposeSignal]) : disposeSignal;
		this._pendingWaiters++;
		try {
			await waitForPromiseOrAbort(previous, waitSignal, "Update restart preparation cancelled");
		} catch (error) {
			this._pendingWaiters--;
			// A cancelled waiter remains in the FIFO chain until its predecessor releases.
			void previous.then(resolve, resolve);
			if (disposeSignal.aborted) {
				throw new Error("Cannot admit a session action because the session is disposing or disposed.");
			}
			throw error;
		}
		const owner = Symbol("session-action-commit");
		this._owner = owner;
		this._pendingWaiters--;
		let released = false;
		return {
			owner,
			release: () => {
				if (released) return;
				released = true;
				if (this._owner === owner) this._owner = undefined;
				resolve();
			},
		};
	}

	dispose(): void {
		this._disposeAbortController.abort();
	}
}
