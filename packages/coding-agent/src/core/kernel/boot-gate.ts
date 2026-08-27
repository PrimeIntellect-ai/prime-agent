import { cpus } from "node:os";
import { Semaphore } from "../../utils/semaphore.js";

// Above core count because boots are IO-bound (cold imports), but capped so a
// fan-out can't thrash the FS past the ready-handshake window.
const DEFAULT_KERNEL_BOOT_CONCURRENCY = Math.min(16, Math.max(4, (cpus().length || 4) * 2));
const MAX_KERNEL_BOOT_CONCURRENCY = 64;

export function resolveKernelBootConcurrency(): number {
	const raw = process.env.PRIME_AGENT_MAX_CONCURRENT_KERNEL_BOOTS;
	if (raw === undefined || !/^\d+$/.test(raw)) {
		return DEFAULT_KERNEL_BOOT_CONCURRENCY;
	}
	const parsed = Number.parseInt(raw, 10);
	// A malformed or out-of-range value (incl. 0, e.g. "00") falls back to the
	// default rather than mis-bounding the gate or throwing at module load.
	if (parsed < 1) {
		return DEFAULT_KERNEL_BOOT_CONCURRENCY;
	}
	// An explicit override may exceed the auto default (that's its purpose), but is
	// still clamped by the FS-contention cap.
	return Math.min(MAX_KERNEL_BOOT_CONCURRENCY, parsed);
}

// Resolved lazily on first boot so an env override set before the first kernel
// starts is honored — not just one set at import time.
let kernelBootSemaphore: Semaphore | undefined;

export function withKernelBootPermit<T>(boot: () => Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!kernelBootSemaphore) {
		kernelBootSemaphore = new Semaphore(resolveKernelBootConcurrency());
	}
	return kernelBootSemaphore.run(boot, signal);
}
