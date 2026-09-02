/**
 * Central timing instrumentation for startup profiling.
 * Enable with PI_TIMING=1 environment variable.
 */

import { getLogger } from "@prime-intellect/prime-agent-ai";

const log = getLogger("coding-agent.timings");
const ENABLED = process.env.PI_TIMING === "1";
const timings: Array<{ label: string; ms: number }> = [];
let lastTime = Date.now();

export function resetTimings(): void {
	if (!ENABLED) return;
	timings.length = 0;
	lastTime = Date.now();
}

export function time(label: string): void {
	if (!ENABLED) return;
	const now = Date.now();
	timings.push({ label, ms: now - lastTime });
	lastTime = now;
}

export function printTimings(): void {
	if (!ENABLED || timings.length === 0) return;
	const totalMs = timings.reduce((a, b) => a + b.ms, 0);
	log.debug("startup timings", { timings: [...timings], totalMs });
	console.error("\n--- Startup Timings ---");
	for (const t of timings) {
		console.error(`  ${t.label}: ${t.ms}ms`);
	}
	console.error(`  TOTAL: ${totalMs}ms`);
	console.error("------------------------\n");
}
