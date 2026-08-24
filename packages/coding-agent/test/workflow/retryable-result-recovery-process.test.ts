import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, expect, it } from "vitest";

const fixture = resolve(__dirname, "../fixtures/retryable-result-recovery-process.ts");
const children = new Set<ChildProcess>();
const tempRoots: string[] = [];
const childErrors = new WeakMap<ChildProcess, { value: string }>();

afterEach(() => {
	for (const child of children) {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	}
	children.clear();
	for (const root of tempRoots.splice(0)) {
		for (const name of ["metadata.json", "early-recover.json", "deadline-recover.json"]) {
			try {
				const value = JSON.parse(readFileSync(join(root, name), "utf8")) as {
					readonly firstWorkerPid?: number;
					readonly workerIds?: readonly string[];
				};
				const pids = [
					value.firstWorkerPid,
					...(value.workerIds ?? []).map((workerId) => Number(workerId.split(":").at(-1))),
				].filter((pid): pid is number => typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0);
				for (const pid of pids) {
					if (!Number.isSafeInteger(pid) || pid <= 0) continue;
					process.kill(pid, "SIGKILL");
				}
			} catch {
				// The process may have died before it wrote its durable marker.
			}
		}
		rmSync(root, { recursive: true, force: true });
	}
});

function spawnPhase(mode: string, root: string): ChildProcess {
	const child = spawn(process.execPath, ["--import", "tsx/esm", fixture, mode, root], {
		env: { ...process.env },
		stdio: ["ignore", "pipe", "pipe"],
	});
	const error = { value: "" };
	child.stderr?.on("data", (chunk: Buffer) => (error.value += chunk.toString()));
	childErrors.set(child, error);
	children.add(child);
	return child;
}

async function waitForPath(child: ChildProcess, path: string): Promise<void> {
	const deadline = Date.now() + 90_000;
	while (Date.now() < deadline) {
		if (existsSync(path)) return;
		if (child.exitCode !== null || child.signalCode !== null)
			throw new Error(`retryable result process exited before ${path}`);
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
	}
	throw new Error(`timed out waiting for ${path}`);
}

async function waitForExit(
	child: ChildProcess,
): Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }> {
	if (child.exitCode !== null || child.signalCode !== null)
		return { code: child.exitCode, signal: child.signalCode as NodeJS.Signals | null };
	return new Promise((resolveExit, rejectExit) => {
		const timeout = setTimeout(() => {
			child.kill("SIGKILL");
			rejectExit(new Error("retryable result process did not exit within 60 seconds"));
		}, 60_000);
		child.once("exit", (code, signal) => {
			clearTimeout(timeout);
			if (code !== 0 && signal === null) {
				rejectExit(new Error(`retryable result ${childErrors.get(child)?.value ?? ""}`));
				return;
			}
			resolveExit({ code, signal });
		});
	});
}

function readResult(root: string, mode: string): Record<string, unknown> {
	return JSON.parse(readFileSync(join(root, `${mode}.json`), "utf8")) as Record<string, unknown>;
}

it("recovers a retryable commentary-prefixed result once before the completedAt+120s deadline", async () => {
	const root = mkdtempSync(join(tmpdir(), "retryable-result-recovery-process-"));
	tempRoots.push(root);
	const setup = spawnPhase("setup", root);
	await waitForPath(setup, join(root, "setup.json"));
	const setupResult = readResult(root, "setup");
	expect(setupResult).toMatchObject({
		mode: "setup",
		launches: 1,
		result: {
			status: "error",
			error: "worker_output_contract_invalid",
			retryable: true,
			recoveryDecision: "replan_required",
		},
		dispatchCount: 1,
		retryableOutcomeCount: 1,
	});
	const firstWorkerPid = setupResult.firstWorkerPid;
	if (typeof firstWorkerPid !== "number") throw new Error("retryable result worker pid is absent");
	expect(() => process.kill(firstWorkerPid, 0)).toThrow();
	setup.kill("SIGKILL");
	await expect(waitForExit(setup)).resolves.toMatchObject({ signal: "SIGKILL" });

	const early = spawnPhase("early-recover", root);
	await expect(waitForExit(early)).resolves.toEqual({ code: 0, signal: null });
	const earlyResult = readResult(root, "early-recover");
	expect(earlyResult).toMatchObject({
		mode: "early-recover",
		status: "active",
		launches: 1,
		dispatchCount: 2,
		oldAttemptCount: 1,
		oldWorkerIdReused: false,
		terminalTaskIds: ["recon"],
	});
	const attemptIds = earlyResult.attemptIds as string[];
	expect(attemptIds).toHaveLength(2);
	expect(attemptIds[1]).toMatch(/:retry:1$/u);
	expect(attemptIds[1]).not.toBe(attemptIds[0]);

	const deadline = spawnPhase("deadline-recover", root);
	await expect(waitForExit(deadline)).resolves.toEqual({ code: 0, signal: null });
	const deadlineResult = readResult(root, "deadline-recover");
	expect(deadlineResult).toMatchObject({
		status: "active",
		launches: 0,
		dispatchCount: 2,
		oldAttemptCount: 1,
		oldWorkerIdReused: false,
		terminalTaskIds: ["recon"],
	});
	expect(deadlineResult.attemptIds).toEqual(attemptIds);
}, 180_000);
