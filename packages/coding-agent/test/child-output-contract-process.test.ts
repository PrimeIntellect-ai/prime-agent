import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const fixturePath = resolve(__dirname, "fixtures/child-output-contract-process.ts");
const tsxPath = resolve(__dirname, "../../../node_modules/tsx/dist/cli.mjs");
const temporaryRoots: string[] = [];
const children = new Set<ChildProcess>();

afterEach(() => {
	for (const child of children) {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	}
	children.clear();
	for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function spawnPhase(mode: string, rootDir: string): ChildProcess {
	const child = spawn(process.execPath, [tsxPath, fixturePath, mode, rootDir], {
		env: {
			...process.env,
			TSX_TSCONFIG_PATH: resolve(__dirname, "../../../tsconfig.json"),
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	children.add(child);
	return child;
}

async function waitForExit(
	child: ChildProcess,
	deadlineMs = 10_000,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
	if (child.exitCode !== null || child.signalCode !== null)
		return { code: child.exitCode, signal: child.signalCode as NodeJS.Signals | null };
	return new Promise((resolveExit, reject) => {
		const timeout = setTimeout(() => {
			reject(new Error(`Timed out waiting for child-output fixture (${deadlineMs}ms)`));
		}, deadlineMs);
		child.once("exit", (code, signal) => {
			clearTimeout(timeout);
			resolveExit({ code, signal });
		});
	});
}

async function waitForPath(path: string, deadlineMs = 10_000): Promise<void> {
	const deadline = Date.now() + deadlineMs;
	while (Date.now() < deadline) {
		if (existsSync(path)) return;
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
	}
	throw new Error(`Timed out waiting for ${path} (${deadlineMs}ms)`);
}

function readResult(rootDir: string): Record<string, unknown> {
	return JSON.parse(readFileSync(join(rootDir, "result.json"), "utf8")) as Record<string, unknown>;
}

describe("child output contract process boundary", () => {
	it("replays one terminal output after child death and delivers one parent receipt", async () => {
		const rootDir = mkdtempSync(join(tmpdir(), "child-output-process-"));
		temporaryRoots.push(rootDir);

		const child = spawnPhase("produce", rootDir);
		await waitForPath(join(rootDir, "post-output-pre-parent-receipt.json"));
		child.kill("SIGKILL");
		expect((await waitForExit(child)).signal).toBe("SIGKILL");
		expect(readResult(rootDir)).toMatchObject({
			status: "post-output-pre-parent-receipt",
			finalResultPackets: 1,
			parentReceiptRecords: 0,
			parentContextRecords: 0,
		});

		const recovered = spawnPhase("recover", rootDir);
		expect(await waitForExit(recovered)).toEqual({ code: 0, signal: null });
		expect(readResult(rootDir)).toMatchObject({
			status: "completed-after-restart",
			reopenedStatus: "running",
			finalResultPackets: 1,
			parentReceiptRecords: 1,
			parentContextRecords: 1,
			parentReceiptConsumptionCount: 1,
			oneUseConsumptionCount: 2,
			finalResult: {
				resultId: "assistant-result-process",
				schema: "assistant-final-v1",
				validator: "assistant-final-validator-v1",
			},
		});

		const replay = spawnPhase("replay", rootDir);
		expect(await waitForExit(replay)).toEqual({ code: 0, signal: null });
		expect(readResult(rootDir)).toMatchObject({
			status: "replay-checked",
			exactDuplicate: "idempotent-no-effect",
			conflictingDuplicate: "rejected",
			staleReplay: "rejected",
			finalResultPackets: 1,
			parentReceiptRecords: 1,
			parentContextRecords: 1,
			parentReceiptConsumptionCount: 1,
			oneUseConsumptionCount: 2,
		});
	});

	it("marks empty output retryable and rejects invalid output before stage acceptance", async () => {
		const rootDir = mkdtempSync(join(tmpdir(), "child-output-invalid-process-"));
		temporaryRoots.push(rootDir);

		const invalid = spawnPhase("invalid", rootDir);
		expect(await waitForExit(invalid)).toEqual({ code: 0, signal: null });
		expect(readResult(rootDir)).toMatchObject({
			status: "invalid-output-checked",
			emptyOutput: {
				status: "retryable_incomplete",
				reason: "missing_final_assistant_result",
				wakeKind: "error",
			},
			invalidOutput: {
				status: "running",
				lastEventId: "seal-invalid",
				rejected: true,
			},
			finalResultPackets: 0,
			parentReceiptRecords: 0,
			parentContextRecords: 0,
		});
	});
});
