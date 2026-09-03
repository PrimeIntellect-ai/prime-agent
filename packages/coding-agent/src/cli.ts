#!/usr/bin/env node
// ---- Pre-guard static runtime dispatch -------------------------------------
// Runs BEFORE the Node version guard and heavy imports.  Only static imports
// and synchronous parsing — no dynamic import(), no async, no I/O.
// The Node 22+ module graph fails at link time on older Node, so the heavy
// import("./cli-main.js") is inside the version guard.  The version check
// and dispatch parser are simple enough to parse on any Node that can import
// ESM (Node >= 16).
import { assertNodeVersion } from "./cli/node-version-check.js";
import { detectReservedArgv } from "./cli/sandbox-runtime-dispatch.js";

const dispatchResult = detectReservedArgv(process.argv.slice(2));
if (dispatchResult.handed) {
	// Dispatch consumed the flag.  Set exit code and exit without running
	// normal startup.  Do NOT call process.exit() — let the event loop drain
	// naturally so any pending microtasks or promise reactions settle.
	process.exitCode = dispatchResult.exitCode;
} else {
	// Normal startup path — Node version guard then heavy imports.
	await runNormalStartup();
}

// =============================================================================
// Normal startup function
// =============================================================================

async function runNormalStartup(): Promise<void> {
	const supported = assertNodeVersion({
		version: process.versions.node,
		log: console.error,
		exit: (code) => {
			process.exitCode = code;
		},
	});

	if (supported) {
		const { runCli } = await import("./cli-main.js");
		await runCli();
	}
}
