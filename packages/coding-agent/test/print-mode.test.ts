import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ImageContent } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentAutonomousStatus } from "../src/core/autonomous.js";
import {
	createCompactionOutcomeMessage,
	createCustomMessage,
	createRefinementOutcomeMessage,
	createSessionSlashCommandResultMessage,
} from "../src/core/messages.js";
import type { SessionShutdownEvent } from "../src/index.js";
import { selectHeadlessTerminalResult } from "../src/modes/headless-completion.js";
import { runPrintMode } from "../src/modes/print-mode.js";

const output = vi.hoisted(() => ({ write: vi.fn(), flush: vi.fn(async () => {}) }));
vi.mock("../src/core/output-guard.js", () => ({
	writeRawStdout: output.write,
	flushRawStdout: output.flush,
}));
vi.mock("../src/utils/shell.js", () => ({
	killTrackedDetachedChildren: vi.fn(),
}));

type EmitEvent = SessionShutdownEvent;

type FakeExtensionRunner = {
	hasHandlers: (eventType: string) => boolean;
	emit: ReturnType<typeof vi.fn<(event: EmitEvent) => Promise<void>>>;
};

type FakeSession = {
	sessionManager: { getHeader: () => object | undefined };
	agent: { waitForIdle: ReturnType<typeof vi.fn<() => Promise<void>>> };
	waitForIdle: ReturnType<typeof vi.fn<() => Promise<void>>>;
	waitForHeadlessIdle: ReturnType<typeof vi.fn<() => Promise<void>>>;
	state: { messages: AgentMessage[] };
	messages: AgentMessage[];
	extensionRunner: FakeExtensionRunner;
	bindExtensions: ReturnType<typeof vi.fn>;
	subscribe: ReturnType<typeof vi.fn>;
	prompt: ReturnType<typeof vi.fn>;
	promptAndWait: ReturnType<typeof vi.fn>;
	reload: ReturnType<typeof vi.fn>;
	getAutonomousStatus: ReturnType<typeof vi.fn>;
	recordHostAutonomousContinuation: ReturnType<typeof vi.fn>;
	refreshAutonomousGates: ReturnType<typeof vi.fn>;
};

type FakeRuntimeHost = {
	session: FakeSession;
	newSession: ReturnType<typeof vi.fn>;
	fork: ReturnType<typeof vi.fn>;
	switchSession: ReturnType<typeof vi.fn>;
	dispose: ReturnType<typeof vi.fn>;
	setRebindSession: ReturnType<typeof vi.fn>;
};

function createAssistantMessage(options?: {
	text?: string;
	stopReason?: AssistantMessage["stopReason"];
	errorMessage?: string;
}): AssistantMessage {
	return {
		role: "assistant",
		content: options?.text ? [{ type: "text", text: options.text }] : [],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-4o-mini",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: options?.stopReason ?? "stop",
		errorMessage: options?.errorMessage,
		timestamp: Date.now(),
	};
}

function createRuntimeHost(
	assistantMessage: AgentMessage | AgentMessage[],
	autonomousStatus: AgentAutonomousStatus = {
		enabled: false,
		continuationsUsed: 0,
		turnsUsed: 0,
		tokensUsed: 0,
		limits: { maxContinuations: 3, maxTurns: 12, maxTokens: 80_000, timeoutMs: 1_800_000 },
		gates: { commands: [], maxRetries: 3, timeoutMs: 300_000 },
		gateAttempts: {},
	},
): FakeRuntimeHost {
	const extensionRunner: FakeExtensionRunner = {
		hasHandlers: (eventType: string) => eventType === "session_shutdown",
		emit: vi.fn(async () => {}),
	};

	const state = { messages: Array.isArray(assistantMessage) ? assistantMessage : [assistantMessage] };
	const waitForIdle = vi.fn(async () => {});

	const session: FakeSession = {
		sessionManager: { getHeader: () => undefined },
		agent: { waitForIdle: vi.fn(async () => {}) },
		waitForIdle,
		waitForHeadlessIdle: waitForIdle,
		state,
		messages: state.messages,
		extensionRunner,
		bindExtensions: vi.fn(async () => {}),
		subscribe: vi.fn(() => () => {}),
		prompt: vi.fn(async () => {}),
		promptAndWait: vi.fn(async () => {}),
		reload: vi.fn(async () => {}),
		getAutonomousStatus: vi.fn(() => autonomousStatus),
		recordHostAutonomousContinuation: vi.fn(),
		refreshAutonomousGates: vi.fn(),
	};

	return {
		session,
		newSession: vi.fn(async () => undefined),
		fork: vi.fn(async () => ({ selectedText: "" })),
		switchSession: vi.fn(async () => undefined),
		dispose: vi.fn(async () => {
			await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		}),
		setRebindSession: vi.fn(),
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("runPrintMode", () => {
	it("emits session_shutdown in text mode", async () => {
		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "done" }));
		const { session } = runtimeHost;
		const images: ImageContent[] = [{ type: "image", mimeType: "image/png", data: "abc" }];

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "text",
			initialMessage: "Say done",
			initialImages: images,
		});

		expect(exitCode).toBe(0);
		expect(session.promptAndWait).toHaveBeenCalledWith("Say done", { images });
		expect(session.extensionRunner.emit).toHaveBeenCalledTimes(1);
		expect(session.extensionRunner.emit).toHaveBeenCalledWith({ type: "session_shutdown", reason: "quit" });
	});

	it("disposes the connection before exiting on SIGINT", async () => {
		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "done" }));
		const { session } = runtimeHost;
		let resolvePrompt: (() => void) | undefined;
		session.promptAndWait.mockImplementation(
			() =>
				new Promise<void>((resolve) => {
					resolvePrompt = resolve;
				}),
		);
		const onSpy = vi.spyOn(process, "on");
		const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as typeof process.exit);

		const runPromise = runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "text",
			initialMessage: "Wait",
		});
		await vi.waitFor(() => expect(session.promptAndWait).toHaveBeenCalled());
		const handler = onSpy.mock.calls.find(([event]) => event === "SIGINT")?.[1];
		if (typeof handler !== "function") throw new Error("SIGINT handler was not registered");

		handler();

		await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(130));
		expect(runtimeHost.dispose).toHaveBeenCalledTimes(1);
		expect(session.extensionRunner.emit).toHaveBeenCalledWith({ type: "session_shutdown", reason: "quit" });
		resolvePrompt?.();
		await expect(runPromise).resolves.toBe(0);
	});

	it("prints successful session command results in text mode", async () => {
		const result = createSessionSlashCommandResultMessage("No active goal.", {
			command: { name: "goal", args: "status", text: "/goal status" },
			success: true,
			severity: "info",
		});
		const runtimeHost = createRuntimeHost(result);
		output.write.mockClear();

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "text",
		});

		expect(exitCode).toBe(0);
		expect(output.write).toHaveBeenCalledWith("No active goal.\n");
	});

	it("prints a session command result before a trailing compaction outcome", async () => {
		const result = createSessionSlashCommandResultMessage("No active goal.", {
			command: { name: "goal", args: "status", text: "/goal status" },
			success: true,
			severity: "info",
		});
		const outcome = createCompactionOutcomeMessage("Requested compaction skipped", {
			reason: "requested",
			outcome: "skipped",
		});
		const runtimeHost = createRuntimeHost([result, outcome]);
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		output.write.mockClear();

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "text",
		});

		expect(exitCode).toBe(0);
		expect(output.write).toHaveBeenCalledWith("No active goal.\n");
		expect(errorSpy).toHaveBeenCalledWith("Requested compaction skipped");
	});

	it("skips malformed terminal outcomes without hiding earlier valid failures", () => {
		const failed = createCompactionOutcomeMessage("Compaction failed", {
			reason: "requested",
			outcome: "failed",
		});
		const malformed = { ...failed, details: { reason: "unknown", outcome: "failed" } } as AgentMessage;
		const assistant = createAssistantMessage({ text: "done" });

		expect(selectHeadlessTerminalResult([assistant, failed, malformed])).toEqual({
			primary: assistant,
			compactionOutcomes: [failed],
		});
	});

	it("does not select a result across a message barrier", () => {
		const outcome = createCompactionOutcomeMessage("Requested compaction skipped", {
			reason: "requested",
			outcome: "skipped",
		});
		const barriers: AgentMessage[] = [
			{ role: "user", content: "next request", timestamp: Date.now() },
			createCustomMessage("extension.notice", "unrelated", true, undefined, new Date().toISOString()),
		];

		for (const barrier of barriers) {
			expect(selectHeadlessTerminalResult([createAssistantMessage({ text: "stale" }), barrier, outcome])).toEqual({
				primary: undefined,
				compactionOutcomes: [outcome],
			});
		}
	});

	it("returns non-zero for failed session command results in text mode", async () => {
		const result = createSessionSlashCommandResultMessage("Command failed: bad arguments", {
			command: { name: "refine", args: "rollback", text: "/refine rollback" },
			success: false,
			severity: "error",
			error: "bad arguments",
		});
		const runtimeHost = createRuntimeHost(result);
		output.write.mockClear();

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "text",
		});

		expect(exitCode).toBe(1);
		expect(output.write).toHaveBeenCalledWith("Command failed: bad arguments\n");
	});

	it("emits session_shutdown in json mode", async () => {
		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "done" }));
		const { session } = runtimeHost;

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "json",
			messages: ["hello"],
		});

		expect(exitCode).toBe(0);
		expect(session.promptAndWait).toHaveBeenCalledWith("hello", {});
		expect(session.extensionRunner.emit).toHaveBeenCalledTimes(1);
		expect(session.extensionRunner.emit).toHaveBeenCalledWith({ type: "session_shutdown", reason: "quit" });
	});

	it("emits session_shutdown and returns non-zero on assistant error", async () => {
		const runtimeHost = createRuntimeHost(
			createAssistantMessage({ stopReason: "error", errorMessage: "provider failure" }),
		);
		const { session } = runtimeHost;
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "text",
		});

		expect(exitCode).toBe(1);
		expect(errorSpy).toHaveBeenCalledWith("provider failure");
		expect(session.extensionRunner.emit).toHaveBeenCalledTimes(1);
		expect(session.extensionRunner.emit).toHaveBeenCalledWith({ type: "session_shutdown", reason: "quit" });
	});

	it("prints assistant output and reports a trailing compaction outcome", async () => {
		const outcome = createCompactionOutcomeMessage("Auto-compaction skipped: nothing to compact", {
			reason: "threshold",
			outcome: "skipped",
		});
		const runtimeHost = createRuntimeHost([createAssistantMessage({ text: "done" }), outcome]);
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		output.write.mockClear();

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "text",
		});

		expect(exitCode).toBe(0);
		expect(output.write).toHaveBeenCalledWith("done\n");
		expect(errorSpy).toHaveBeenCalledWith("Auto-compaction skipped: nothing to compact");
	});

	it("prints assistant output past a trailing refinement outcome", async () => {
		const outcome = createRefinementOutcomeMessage({
			id: "refine-1",
			summary: "Added a local memory.",
			rationale: "",
			expectedOutcome: "",
			appliedEdits: [],
			harnessStatePath: "/tmp/harness/state.json",
			scope: "local",
		});
		const runtimeHost = createRuntimeHost([createAssistantMessage({ text: "done" }), outcome]);
		output.write.mockClear();

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "text",
		});

		expect(exitCode).toBe(0);
		expect(output.write).toHaveBeenCalledWith("done\n");
	});

	it("reports an outcome-only failure and exits non-zero", async () => {
		const outcome = createCompactionOutcomeMessage("Context overflow recovery failed", {
			reason: "overflow",
			outcome: "failed",
		});
		const runtimeHost = createRuntimeHost(outcome);
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		output.write.mockClear();

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "text",
		});

		expect(exitCode).toBe(1);
		expect(output.write).not.toHaveBeenCalled();
		expect(errorSpy).toHaveBeenCalledWith("Context overflow recovery failed");
	});

	it("stops host-driven gate retries once gate maxRetries is exhausted", async () => {
		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "still failing" }), {
			enabled: true,
			continuationsUsed: 1,
			turnsUsed: 2,
			tokensUsed: 100,
			startedAt: Date.now(),
			limits: { maxContinuations: 10, maxTurns: 20, maxTokens: 100_000, timeoutMs: 60_000 },
			gates: { commands: ["verify-public"], maxRetries: 3, timeoutMs: 300_000 },
			gateAttempts: { "verify-public": 4 },
			lastGateFailure: {
				command: "verify-public",
				attempt: 4,
				exitText: "not rerun: workspace unchanged since previous failed gate",
				output: "edit source files before attempting to finish again",
			},
		});
		const { session } = runtimeHost;
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "text",
		});

		expect(exitCode).toBe(1);
		expect(session.prompt).not.toHaveBeenCalled();
		expect(session.recordHostAutonomousContinuation).not.toHaveBeenCalled();
		expect(errorSpy).toHaveBeenCalledWith(
			"Autonomous quality gate still failing after attempt 4/3: not rerun: workspace unchanged since previous failed gate",
		);
	});

	it("refreshes autonomous gates after host-driven gate retries", async () => {
		const failingStatus: AgentAutonomousStatus = {
			enabled: true,
			continuationsUsed: 0,
			turnsUsed: 1,
			tokensUsed: 100,
			startedAt: Date.now(),
			limits: { maxContinuations: 3, maxTurns: 20, maxTokens: 100_000, timeoutMs: 60_000 },
			gates: { commands: ["verify-public"], maxRetries: 3, timeoutMs: 300_000 },
			gateAttempts: { "verify-public": 1 },
			lastGateFailure: {
				command: "verify-public",
				attempt: 1,
				exitText: "exited 1",
				output: "0/9",
			},
		};
		const passingStatus: AgentAutonomousStatus = {
			...failingStatus,
			continuationsUsed: 1,
			turnsUsed: 2,
			tokensUsed: 200,
			gateAttempts: { "verify-public": 0 },
			lastGateFailure: undefined,
		};
		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "fixed the gate" }), failingStatus);
		const { session } = runtimeHost;
		let currentStatus = failingStatus;
		session.getAutonomousStatus.mockImplementation(() => currentStatus);
		session.refreshAutonomousGates.mockImplementation(() => {
			currentStatus = passingStatus;
		});

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "text",
		});

		expect(exitCode).toBe(0);
		expect(session.prompt).toHaveBeenCalledTimes(1);
		expect(session.recordHostAutonomousContinuation).toHaveBeenCalledTimes(1);
		expect(session.refreshAutonomousGates).toHaveBeenCalledTimes(1);
	});

	it("keeps autonomous gate prompting after a transient assistant error while limits remain", async () => {
		const statuses: AgentAutonomousStatus[] = [
			{
				enabled: true,
				continuationsUsed: 1,
				turnsUsed: 2,
				tokensUsed: 100,
				startedAt: Date.now(),
				limits: { maxContinuations: 10, maxTurns: 20, maxTokens: 100_000, timeoutMs: 60_000 },
				gates: { commands: ["verify-public"], maxRetries: 3, timeoutMs: 300_000 },
				gateAttempts: { "verify-public": 1 },
				lastGateFailure: {
					command: "verify-public",
					attempt: 1,
					exitText: "exited 1",
					output: "0/9",
				},
			},
			{
				enabled: true,
				continuationsUsed: 1,
				turnsUsed: 3,
				tokensUsed: 200,
				startedAt: Date.now(),
				limits: { maxContinuations: 10, maxTurns: 20, maxTokens: 100_000, timeoutMs: 60_000 },
				gates: { commands: ["verify-public"], maxRetries: 3, timeoutMs: 300_000 },
				gateAttempts: { "verify-public": 2 },
				lastGateFailure: {
					command: "verify-public",
					attempt: 2,
					exitText: "exited 1",
					output: "0/9",
				},
			},
			{
				enabled: true,
				continuationsUsed: 1,
				turnsUsed: 4,
				tokensUsed: 300,
				startedAt: Date.now(),
				limits: { maxContinuations: 10, maxTurns: 20, maxTokens: 100_000, timeoutMs: 60_000 },
				gates: { commands: ["verify-public"], maxRetries: 3, timeoutMs: 300_000 },
				gateAttempts: { "verify-public": 2 },
				lastGateFailure: {
					command: "verify-public",
					attempt: 2,
					exitText: "exited 1",
					output: "0/9",
				},
			},
			{
				enabled: true,
				continuationsUsed: 1,
				turnsUsed: 5,
				tokensUsed: 400,
				startedAt: Date.now(),
				limits: { maxContinuations: 10, maxTurns: 20, maxTokens: 100_000, timeoutMs: 60_000 },
				gates: { commands: ["verify-public"], maxRetries: 3, timeoutMs: 300_000 },
				gateAttempts: { "verify-public": 2 },
			},
		];
		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "still failing" }), statuses[0]);
		const { session } = runtimeHost;
		let statusIndex = 0;
		session.getAutonomousStatus.mockImplementation(
			() => statuses[Math.min(statusIndex++, statuses.length - 1)] as AgentAutonomousStatus,
		);
		session.prompt.mockImplementationOnce(async () => {
			session.state.messages = [
				createAssistantMessage({ stopReason: "error", errorMessage: "provider down" }),
				createCompactionOutcomeMessage("Auto-compaction failed", { reason: "threshold", outcome: "failed" }),
			];
		});
		session.prompt.mockImplementationOnce(async () => {
			session.state.messages = [createAssistantMessage({ text: "still failing" })];
		});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "text",
		});

		expect(exitCode).toBe(0);
		expect(session.prompt).toHaveBeenCalledTimes(2);
		expect(session.recordHostAutonomousContinuation).toHaveBeenCalledTimes(2);
		expect(errorSpy).not.toHaveBeenCalledWith("provider down");
		expect(session.prompt.mock.calls[0][0]).toContain("Autonomous quality gate failed");
		expect(session.prompt.mock.calls[1][0]).toContain("Autonomous quality gate failed");
	});

	it("waits for a queued follow-up turn before evaluating transient assistant errors", async () => {
		const statuses: AgentAutonomousStatus[] = [
			{
				enabled: true,
				continuationsUsed: 0,
				turnsUsed: 1,
				tokensUsed: 100,
				startedAt: Date.now(),
				limits: { maxContinuations: 1, maxTurns: 20, maxTokens: 100_000, timeoutMs: 60_000 },
				gates: { commands: ["verify-public"], maxRetries: 3, timeoutMs: 300_000 },
				gateAttempts: { "verify-public": 1 },
				lastGateFailure: {
					command: "verify-public",
					attempt: 1,
					exitText: "exited 1",
					output: "0/9",
				},
			},
			{
				enabled: true,
				continuationsUsed: 1,
				turnsUsed: 2,
				tokensUsed: 200,
				startedAt: Date.now(),
				limits: { maxContinuations: 1, maxTurns: 20, maxTokens: 100_000, timeoutMs: 60_000 },
				gates: { commands: ["verify-public"], maxRetries: 3, timeoutMs: 300_000 },
				gateAttempts: { "verify-public": 1 },
			},
		];
		const runtimeHost = createRuntimeHost(
			createAssistantMessage({ stopReason: "error", errorMessage: "provider down" }),
			statuses[0],
		);
		const { session } = runtimeHost;
		let statusIndex = 0;
		session.getAutonomousStatus.mockImplementation(
			() => statuses[Math.min(statusIndex++, statuses.length - 1)] as AgentAutonomousStatus,
		);
		let waitCount = 0;
		session.waitForIdle.mockImplementation(async () => {
			waitCount++;
			if (waitCount === 2) {
				session.state.messages = [createAssistantMessage({ text: "queued retry completed" })];
			}
		});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "text",
		});

		expect(exitCode).toBe(0);
		expect(session.prompt).toHaveBeenCalledTimes(1);
		expect(session.recordHostAutonomousContinuation).toHaveBeenCalledTimes(1);
		expect(session.waitForIdle).toHaveBeenCalledTimes(3);
		expect(errorSpy).not.toHaveBeenCalledWith("provider down");
	});

	it("does not issue host-driven gate prompts once maxContinuations is reached", async () => {
		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "still failing" }), {
			enabled: true,
			continuationsUsed: 3,
			turnsUsed: 2,
			tokensUsed: 100,
			startedAt: Date.now(),
			limits: { maxContinuations: 3, maxTurns: 20, maxTokens: 100_000, timeoutMs: 60_000 },
			gates: { commands: ["verify-public"], maxRetries: 3, timeoutMs: 300_000 },
			gateAttempts: { "verify-public": 1 },
			lastGateFailure: {
				command: "verify-public",
				attempt: 1,
				exitText: "exited 1",
				output: "0/9",
			},
		});
		const { session } = runtimeHost;
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "text",
		});

		expect(exitCode).toBe(1);
		expect(session.prompt).not.toHaveBeenCalled();
		expect(session.recordHostAutonomousContinuation).not.toHaveBeenCalled();
		expect(errorSpy).toHaveBeenCalledWith(
			"Autonomous quality gate still failing after attempt 1/3: exited 1; autonomous limit reached: maxContinuations reached (3/3)",
		);
	});

	it("returns non-zero when autonomous gates are still failing", async () => {
		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "still failing" }), {
			enabled: true,
			continuationsUsed: 999,
			turnsUsed: 92,
			tokensUsed: 215_535,
			limits: { maxContinuations: 999, maxTurns: 1000, maxTokens: 2_000_000, timeoutMs: 1_800_000 },
			gates: { commands: ["verify-public"], maxRetries: 999, timeoutMs: 3_600_000 },
			gateAttempts: { "verify-public": 34 },
			lastGateFailure: {
				command: "verify-public",
				attempt: 34,
				exitText: "exited 1",
				output: "0/43",
			},
		});
		const { session } = runtimeHost;
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "text",
		});

		expect(exitCode).toBe(1);
		expect(errorSpy).toHaveBeenCalledWith(
			"Autonomous quality gate still failing after attempt 34/999: exited 1; autonomous limit reached: maxContinuations reached (999/999)",
		);
		expect(session.extensionRunner.emit).toHaveBeenCalledWith({ type: "session_shutdown", reason: "quit" });
	});

	it("reports the exact autonomous limit that stopped a still-failing gate", async () => {
		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "still failing" }), {
			enabled: true,
			continuationsUsed: 34,
			turnsUsed: 92,
			tokensUsed: 2_000_000,
			limits: { maxContinuations: 999, maxTurns: 1000, maxTokens: 2_000_000, timeoutMs: 1_800_000 },
			gates: { commands: ["verify-public"], maxRetries: 999, timeoutMs: 3_600_000 },
			gateAttempts: { "verify-public": 34 },
			lastGateFailure: {
				command: "verify-public",
				attempt: 34,
				exitText: "exited 1",
				output: "0/43",
			},
		});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "text",
		});

		expect(exitCode).toBe(1);
		expect(errorSpy).toHaveBeenCalledWith(
			"Autonomous quality gate still failing after attempt 34/999: exited 1; autonomous limit reached: maxTokens reached (2000000/2000000)",
		);
	});

	it("returns non-zero when ungated autonomous runs stop at a limit", async () => {
		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "I still need more work." }), {
			enabled: true,
			continuationsUsed: 3,
			turnsUsed: 4,
			tokensUsed: 100,
			startedAt: Date.now(),
			limits: { maxContinuations: 3, maxTurns: 20, maxTokens: 100_000, timeoutMs: 60_000 },
			gates: { commands: [], maxRetries: 3, timeoutMs: 300_000 },
			gateAttempts: {},
		});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "text",
		});

		expect(exitCode).toBe(1);
		expect(errorSpy).toHaveBeenCalledWith(
			"Autonomous run stopped before terminal evidence; maxContinuations reached (3/3)",
		);
	});

	it("keeps prompting while autonomous gates fail below retry limits", async () => {
		const statuses: AgentAutonomousStatus[] = [
			{
				enabled: true,
				continuationsUsed: 1,
				turnsUsed: 2,
				tokensUsed: 100,
				startedAt: Date.now(),
				limits: { maxContinuations: 10, maxTurns: 20, maxTokens: 100_000, timeoutMs: 60_000 },
				gates: { commands: ["verify-public"], maxRetries: 3, timeoutMs: 300_000 },
				gateAttempts: { "verify-public": 1 },
				lastGateFailure: {
					command: "verify-public",
					attempt: 1,
					exitText: "exited 1",
					output: "0/9",
				},
			},
			{
				enabled: true,
				continuationsUsed: 2,
				turnsUsed: 3,
				tokensUsed: 200,
				startedAt: Date.now(),
				limits: { maxContinuations: 10, maxTurns: 20, maxTokens: 100_000, timeoutMs: 60_000 },
				gates: { commands: ["verify-public"], maxRetries: 3, timeoutMs: 300_000 },
				gateAttempts: { "verify-public": 2 },
				lastGateFailure: {
					command: "verify-public",
					attempt: 2,
					exitText: "exited 1",
					output: "0/9 summary",
				},
			},
			{
				enabled: true,
				continuationsUsed: 2,
				turnsUsed: 4,
				tokensUsed: 250,
				startedAt: Date.now(),
				limits: { maxContinuations: 10, maxTurns: 20, maxTokens: 100_000, timeoutMs: 60_000 },
				gates: { commands: ["verify-public"], maxRetries: 3, timeoutMs: 300_000 },
				gateAttempts: { "verify-public": 2 },
			},
		];
		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "still working" }), statuses[0]);
		const { session } = runtimeHost;
		let statusIndex = 0;
		session.getAutonomousStatus.mockImplementation(
			() => statuses[Math.min(statusIndex++, statuses.length - 1)] as AgentAutonomousStatus,
		);

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "text",
		});

		expect(exitCode).toBe(0);
		expect(session.waitForIdle).toHaveBeenCalledBefore(session.prompt);
		expect(session.prompt).toHaveBeenCalledTimes(2);
		expect(session.prompt.mock.calls[0][0]).toContain("Autonomous quality gate failed (attempt 1/3)");
		expect(session.prompt.mock.calls[0][0]).toContain("0/9");
		expect(session.prompt.mock.calls[0][1]).toEqual({
			streamingBehavior: "followUp",
			internalPrompt: true,
			suppressAutonomousContinuation: true,
		});
		expect(session.prompt.mock.calls[1][0]).toContain("Autonomous quality gate failed (attempt 2/3)");
		expect(session.prompt.mock.calls[1][0]).toContain("0/9 summary");
		expect(session.prompt.mock.calls[1][1]).toEqual({
			streamingBehavior: "followUp",
			internalPrompt: true,
			suppressAutonomousContinuation: true,
		});
	});

	it("continues prompting when gate attempts do not advance but autonomous usage does", async () => {
		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "still failing" }), {
			enabled: true,
			continuationsUsed: 1,
			turnsUsed: 2,
			tokensUsed: 100,
			startedAt: Date.now(),
			limits: { maxContinuations: 10, maxTurns: 20, maxTokens: 100_000, timeoutMs: 60_000 },
			gates: { commands: ["verify-public"], maxRetries: 3, timeoutMs: 300_000 },
			gateAttempts: { "verify-public": 1 },
			lastGateFailure: {
				command: "verify-public",
				attempt: 1,
				exitText: "exited 1",
				output: "0/9",
			},
		});
		const { session } = runtimeHost;
		const statuses: AgentAutonomousStatus[] = [
			{
				enabled: true,
				continuationsUsed: 1,
				turnsUsed: 2,
				tokensUsed: 100,
				startedAt: Date.now(),
				limits: { maxContinuations: 10, maxTurns: 20, maxTokens: 100_000, timeoutMs: 60_000 },
				gates: { commands: ["verify-public"], maxRetries: 3, timeoutMs: 300_000 },
				gateAttempts: { "verify-public": 1 },
				lastGateFailure: { command: "verify-public", attempt: 1, exitText: "exited 1", output: "0/9" },
			},
			{
				enabled: true,
				continuationsUsed: 2,
				turnsUsed: 3,
				tokensUsed: 150,
				startedAt: Date.now(),
				limits: { maxContinuations: 10, maxTurns: 20, maxTokens: 100_000, timeoutMs: 60_000 },
				gates: { commands: ["verify-public"], maxRetries: 3, timeoutMs: 300_000 },
				gateAttempts: { "verify-public": 1 },
				lastGateFailure: {
					command: "verify-public",
					attempt: 1,
					exitText: "not rerun: workspace unchanged since previous failed gate",
					output: "edit source files before attempting to finish again",
				},
			},
			{
				enabled: true,
				continuationsUsed: 3,
				turnsUsed: 4,
				tokensUsed: 150,
				startedAt: Date.now(),
				limits: { maxContinuations: 10, maxTurns: 20, maxTokens: 100_000, timeoutMs: 60_000 },
				gates: { commands: ["verify-public"], maxRetries: 3, timeoutMs: 300_000 },
				gateAttempts: { "verify-public": 1 },
				lastGateFailure: {
					command: "verify-public",
					attempt: 1,
					exitText: "not rerun: workspace unchanged since previous failed gate",
					output: "edit source files before attempting to finish again",
				},
			},
			{
				enabled: true,
				continuationsUsed: 10,
				turnsUsed: 5,
				tokensUsed: 150,
				startedAt: Date.now(),
				limits: { maxContinuations: 10, maxTurns: 20, maxTokens: 100_000, timeoutMs: 60_000 },
				gates: { commands: ["verify-public"], maxRetries: 3, timeoutMs: 300_000 },
				gateAttempts: { "verify-public": 1 },
				lastGateFailure: {
					command: "verify-public",
					attempt: 1,
					exitText: "not rerun: workspace unchanged since previous failed gate",
					output: "edit source files before attempting to finish again",
				},
			},
		];
		let statusIndex = 0;
		session.getAutonomousStatus.mockImplementation(
			() => statuses[Math.min(statusIndex++, statuses.length - 1)] as AgentAutonomousStatus,
		);

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "text",
		});

		expect(exitCode).toBe(1);
		expect(session.waitForIdle).toHaveBeenCalledTimes(7);
		expect(session.prompt).toHaveBeenCalledTimes(3);
		expect(session.recordHostAutonomousContinuation).toHaveBeenCalledTimes(3);
		expect(session.prompt.mock.calls[1][0]).toContain("workspace unchanged");
		expect(session.prompt.mock.calls[2][0]).toContain("workspace unchanged");
	});

	it("keeps prompting on repeated gate progress until autonomous limits stop the run", async () => {
		const startedAt = Date.now();
		const statuses: AgentAutonomousStatus[] = [
			{
				enabled: true,
				continuationsUsed: 7,
				turnsUsed: 8,
				tokensUsed: 100,
				startedAt,
				limits: { maxContinuations: 10, maxTurns: 20, maxTokens: 100_000, timeoutMs: 60_000 },
				gates: { commands: ["verify-public"], maxRetries: 20, timeoutMs: 300_000 },
				gateAttempts: { "verify-public": 7 },
				lastGateFailure: {
					command: "verify-public",
					attempt: 7,
					exitText: "not rerun: workspace unchanged since previous failed gate",
					output: "edit source files before attempting to finish again",
				},
			},
			{
				enabled: true,
				continuationsUsed: 8,
				turnsUsed: 9,
				tokensUsed: 100,
				startedAt,
				limits: { maxContinuations: 10, maxTurns: 20, maxTokens: 100_000, timeoutMs: 60_000 },
				gates: { commands: ["verify-public"], maxRetries: 20, timeoutMs: 300_000 },
				gateAttempts: { "verify-public": 7 },
				lastGateFailure: {
					command: "verify-public",
					attempt: 7,
					exitText: "not rerun: workspace unchanged since previous failed gate",
					output: "edit source files before attempting to finish again",
				},
			},
			{
				enabled: true,
				continuationsUsed: 9,
				turnsUsed: 10,
				tokensUsed: 100,
				startedAt,
				limits: { maxContinuations: 10, maxTurns: 20, maxTokens: 100_000, timeoutMs: 60_000 },
				gates: { commands: ["verify-public"], maxRetries: 20, timeoutMs: 300_000 },
				gateAttempts: { "verify-public": 7 },
				lastGateFailure: {
					command: "verify-public",
					attempt: 7,
					exitText: "not rerun: workspace unchanged since previous failed gate",
					output: "edit source files before attempting to finish again",
				},
			},
			{
				enabled: true,
				continuationsUsed: 10,
				turnsUsed: 11,
				tokensUsed: 100,
				startedAt,
				limits: { maxContinuations: 10, maxTurns: 20, maxTokens: 100_000, timeoutMs: 60_000 },
				gates: { commands: ["verify-public"], maxRetries: 20, timeoutMs: 300_000 },
				gateAttempts: { "verify-public": 7 },
				lastGateFailure: {
					command: "verify-public",
					attempt: 7,
					exitText: "not rerun: workspace unchanged since previous failed gate",
					output: "edit source files before attempting to finish again",
				},
			},
		];
		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "still failing" }), statuses[0]);
		const { session } = runtimeHost;
		let statusIndex = 0;
		session.getAutonomousStatus.mockImplementation(
			() => statuses[Math.min(statusIndex++, statuses.length - 1)] as AgentAutonomousStatus,
		);

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "text",
		});

		expect(exitCode).toBe(1);
		expect(session.prompt).toHaveBeenCalledTimes(3);
		expect(session.prompt.mock.calls[0][0]).toContain("workspace unchanged");
		expect(session.prompt.mock.calls[2][0]).toContain("workspace unchanged");
	});
});
