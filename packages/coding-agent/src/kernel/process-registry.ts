import { registerSessionResourceCleanup } from "@earendil-works/pi-ai";
import type { KernelClient } from "./contracts.js";

// One registry serves every client kind; two parallel registries would
// double-install process signal handlers.
export const liveKernels = new Set<KernelClient>();
let signalHandlersInstalled = false;

registerSessionResourceCleanup((sessionId) => {
	for (const k of liveKernels) {
		if (!sessionId || k.ownerSessionId === sessionId) {
			void k.shutdown({ snapshot: true, drainHostRequests: true });
		}
	}
});

export function installSignalHandlersOnce(): void {
	if (signalHandlersInstalled) return;
	signalHandlersInstalled = true;

	const asyncShutdown = async (): Promise<void> => {
		// These paths can await, so flush the namespace snapshot before tearing down.
		await Promise.allSettled([...liveKernels].map((k) => k.shutdown({ snapshot: true })));
	};

	// `beforeExit` and signal handlers can await async cleanup. `exit`
	// can only do sync work (Node won't run pending microtasks past it),
	// so it falls back to `disposeSync()` which kills the child synchronously.
	process.on("beforeExit", () => {
		void asyncShutdown();
	});
	process.on("SIGINT", () => {
		void asyncShutdown().finally(() => process.exit(130));
	});
	process.on("SIGTERM", () => {
		void asyncShutdown().finally(() => process.exit(143));
	});
	process.on("exit", () => {
		for (const k of liveKernels) k.disposeSync();
	});
}
