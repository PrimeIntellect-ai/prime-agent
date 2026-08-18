import { getKeybindings } from "../keybindings.js";
import { Loader } from "./loader.js";

/**
 * Loader that can be cancelled with Escape.
 * Extends Loader with an AbortSignal for cancelling async operations.
 *
 * @example
 * const loader = new CancellableLoader(tui, cyan, dim, "Working...");
 * loader.onAbort = () => done(null);
 * doWork(loader.signal).then(done);
 */
export class CancellableLoader extends Loader {
	private abortController = new AbortController();

	/** Invoked after Escape aborts this loader. */
	onAbort?: () => void;

	/** Abort signal triggered when Escape cancels this loader. */
	get signal(): AbortSignal {
		return this.abortController.signal;
	}

	/** Whether Escape has already aborted this loader. */
	get aborted(): boolean {
		return this.abortController.signal.aborted;
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		if (kb.matches(data, "tui.select.cancel")) {
			this.abortController.abort();
			this.onAbort?.();
		}
	}

	dispose(): void {
		this.stop();
	}
}
