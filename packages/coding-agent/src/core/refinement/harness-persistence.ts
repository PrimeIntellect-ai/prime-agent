import { mkdirSync, rmdirSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import type { HarnessState, RefinementKind } from "./refinement.js";

/** Shared with rlm/harness.py: never expire a lock while its writer may still be running. */
export function withHarnessFileLock<T>(statePath: string, operation: () => T): T {
	const lockPath = `${statePath}.lock`;
	const deadline = performance.now() + 10_000;
	const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
	for (;;) {
		try {
			mkdirSync(lockPath);
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			if (performance.now() >= deadline) {
				throw new Error(
					`Harness state is locked: ${lockPath}. Retry; if a writer crashed, stop all writers before removing the lock directory.`,
				);
			}
			Atomics.wait(waitBuffer, 0, 0, 10);
		}
	}
	try {
		return operation();
	} finally {
		rmdirSync(lockPath);
	}
}

/** Rebase only this snapshot's changes; unrelated accepted writes belong to the latest state. */
export function mergeHarnessStateChanges(
	baseline: HarnessState,
	proposed: HarnessState,
	latest: HarnessState,
): HarnessState {
	const merged = structuredClone(latest);
	for (const kind of Object.keys(proposed.entries) as RefinementKind[]) {
		const before = baseline.entries[kind];
		const after = proposed.entries[kind];
		for (const id of new Set([...Object.keys(before), ...Object.keys(after)])) {
			if (isDeepStrictEqual(before[id], after[id])) continue;
			if (!isDeepStrictEqual(before[id], latest.entries[kind][id])) {
				throw new Error(`Harness entry changed before save: ${kind}:${id}. Reload and retry.`);
			}
			if (after[id]) merged.entries[kind][id] = structuredClone(after[id]);
			else delete merged.entries[kind][id];
		}
	}
	if (isDeepStrictEqual(baseline.refinements, proposed.refinements.slice(0, baseline.refinements.length))) {
		if (
			proposed.refinements.length > baseline.refinements.length &&
			!isDeepStrictEqual(baseline.refinements, latest.refinements.slice(0, baseline.refinements.length))
		) {
			throw new Error("Harness refinement history changed before save. Reload and retry.");
		}
		merged.refinements.push(...structuredClone(proposed.refinements.slice(baseline.refinements.length)));
	} else {
		if (!isDeepStrictEqual(baseline.refinements, latest.refinements)) {
			throw new Error("Harness refinement history changed before save. Reload and retry.");
		}
		merged.refinements = structuredClone(proposed.refinements);
	}
	if (proposed.schema !== baseline.schema) {
		if (latest.schema !== baseline.schema) throw new Error("Harness schema changed before save. Reload and retry.");
		merged.schema = proposed.schema;
	}
	return merged;
}
