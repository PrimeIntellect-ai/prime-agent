import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const fixturePath = resolve(__dirname, "fixtures/session-message-obligation-process.ts");
const tsxPath = resolve(__dirname, "../../../node_modules/tsx/dist/cli.mjs");
const tempDirs: string[] = [];
const children = new Set<ChildProcess>();

afterEach(() => {
	for (const child of children) {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	}
	children.clear();
	for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
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

async function waitForExit(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
	if (child.exitCode !== null || child.signalCode !== null) {
		return { code: child.exitCode, signal: child.signalCode as NodeJS.Signals | null };
	}
	return new Promise((resolveExit, reject) => {
		const timeout = setTimeout(() => reject(new Error("Timed out waiting for obligation fixture")), 10_000);
		child.once("exit", (code, signal) => {
			clearTimeout(timeout);
			resolveExit({ code, signal });
		});
	});
}

async function waitForPath(path: string): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		if (existsSync(path)) return;
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
	}
	throw new Error(`Timed out waiting for ${path}`);
}

function readResult(rootDir: string): Record<string, unknown> {
	return JSON.parse(readFileSync(join(rootDir, "result.json"), "utf8")) as Record<string, unknown>;
}

describe("session-message obligation process boundary", () => {
	it("does not create an obligation when admission crashes before commit", async () => {
		const rootDir = mkdtempSync(join(tmpdir(), "session-message-process-before-"));
		tempDirs.push(rootDir);
		const before = spawnPhase("before", rootDir);
		expect(await waitForExit(before)).toEqual({ code: 17, signal: null });
		const recovered = spawnPhase("recover", rootDir);
		expect(await waitForExit(recovered)).toEqual({ code: 0, signal: null });
		expect(readResult(rootDir)).toMatchObject({ status: "recovered", queued: [] });
		expect(existsSync(join(rootDir, "message-obligations.jsonl"))).toBe(false);
	});

	it("reconstructs one accepted obligation after an admission process crash", async () => {
		const rootDir = mkdtempSync(join(tmpdir(), "session-message-process-accept-"));
		tempDirs.push(rootDir);
		const accepting = spawnPhase("accept", rootDir);
		await waitForPath(join(rootDir, "result.json"));
		accepting.kill("SIGKILL");
		expect((await waitForExit(accepting)).signal).toBe("SIGKILL");

		const recovered = spawnPhase("recover", rootDir);
		expect(await waitForExit(recovered)).toEqual({ code: 0, signal: null });
		expect(readResult(rootDir)).toMatchObject({
			status: "recovered",
			queued: ["agentmsg_process_boundary"],
			manifest: true,
		});
	});

	it("reconstructs the wake and processes one message after process death during compaction", async () => {
		const rootDir = mkdtempSync(join(tmpdir(), "session-message-process-compaction-"));
		tempDirs.push(rootDir);
		const accepting = spawnPhase("compaction-accept", rootDir);
		await waitForPath(join(rootDir, "result.json"));
		expect(readResult(rootDir)).toMatchObject({ status: "compacting-with-accepted-message", queued: 1 });
		accepting.kill("SIGKILL");
		expect((await waitForExit(accepting)).signal).toBe("SIGKILL");

		rmSync(join(rootDir, "result.json"), { force: true });
		const recovered = spawnPhase("compaction-recover", rootDir);
		expect(await waitForExit(recovered)).toEqual({ code: 0, signal: null });
		expect(readResult(rootDir)).toMatchObject({
			status: "compaction-recovered",
			providerCalls: 1,
			messageCount: 1,
			acceptedCount: 1,
			wakeClaimedCount: 1,
			contextDeliveredCount: 1,
			processedCount: 1,
		});
	});

	it("reconstructs an expired tool lease and delivers its queued parent control after process death", async () => {
		const rootDir = mkdtempSync(join(tmpdir(), "session-message-process-tool-"));
		tempDirs.push(rootDir);
		const accepting = spawnPhase("tool-accept", rootDir);
		await waitForPath(join(rootDir, "result.json"));
		expect(readResult(rootDir)).toMatchObject({ status: "tool-with-accepted-control", queued: 1 });
		accepting.kill("SIGKILL");
		expect((await waitForExit(accepting)).signal).toBe("SIGKILL");
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 2_100));

		rmSync(join(rootDir, "result.json"), { force: true });
		const recovered = spawnPhase("tool-recover", rootDir);
		expect(await waitForExit(recovered)).toEqual({ code: 0, signal: null });
		expect(readResult(rootDir)).toMatchObject({
			status: "tool-recovered",
			providerCalls: 1,
			messageCount: 1,
			processedCount: 1,
			stallDiagnostic: {
				toolCallId: "tool-process-boundary",
				reason: "deadline_exceeded",
			},
		});
	});

	it("quarantines a message after a crash following durable context append", async () => {
		const rootDir = mkdtempSync(join(tmpdir(), "session-message-process-context-"));
		tempDirs.push(rootDir);
		const accepting = spawnPhase("accept", rootDir);
		await waitForPath(join(rootDir, "result.json"));
		accepting.kill("SIGKILL");
		await waitForExit(accepting);

		rmSync(join(rootDir, "result.json"), { force: true });
		const context = spawnPhase("context", rootDir);
		await waitForPath(join(rootDir, "result.json"));
		context.kill("SIGKILL");
		expect((await waitForExit(context)).signal).toBe("SIGKILL");

		const quarantine = spawnPhase("quarantine", rootDir);
		expect(await waitForExit(quarantine)).toEqual({ code: 0, signal: null });
		expect(readResult(rootDir)).toMatchObject({ status: "quarantine", queued: ["agentmsg_process_boundary"] });
	});

	it("rejects transcript recovery without successor intent and produces no terminal effect", async () => {
		const rootDir = mkdtempSync(join(tmpdir(), "session-message-process-no-intent-"));
		tempDirs.push(rootDir);
		const accepting = spawnPhase("accept", rootDir);
		await waitForPath(join(rootDir, "result.json"));
		accepting.kill("SIGKILL");
		expect((await waitForExit(accepting)).signal).toBe("SIGKILL");
		rmSync(join(rootDir, "result.json"), { force: true });

		const context = spawnPhase("context-no-intent", rootDir);
		await waitForPath(join(rootDir, "result.json"));
		context.kill("SIGKILL");
		expect((await waitForExit(context)).signal).toBe("SIGKILL");

		rmSync(join(rootDir, "result.json"), { force: true });
		const quarantine = spawnPhase("quarantine-no-intent", rootDir);
		expect(await waitForExit(quarantine)).toEqual({ code: 0, signal: null });
		expect(readResult(rootDir)).toMatchObject({
			status: "rejected",
			dispatch: "quarantine",
			queued: [],
			code: "wake_owned",
		});
		const journal = readFileSync(join(rootDir, "message-obligations.jsonl"), "utf8");
		expect(journal.match(/"kind":"processed"/g)).toBeNull();
		expect(journal.match(/"kind":"failed"/g)).toBeNull();
	});

	it("rejects an overload without accepting a second message", async () => {
		const rootDir = mkdtempSync(join(tmpdir(), "session-message-process-overload-"));
		tempDirs.push(rootDir);
		const overload = spawnPhase("overload", rootDir);
		expect(await waitForExit(overload)).toEqual({ code: 0, signal: null });
		expect(readResult(rootDir)).toMatchObject({ status: "rejected", code: "CONTRACT_CHANGE" });
	});
});
