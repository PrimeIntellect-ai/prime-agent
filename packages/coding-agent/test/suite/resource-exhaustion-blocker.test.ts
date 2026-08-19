import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type AssistantMessage, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readSessionInfo, SessionManager } from "../../src/core/session-manager.js";
import type { ActiveSessionState } from "../../src/modes/daemon/active-session-state.js";
import { summaryForInactiveSession } from "../../src/modes/daemon/daemon-session-list.js";
import { DaemonSessionSummarizer } from "../../src/modes/daemon/daemon-session-summarizer.js";
import { createHarness, type Harness } from "./harness.js";

const processFixturePath = resolve(__dirname, "../fixtures/resource-exhaustion-process.ts");
const tsxPath = resolve(__dirname, "../../../../node_modules/tsx/dist/cli.mjs");

function resourceExhaustedMessage(resetAt = 1_787_402_590): AssistantMessage {
	return {
		...fauxAssistantMessage("The provider quota is exhausted", {
			stopReason: "error",
			errorMessage: "Provider resource limit reached (usage_limit_reached, 429)",
		}),
		diagnostics: [
			{
				type: "provider_stream_failure",
				timestamp: Date.now(),
				details: {
					kind: "resource_exhausted",
					providerErrorType: "usage_limit_reached",
					status: 429,
					limitClass: "premium",
					resetAt,
					resetInSeconds: 419_704,
					creditsUnavailable: true,
				},
			},
		],
	};
}

describe("resource exhaustion host breaker", () => {
	const harnesses: Harness[] = [];
	const processChildren = new Set<ChildProcess>();
	const processDirs: string[] = [];

	afterEach(() => {
		for (const child of processChildren) {
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		}
		processChildren.clear();
		for (const directory of processDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
	});

	function spawnProcess(mode: "seed" | "recover" | "lease-seed" | "lease-recover", rootDir: string): ChildProcess {
		const child = spawn(process.execPath, [tsxPath, processFixturePath, mode, rootDir], {
			env: {
				...process.env,
				TSX_TSCONFIG_PATH: resolve(__dirname, "../../../../tsconfig.json"),
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
		processChildren.add(child);
		return child;
	}

	async function waitForProcessExit(
		child: ChildProcess,
	): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
		if (child.exitCode !== null || child.signalCode !== null) {
			return { code: child.exitCode, signal: child.signalCode as NodeJS.Signals | null };
		}
		return new Promise((resolveExit, reject) => {
			const timeout = setTimeout(() => reject(new Error("Timed out waiting for resource blocker process")), 10_000);
			child.once("exit", (code, signal) => {
				clearTimeout(timeout);
				resolveExit({ code, signal });
			});
		});
	}

	async function waitForProcessResult(rootDir: string): Promise<void> {
		const resultPath = join(rootDir, "result.json");
		const deadline = Date.now() + 10_000;
		while (Date.now() < deadline) {
			if (existsSync(resultPath)) return;
			await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
		}
		throw new Error(`Timed out waiting for ${resultPath}`);
	}

	it("records one redacted durable blocker and does not retry the terminal assistant", async () => {
		const harness = await createHarness({
			persistSession: true,
			settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } },
		});
		harnesses.push(harness);
		harness.setResponses([resourceExhaustedMessage()]);

		await harness.session.prompt("run once");

		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.eventsOfType("auto_retry_start")).toEqual([]);
		const blockerEntries = harness.sessionManager
			.getEntries()
			.filter((entry) => entry.type === "custom" && entry.customType === "resource_exhausted_blocker");
		expect(blockerEntries).toHaveLength(1);
		expect(blockerEntries[0]).toMatchObject({
			data: {
				state: "blocked",
				provider: "faux",
				model: harness.getModel().id,
				limitClass: "premium",
				resetAt: 1_787_402_590,
				resetInSeconds: 419_704,
				creditsAvailability: "unavailable",
				authorizationRevision: expect.any(String),
				capacityRevision: expect.any(String),
			},
		});
		expect(JSON.stringify(blockerEntries[0])).not.toContain("Authorization");
		expect(JSON.stringify(blockerEntries[0])).not.toContain("secret");

		const sessionFile = harness.sessionManager.getSessionFile();
		expect(sessionFile).toBeDefined();
		const reopened = SessionManager.open(sessionFile!, harness.sessionManager.getSessionDir());
		expect(
			reopened
				.getEntries()
				.filter((entry) => entry.type === "custom" && entry.customType === "resource_exhausted_blocker"),
		).toHaveLength(1);
		const sessionInfo = await readSessionInfo(sessionFile!);
		expect(sessionInfo).not.toBeNull();
		const inactiveProjection = summaryForInactiveSession(sessionInfo!);
		expect(inactiveProjection).toMatchObject({
			summary: "Provider resource limit reached",
			taskState: "resource_exhausted",
			resourceExhaustedBlocker: { kind: "resource_exhausted", resetInSeconds: expect.any(Number) },
		});
	});

	it("keeps accepted work queued before trusted reset and admits one durable probe after reset", async () => {
		vi.useFakeTimers();
		try {
			const harness = await createHarness({ persistSession: true });
			harnesses.push(harness);
			const resetAt = Math.floor(Date.now() / 1000) + 2;
			harness.setResponses([resourceExhaustedMessage(resetAt)]);

			await harness.session.prompt("hit the limit");
			await harness.session.followUp("preserve this accepted follow-up");
			await Promise.resolve();
			expect(harness.faux.state.callCount).toBe(1);
			expect(harness.session.getSessionActionSnapshot().followUps).toEqual(["preserve this accepted follow-up"]);
			expect(harness.session.getResourceExhaustedBlocker()).toMatchObject({
				resetAt,
				resetInSeconds: expect.any(Number),
			});
			expect(harness.session.getResourceExhaustedBlocker()?.resetInSeconds).toBeLessThanOrEqual(2);

			harness.setResponses([fauxAssistantMessage("probe succeeded")]);
			await vi.advanceTimersByTimeAsync(2_100);
			await harness.session.waitForIdle();

			expect(harness.faux.state.callCount).toBe(2);
			expect(harness.session.getSessionActionSnapshot().followUps).toEqual([]);
			expect(harness.session.getResourceExhaustedBlocker()).toBeUndefined();
			const states = harness.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "custom" && entry.customType === "resource_exhausted_blocker")
				.map((entry) => (entry.type === "custom" ? (entry.data as { state: string }).state : ""));
			expect(states).toEqual(["blocked", "probe_leased", "cleared"]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("admits one probe when concurrent accepted prompts reach the reset together", async () => {
		vi.useFakeTimers();
		try {
			const harness = await createHarness({ persistSession: true });
			harnesses.push(harness);
			const resetAt = Math.floor(Date.now() / 1_000) + 2;
			harness.setResponses([
				resourceExhaustedMessage(resetAt),
				fauxAssistantMessage("first follow-up"),
				fauxAssistantMessage("second follow-up"),
			]);
			await harness.session.prompt("hit the limit");
			await Promise.all([harness.session.followUp("concurrent one"), harness.session.followUp("concurrent two")]);

			await vi.advanceTimersByTimeAsync(2_100);
			await harness.session.waitForIdle();

			expect(harness.faux.state.callCount).toBe(3);
			expect(harness.session.getSessionActionSnapshot().followUps).toEqual([]);
			expect(harness.session.getResourceExhaustedBlocker()).toBeUndefined();
			expect(
				harness.sessionManager
					.getEntries()
					.filter((entry) => entry.type === "custom" && entry.customType === "resource_exhausted_blocker")
					.filter(
						(entry) => entry.type === "custom" && (entry.data as { state?: string }).state === "probe_leased",
					),
			).toHaveLength(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("reblocks after a failed probe without consuming the queued follow-up", async () => {
		vi.useFakeTimers();
		try {
			const harness = await createHarness({ persistSession: true });
			harnesses.push(harness);
			const firstResetAt = Math.floor(Date.now() / 1000) + 2;
			harness.setResponses([resourceExhaustedMessage(firstResetAt)]);
			await harness.session.prompt("hit the limit");
			await harness.session.followUp("probe trigger");
			await harness.session.followUp("keep this after a failed probe");
			harness.setResponses([resourceExhaustedMessage(firstResetAt + 30)]);

			await vi.advanceTimersByTimeAsync(2_100);
			await harness.session.waitForSessionInputIdle();

			expect(harness.faux.state.callCount).toBe(2);
			expect(harness.session.getSessionActionSnapshot().followUps).toEqual(["keep this after a failed probe"]);
			expect(harness.session.getResourceExhaustedBlocker()).toMatchObject({ resetAt: firstResetAt + 30 });
			expect(
				harness.sessionManager
					.getEntries()
					.filter((entry) => entry.type === "custom" && entry.customType === "resource_exhausted_blocker")
					.map((entry) => (entry.type === "custom" ? (entry.data as { state: string }).state : "")),
			).toEqual(["blocked", "probe_leased", "blocked"]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("admits one probe after an explicit host model transition without switching implicitly", async () => {
		const harness = await createHarness({
			persistSession: true,
			models: [{ id: "capacity-a" }, { id: "capacity-b" }],
		});
		harnesses.push(harness);
		const resetAt = Math.floor(Date.now() / 1000) + 3600;
		harness.setResponses([resourceExhaustedMessage(resetAt)]);
		await harness.session.prompt("hit the limit");
		await harness.session.followUp("explicit model transition probe");
		harness.setResponses([fauxAssistantMessage("capacity restored")]);

		await harness.session.setModel(harness.models[1]);
		await harness.session.waitForIdle();

		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.session.model?.id).toBe("capacity-b");
		expect(harness.session.getResourceExhaustedBlocker()).toBeUndefined();
		expect(
			harness.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "custom" && entry.customType === "resource_exhausted_blocker")
				.map((entry) => (entry.type === "custom" ? (entry.data as { state: string }).state : "")),
		).toEqual(["blocked", "probe_leased", "cleared"]);
	});

	it("blocks the public summarizer projection before any fallback or LLM call", async () => {
		vi.useFakeTimers();
		try {
			const blocker = {
				kind: "resource_exhausted" as const,
				provider: "faux",
				model: "faux-1",
				limitClass: "premium",
				resetAt: Math.floor(Date.now() / 1000) + 3600,
				resetInSeconds: 3600,
				creditsAvailability: "unavailable" as const,
				authorizationRevision: "runtime:abc",
				capacityRevision: "epoch:0",
			};
			const generate = vi.fn();
			const state = {
				activeSessionId: "resource-session",
				summaryState: { summary: "stale completed recap", taskState: "completed", basedOnMessageCount: 1 },
				runtime: {
					metadata: { kind: "top-level" },
					session: {
						messages: [{ role: "user", content: "accepted input" }],
						isStreaming: false,
						isCompacting: false,
						isSessionActive: false,
						state: { streamingMessage: undefined },
						getResourceExhaustedBlocker: () => blocker,
						sessionManager: { appendAgentStatus: vi.fn() },
					},
				},
			} as unknown as ActiveSessionState;
			const summarizer = new DaemonSessionSummarizer(() => [], undefined, generate);
			summarizer.seed(state);
			summarizer.notifyActivity(state);
			await vi.advanceTimersByTimeAsync(2500);

			expect(generate).not.toHaveBeenCalled();
			expect(state.summaryState).toMatchObject({
				summary: "Provider resource limit reached",
				taskState: "resource_exhausted",
				resourceExhaustedBlocker: { ...blocker, resetInSeconds: expect.any(Number) },
			});
		} finally {
			vi.useRealTimers();
		}
	});

	it("rejects forged durable capacity revisions instead of treating them as authorization", () => {
		const manager = SessionManager.inMemory();
		manager.appendCustomEntry("resource_exhausted_blocker", {
			kind: "resource_exhausted",
			state: "blocked",
			provider: "faux",
			model: "faux-1",
			resetAt: Math.floor(Date.now() / 1000) + 86_400,
			resetInSeconds: 86_400,
			creditsAvailability: "unavailable",
			authorizationRevision: "caller-forged",
			capacityRevision: "caller-forged-future",
		});

		expect(manager.getLatestResourceExhaustedBlocker()).toBeUndefined();
	});

	it("reconstructs the blocker and accepted work across a real process restart without a pre-reset call", async () => {
		const rootDir = mkdtempSync(join(tmpdir(), "resource-exhaustion-process-"));
		processDirs.push(rootDir);
		const seed = spawnProcess("seed", rootDir);
		await waitForProcessResult(rootDir);
		seed.kill("SIGKILL");
		expect((await waitForProcessExit(seed)).signal).toBe("SIGKILL");

		const recover = spawnProcess("recover", rootDir);
		await waitForProcessExit(recover);
		const result = JSON.parse(readFileSync(join(rootDir, "result.json"), "utf8")) as {
			callCount: number;
			blocker?: { kind?: string; resetAt?: number };
			followUps: string[];
		};
		expect(result.callCount).toBe(0);
		expect(result.blocker).toMatchObject({ kind: "resource_exhausted" });
		expect(result.blocker?.resetAt).toBeGreaterThan(Math.floor(Date.now() / 1_000));
		expect(result.followUps).toEqual(["accepted work preserved across restart"]);
	});

	it("reconciles a durable probe lease after a crash before the provider call", async () => {
		const rootDir = mkdtempSync(join(tmpdir(), "resource-exhaustion-lease-process-"));
		processDirs.push(rootDir);
		const seed = spawnProcess("lease-seed", rootDir);
		await waitForProcessResult(rootDir);
		const seedResult = JSON.parse(readFileSync(join(rootDir, "result.json"), "utf8")) as {
			callCount: number;
			snapshot: { actions: unknown[] };
		};
		expect(seedResult.callCount).toBe(1);
		expect(seedResult.snapshot.actions).toHaveLength(1);
		seed.kill("SIGKILL");
		expect((await waitForProcessExit(seed)).signal).toBe("SIGKILL");

		const recover = spawnProcess("lease-recover", rootDir);
		await waitForProcessExit(recover);
		const result = JSON.parse(readFileSync(join(rootDir, "result.json"), "utf8")) as {
			callCount: number;
			blocker?: unknown;
			followUps: string[];
		};
		expect(result.callCount).toBe(1);
		expect(result.blocker).toBeUndefined();
		expect(result.followUps).toEqual([]);
	});
});
