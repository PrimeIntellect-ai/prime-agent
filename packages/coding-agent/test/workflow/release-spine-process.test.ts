import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, expect, it } from "vitest";

const workflowFixture = resolve(__dirname, "../fixtures/release-spine-workflow-process.ts");
const toolFixture = resolve(__dirname, "../fixtures/session-message-obligation-process.ts");
const tempDirs: string[] = [];
const children = new Set<ChildProcess>();
const childErrors = new WeakMap<ChildProcess, { value: string }>();

afterEach(() => {
	for (const child of children) {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	}
	children.clear();
	for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function spawnPhase(fixture: string, mode: string, rootDir: string): ChildProcess {
	const child = spawn(process.execPath, ["--import", "tsx/esm", fixture, mode, rootDir], {
		env: { ...process.env },
		stdio: ["ignore", "pipe", "pipe"],
	});
	const errorState = { value: "" };
	child.stderr?.on("data", (chunk: Buffer) => (errorState.value += chunk.toString()));
	childErrors.set(child, errorState);
	children.add(child);
	return child;
}

async function waitForPath(child: ChildProcess, path: string): Promise<void> {
	const deadline = Date.now() + 90_000;
	while (Date.now() < deadline) {
		if (existsSync(path)) return;
		if (child.exitCode !== null || child.signalCode !== null)
			throw new Error(`Release-spine child exited before ${path}: ${childErrors.get(child)?.value ?? ""}`);
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
	}
	throw new Error(`Timed out waiting for ${path}`);
}

async function waitForExit(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
	if (child.exitCode !== null || child.signalCode !== null)
		return { code: child.exitCode, signal: child.signalCode as NodeJS.Signals | null };
	return new Promise((resolveExit, rejectExit) => {
		const timeout = setTimeout(() => {
			child.kill("SIGKILL");
			rejectExit(new Error(`Timed out waiting for release-spine process: ${childErrors.get(child)?.value ?? ""}`));
		}, 60_000);
		child.once("exit", (code, signal) => {
			clearTimeout(timeout);
			const stderr = childErrors.get(child)?.value ?? "";
			if (code !== 0 && signal === null && stderr.length > 0) {
				rejectExit(new Error(stderr));
				return;
			}
			resolveExit({ code, signal });
		});
	});
}

function readResult(path: string): Record<string, unknown> {
	return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

it("reconstructs the goal-bound task, dormant blocker, and queued tool control across real process death", async () => {
	const rootDir = mkdtempSync(join(tmpdir(), "release-spine-process-"));
	tempDirs.push(rootDir);
	const workflowRoot = join(rootDir, "workflow");
	const workflowResult = join(workflowRoot, "workflow-result.json");
	const setup = spawnPhase(workflowFixture, "setup", workflowRoot);
	await waitForPath(setup, workflowResult);
	const setupResult = readResult(workflowResult);
	expect(setupResult).toMatchObject({
		mode: "setup",
		status: "blocked",
		dispatchCount: 1,
		heartbeatCount: 1,
		outcomeCount: 1,
		releaseCount: 1,
		blocker: {
			kind: "awaiting_external",
			owner: "workflow_host",
			resumeEventKind: "workflow_attempt_reconciled",
		},
	});
	setup.kill("SIGKILL");
	expect((await waitForExit(setup)).signal).toBe("SIGKILL");

	rmSync(workflowResult, { force: true });
	const recovered = spawnPhase(workflowFixture, "recover", workflowRoot);
	expect(await waitForExit(recovered)).toEqual({ code: 0, signal: null });
	const recoveredResult = readResult(workflowResult);
	expect(recoveredResult).toMatchObject({
		mode: "recover",
		statusBefore: "blocked",
		statusAfter: "active",
		taskStatus: "blocked",
		unexpectedLaunches: 0,
		duplicateResumeRejected: true,
		dispatchCount: 1,
		heartbeatCount: 1,
		outcomeCount: 1,
		releaseCount: 1,
		blockerCount: 1,
		resolutionCount: 1,
	});
	expect(recoveredResult.goalRevisionDigest).toBe(setupResult.goalRevisionDigest);

	const toolRoot = join(rootDir, "tool");
	const toolResult = join(toolRoot, "result.json");
	const toolOwner = spawnPhase(toolFixture, "tool-accept", toolRoot);
	await waitForPath(toolOwner, toolResult);
	expect(readResult(toolResult)).toMatchObject({ status: "tool-with-accepted-control", queued: 1 });
	toolOwner.kill("SIGKILL");
	expect((await waitForExit(toolOwner)).signal).toBe("SIGKILL");
	await new Promise((resolveDelay) => setTimeout(resolveDelay, 2_100));

	rmSync(toolResult, { force: true });
	const toolRecovered = spawnPhase(toolFixture, "tool-recover", toolRoot);
	expect(await waitForExit(toolRecovered)).toEqual({ code: 0, signal: null });
	expect(readResult(toolResult)).toMatchObject({
		status: "tool-recovered",
		providerCalls: 1,
		messageCount: 1,
		processedCount: 1,
		stallDiagnostic: { toolCallId: "tool-process-boundary", reason: "deadline_exceeded" },
	});
}, 180_000);

it("reconciles one deadline retry exactly once after real process death", async () => {
	const rootDir = mkdtempSync(join(tmpdir(), "release-spine-deadline-process-"));
	tempDirs.push(rootDir);
	const workflowResult = join(rootDir, "workflow-result.json");
	const setup = spawnPhase(workflowFixture, "deadline-setup", rootDir);
	await waitForPath(setup, workflowResult);
	const setupResult = readResult(workflowResult);
	expect(setupResult).toMatchObject({
		mode: "deadline-setup",
		status: "active",
		dispatchCount: 2,
		outcomeCount: 1,
		releaseCount: 1,
		blockerCount: 0,
		workerResultCount: 1,
		retryableDeadlineResultCount: 1,
		retryableDeadlineOutcomeCount: 1,
		resourceAdmissionCount: 2,
		launchEvidenceCount: 2,
	});
	const setupAttemptIds = setupResult.attemptIds as string[];
	expect(setupAttemptIds).toHaveLength(2);
	expect(setupAttemptIds[0]).toMatch(/^attempt:w1:[0-9a-f]{16}$/u);
	expect(setupAttemptIds[1]).toBe(`${setupAttemptIds[0]}:retry:1`);
	setup.kill("SIGKILL");
	expect((await waitForExit(setup)).signal).toBe("SIGKILL");
	const retryDeadlineAt = setupResult.retryDeadlineAt;
	if (typeof retryDeadlineAt !== "string") throw new Error("deadline_retry_fixture_deadline_missing");
	await new Promise((resolveDelay) =>
		setTimeout(resolveDelay, Math.max(0, Date.parse(retryDeadlineAt) - Date.now() + 200)),
	);

	rmSync(workflowResult, { force: true });
	const recovered = spawnPhase(workflowFixture, "deadline-recover", rootDir);
	expect(await waitForExit(recovered)).toEqual({ code: 0, signal: null });
	expect(readResult(workflowResult)).toMatchObject({
		mode: "deadline-recover",
		status: "blocked",
		unexpectedLaunches: 0,
		dispatchCount: 2,
		outcomeCount: 2,
		releaseCount: 2,
		blockerCount: 1,
		retryableDeadlineOutcomeCount: 2,
		resourceAdmissionCount: 2,
		executionKeyCount: 2,
		blocker: {
			kind: "awaiting_external",
			owner: "workflow_host",
			resumeEventKind: "workflow_attempt_reconciled",
		},
	});
	expect(readResult(workflowResult).attemptIds).toEqual(setupAttemptIds);
}, 180_000);
