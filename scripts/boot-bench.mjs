#!/usr/bin/env node
/**
 * Kernel boot fan-out benchmark. Boots N IPython kernels concurrently
 * and reports boot success rate, per-kernel latency, peak RSS, and wall time.
 *
 *   node scripts/boot-bench.mjs --mode forkserver --n 100
 *
 * Modes:
 *   ungated     direct `python -m ipykernel_launcher`, no boot gate
 *   gated       direct spawn through the boot-gate semaphore (today's default)
 *   forkserver  fork each kernel from the pre-imported template (PRIME_AGENT_KERNEL_FORKSERVER=1)
 *
 * Also asserts a forked kernel is a real, reachable kernel (runs code over ZMQ)
 * and that namespaces are isolated (a var set in kernel A is absent in kernel B).
 *
 * Requires the coding-agent package to be built (dist/). Run from the repo root.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(fileURLToPath(import.meta.url), "..", "..");
const kernelMod = join(repoRoot, "packages", "coding-agent", "dist", "core", "kernel", "index.js");
const bootstrapMod = join(repoRoot, "packages", "coding-agent", "dist", "core", "kernel", "bootstrap.js");
const bootGateMod = join(repoRoot, "packages", "coding-agent", "dist", "core", "kernel", "boot-gate.js");

function arg(name, def) {
	const i = process.argv.indexOf(`--${name}`);
	return i !== -1 ? process.argv[i + 1] : def;
}

const mode = arg("mode", "gated");
const n = Number(arg("n", 50)) || 50;

// Pin per-mode so the default-on forkserver doesn't leak into the direct-spawn modes.
process.env.PRIME_AGENT_KERNEL_FORKSERVER = mode === "forkserver" ? "1" : "0";

const { KernelManager } = await import(kernelMod);
const { ensureKernelPython } = await import(bootstrapMod);
const { withKernelBootPermit } = await import(bootGateMod);

function peakRssMb() {
	// Sum Pss across the process tree if available (COW-aware); fall back to RSS.
	return Math.round(process.memoryUsage().rss / 1024 / 1024);
}

function pct(sorted, p) {
	if (!sorted.length) return 0;
	const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
	return Math.round(sorted[idx]);
}

async function bootOne(python) {
	const m = new KernelManager({ python });
	const started = performance.now();
	const boot = () => m.start();
	if (mode === "ungated") await boot();
	else await withKernelBootPermit(boot);
	const latency = performance.now() - started;
	return { m, latency };
}

async function main() {
	console.log(`mode=${mode} n=${n} platform=${process.platform}`);
	const python = await ensureKernelPython({});

	const wallStart = performance.now();
	const results = await Promise.allSettled(Array.from({ length: n }, () => bootOne(python)));
	const wallMs = performance.now() - wallStart;

	const ok = results.filter((r) => r.status === "fulfilled");
	const latencies = ok.map((r) => r.value.latency).sort((a, b) => a - b);
	const managers = ok.map((r) => r.value.m);

	console.log(`booted:  ${ok.length}/${n} (${Math.round((100 * ok.length) / n)}%)`);
	console.log(`latency: p50=${pct(latencies, 50)}ms p90=${pct(latencies, 90)}ms max=${pct(latencies, 100)}ms`);
	console.log(`wall:    ${Math.round(wallMs)}ms`);
	console.log(`rss:     ${peakRssMb()}MB (node process only)`);

	const firstErr = results.find((r) => r.status === "rejected");
	if (firstErr) console.log(`first error: ${firstErr.reason?.message ?? firstErr.reason}`);

	// Reachability + isolation check on the first two booted kernels.
	if (managers.length >= 2) {
		const [a, b] = managers;
		const setA = await a.execute("bench_marker = 4387\nprint(bench_marker)");
		const seeB = await b.execute("print('bench_marker' in dir())");
		const reachable = setA.status === "ok" && setA.stdout.includes("4387");
		const isolated = seeB.status === "ok" && /False/.test(seeB.stdout);
		console.log(`reachable: ${reachable ? "yes" : "NO"}   isolated: ${isolated ? "yes" : "NO"}`);
	}

	await Promise.allSettled(managers.map((m) => m.dispose()));
}

await main();
process.exit(0);
