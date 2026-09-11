export class PromptAdmissionCancelledError extends Error {
	constructor() {
		super("Prompt admission was cancelled.");
		this.name = "PromptAdmissionCancelledError";
	}
}

export function throwIfPromptAdmissionCancelled(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw new PromptAdmissionCancelledError();
}

/**
 * Await `promise` unless `signal` aborts first. Always observes the supplied
 * work's rejection so a cancelled admission never leaks an unhandled rejection.
 */
export function waitForPromptAdmission<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
	if (!signal) return promise;
	if (signal.aborted) {
		void promise.catch(() => {});
		return Promise.reject(new PromptAdmissionCancelledError());
	}
	return new Promise<T>((resolve, reject) => {
		const cleanup = () => signal.removeEventListener("abort", onAbort);
		const onAbort = () => {
			cleanup();
			reject(new PromptAdmissionCancelledError());
		};
		signal.addEventListener("abort", onAbort, { once: true });
		// Close the listener-registration race before observing the awaited work.
		if (signal.aborted) return onAbort();
		promise.then(
			(value) => {
				cleanup();
				resolve(value);
			},
			(error: unknown) => {
				cleanup();
				reject(error);
			},
		);
	});
}
