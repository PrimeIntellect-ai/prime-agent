import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ImageContent } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentAutonomousStatus } from "../src/core/autonomous.js";
import {
	createCompactionOutcomeMessage,
	createCustomMessage,
	createHarnessDigestMessage,
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

type RunOptions = Parameters<typeof runPrintMode>[1];

const run = (host: FakeRuntimeHost, options: RunOptions = { mode: "text" }) =>
	runPrintMode(host as unknown as Parameters<typeof runPrintMode>[0], options);

const AUTONOMOUS_LIMITS = { maxContinuations: 10, maxTurns: 20, maxTokens: 100_000, timeoutMs: 60_000 };

const gateFailure = (attempt: number, exitText = "exited 1", output = "0/9") => ({
	command: "verify-public",
	attempt,
	exitText,
	output,
});

const gateStatus = (over: Partial<AgentAutonomousStatus> = {}): AgentAutonomousStatus => ({
	enabled: true,
	continuationsUsed: 1,
	turnsUsed: 2,
	tokensUsed: 100,
	startedAt: Date.now(),
	limits: AUTONOMOUS_LIMITS,
	gates: { commands: ["verify-public"], maxRetries: 3, timeoutMs: 300_000 },
	gateAttempts: { "verify-public": 1 },
	lastGateFailure: gateFailure(1),
	...over,
});

const STALLED_GATE = gateFailure(
	1,
	"not rerun: workspace unchanged since previous failed gate",
	"edit source files before attempting to finish again",
);

const sessionCommandResult = (text: string, success: boolean) =>
	createSessionSlashCommandResultMessage(text, {
		command: { name: "goal", args: "status", text: "/goal status" },
		success,
		severity: success ? "info" : "error",
		...(success ? {} : { error: "bad arguments" }),
	});

const compactionOutcome = (text: string, outcome: "skipped" | "failed") =>
	createCompactionOutcomeMessage(text, { reason: "requested", outcome });

const refinementOutcome = () =>
	createRefinementOutcomeMessage({
		id: "refine-1",
		summary: "Added a local memory.",
		rationale: "",
		expectedOutcome: "",
		appliedEdits: [],
		harnessStatePath: "/tmp/harness/state.json",
		scope: "local",
	});

describe("selectHeadlessTerminalResult", () => {
	const assistant = createAssistantMessage({ text: "final answer" });
	const failed = compactionOutcome("Compaction failed", "failed");
	const skipped = compactionOutcome("Requested compaction skipped", "skipped");

	it.each([
		[
			"skips a malformed terminal outcome without hiding an earlier valid failure",
			[assistant, failed, { ...failed, details: { reason: "unknown", outcome: "failed" } } as AgentMessage],
			{ primary: assistant, compactionOutcomes: [failed] },
		],
		[
			"selects the saved assistant output past a resume-injected harness digest",
			[assistant, createHarnessDigestMessage("# Continual Harness State\n\nmemory: 0")],
			{ primary: assistant, compactionOutcomes: [] },
		],
		[
			"does not select a result across a user-message barrier",
			[assistant, { role: "user", content: "next request", timestamp: Date.now() } as AgentMessage, skipped],
			{ primary: undefined, compactionOutcomes: [skipped] },
		],
		[
			"does not select a result across a custom-message barrier",
			[
				assistant,
				createCustomMessage("extension.notice", "unrelated", true, undefined, new Date().toISOString()),
				skipped,
			],
			{ primary: undefined, compactionOutcomes: [skipped] },
		],
	])("%s", (_label, messages, expected) => {
		expect(selectHeadlessTerminalResult(messages)).toEqual(expected);
	});
});

describe("runPrintMode exit codes", () => {
	it.each([
		["assistant output", () => [createAssistantMessage({ text: "done" })], 0],
		["a successful session command result", () => [sessionCommandResult("No active goal.", true)], 0],
		["a failed session command result", () => [sessionCommandResult("Command failed: bad arguments", false)], 1],
		[
			"an assistant error",
			() => [createAssistantMessage({ stopReason: "error", errorMessage: "provider failure" })],
			1,
		],
		[
			"assistant output followed by a skipped compaction outcome",
			() => [createAssistantMessage({ text: "done" }), compactionOutcome("Requested compaction skipped", "skipped")],
			0,
		],
		[
			"assistant output followed by a refinement outcome",
			() => [createAssistantMessage({ text: "done" }), refinementOutcome()],
			0,
		],
		["an outcome-only failure", () => [compactionOutcome("Context overflow recovery failed", "failed")], 1],
		[
			"a session command result followed by a compaction outcome",
			() => [
				sessionCommandResult("No active goal.", true),
				compactionOutcome("Requested compaction skipped", "skipped"),
			],
			0,
		],
	])("exits %s => %s", async (_label, makeMessages, expected) => {
		const runtimeHost = createRuntimeHost(makeMessages());
		vi.spyOn(console, "error").mockImplementation(() => {});

		await expect(run(runtimeHost)).resolves.toBe(expected);
	});

	it.each([
		[
			"text",
			{
				mode: "text" as const,
				initialMessage: "Say done",
				initialImages: [{ type: "image", mimeType: "image/png", data: "abc" }] as ImageContent[],
			},
			"Say done",
			{ images: [{ type: "image", mimeType: "image/png", data: "abc" }] },
		],
		["json", { mode: "json" as const, messages: ["hello"] }, "hello", {}],
	])("forwards the initial prompt in %s mode", async (_mode, options, expectedMessage, expectedOptions) => {
		const runtimeHost = createRuntimeHost([createAssistantMessage({ text: "done" })]);

		await expect(run(runtimeHost, options)).resolves.toBe(0);
		expect(runtimeHost.session.promptAndWait).toHaveBeenCalledWith(expectedMessage, expectedOptions);
	});

	it("disposes the connection before exiting on SIGINT", async () => {
		const runtimeHost = createRuntimeHost([createAssistantMessage({ text: "done" })]);
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

		const runPromise = run(runtimeHost, { mode: "text", initialMessage: "Wait" });
		await vi.waitFor(() => expect(session.promptAndWait).toHaveBeenCalled());
		const handler = onSpy.mock.calls.find(([event]) => event === "SIGINT")?.[1];
		if (typeof handler !== "function") throw new Error("SIGINT handler was not registered");

		handler();

		await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(130));
		expect(runtimeHost.dispose).toHaveBeenCalledTimes(1);
		resolvePrompt?.();
		await expect(runPromise).resolves.toBe(0);
	});
});

describe("runPrintMode autonomous gate loop", () => {
	const PROMPT_OPTIONS = {
		streamingBehavior: "followUp",
		internalPrompt: true,
		suppressAutonomousContinuation: true,
	};

	type GateExpectation = { exitCode: number; prompts: number; errorContains?: string };

	it.each<[string, AgentAutonomousStatus[], GateExpectation]>([
		[
			"stops once the gate retry budget is exhausted",
			[gateStatus({ gateAttempts: { "verify-public": 4 }, lastGateFailure: { ...STALLED_GATE, attempt: 4 } })],
			{ exitCode: 1, prompts: 0, errorContains: "still failing after attempt 4/3" },
		],
		[
			"stops once maxContinuations is reached",
			[
				gateStatus({
					continuationsUsed: 3,
					limits: { ...AUTONOMOUS_LIMITS, maxContinuations: 3 },
				}),
			],
			{ exitCode: 1, prompts: 0, errorContains: "maxContinuations reached (3/3)" },
		],
		[
			"names the limit that stopped a still-failing gate",
			[
				gateStatus({
					continuationsUsed: 34,
					tokensUsed: 2_000_000,
					limits: { maxContinuations: 999, maxTurns: 1000, maxTokens: 2_000_000, timeoutMs: 1_800_000 },
					gates: { commands: ["verify-public"], maxRetries: 999, timeoutMs: 300_000 },
					gateAttempts: { "verify-public": 34 },
					lastGateFailure: gateFailure(34),
				}),
			],
			{ exitCode: 1, prompts: 0, errorContains: "maxTokens reached (2000000/2000000)" },
		],
		[
			"stops an ungated autonomous run at its limit",
			[
				gateStatus({
					continuationsUsed: 3,
					limits: { ...AUTONOMOUS_LIMITS, maxContinuations: 3 },
					gates: { commands: [], maxRetries: 3, timeoutMs: 300_000 },
					gateAttempts: {},
					lastGateFailure: undefined,
				}),
			],
			{ exitCode: 1, prompts: 0, errorContains: "Autonomous run stopped before terminal evidence" },
		],
		[
			"keeps prompting while the gate fails below its retry limit, then finishes",
			[
				gateStatus(),
				gateStatus({
					continuationsUsed: 2,
					turnsUsed: 3,
					gateAttempts: { "verify-public": 2 },
					lastGateFailure: gateFailure(2, "exited 1", "0/9 summary"),
				}),
				gateStatus({
					continuationsUsed: 2,
					turnsUsed: 4,
					gateAttempts: { "verify-public": 2 },
					lastGateFailure: undefined,
				}),
			],
			{ exitCode: 0, prompts: 2 },
		],
		[
			"continues prompting when gate attempts stall but autonomous usage advances",
			[
				gateStatus(),
				gateStatus({ continuationsUsed: 2, turnsUsed: 3, lastGateFailure: STALLED_GATE }),
				gateStatus({ continuationsUsed: 3, turnsUsed: 4, lastGateFailure: STALLED_GATE }),
				gateStatus({ continuationsUsed: 10, turnsUsed: 5, lastGateFailure: STALLED_GATE }),
			],
			{ exitCode: 1, prompts: 3 },
		],
		[
			"keeps prompting on repeated gate progress until a limit stops the run",
			[7, 8, 9, 10].map((continuationsUsed) =>
				gateStatus({
					continuationsUsed,
					turnsUsed: continuationsUsed + 1,
					gates: { commands: ["verify-public"], maxRetries: 20, timeoutMs: 300_000 },
					gateAttempts: { "verify-public": 7 },
					lastGateFailure: { ...STALLED_GATE, attempt: 7 },
				}),
			),
			{ exitCode: 1, prompts: 3 },
		],
	])("%s", async (_label, statuses, expected) => {
		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "still failing" }), statuses[0]);
		const { session } = runtimeHost;
		let statusIndex = 0;
		session.getAutonomousStatus.mockImplementation(
			() => statuses[Math.min(statusIndex++, statuses.length - 1)] as AgentAutonomousStatus,
		);
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		await expect(run(runtimeHost)).resolves.toBe(expected.exitCode);
		expect(session.prompt).toHaveBeenCalledTimes(expected.prompts);
		expect(session.recordHostAutonomousContinuation).toHaveBeenCalledTimes(expected.prompts);
		if (expected.prompts > 0) {
			expect(session.waitForIdle).toHaveBeenCalledBefore(session.prompt);
			expect(session.prompt.mock.calls[0][1]).toEqual(PROMPT_OPTIONS);
		}
		if (expected.errorContains) {
			expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining(expected.errorContains));
		}
	});

	it("re-runs the gates after a host-driven retry and exits clean when they pass", async () => {
		const failing = gateStatus({ continuationsUsed: 0, turnsUsed: 1 });
		const passing = gateStatus({
			continuationsUsed: 1,
			turnsUsed: 2,
			tokensUsed: 200,
			gateAttempts: { "verify-public": 0 },
			lastGateFailure: undefined,
		});
		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "fixed the gate" }), failing);
		const { session } = runtimeHost;
		let currentStatus = failing;
		session.getAutonomousStatus.mockImplementation(() => currentStatus);
		session.refreshAutonomousGates.mockImplementation(() => {
			currentStatus = passing;
		});

		await expect(run(runtimeHost)).resolves.toBe(0);
		expect(session.prompt).toHaveBeenCalledTimes(1);
		expect(session.recordHostAutonomousContinuation).toHaveBeenCalledTimes(1);
		expect(session.refreshAutonomousGates).toHaveBeenCalledTimes(1);
	});

	it("keeps gate prompting after a transient assistant error while limits remain", async () => {
		const statuses = [
			gateStatus(),
			gateStatus({
				turnsUsed: 3,
				tokensUsed: 200,
				gateAttempts: { "verify-public": 2 },
				lastGateFailure: gateFailure(2),
			}),
			gateStatus({
				turnsUsed: 4,
				tokensUsed: 300,
				gateAttempts: { "verify-public": 2 },
				lastGateFailure: gateFailure(2),
			}),
			gateStatus({
				turnsUsed: 5,
				tokensUsed: 400,
				gateAttempts: { "verify-public": 2 },
				lastGateFailure: undefined,
			}),
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
				compactionOutcome("Auto-compaction failed", "failed"),
			];
		});
		session.prompt.mockImplementationOnce(async () => {
			session.state.messages = [createAssistantMessage({ text: "still failing" })];
		});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		// The transient error is not terminal: the loop keeps its gate budget.
		await expect(run(runtimeHost)).resolves.toBe(0);
		expect(session.prompt).toHaveBeenCalledTimes(2);
		expect(session.recordHostAutonomousContinuation).toHaveBeenCalledTimes(2);
		expect(errorSpy).not.toHaveBeenCalledWith("provider down");
	});

	it("waits for a queued follow-up turn before evaluating transient assistant errors", async () => {
		const statuses = [
			gateStatus({ continuationsUsed: 0, turnsUsed: 1, limits: { ...AUTONOMOUS_LIMITS, maxContinuations: 1 } }),
			gateStatus({
				continuationsUsed: 1,
				tokensUsed: 200,
				limits: { ...AUTONOMOUS_LIMITS, maxContinuations: 1 },
				lastGateFailure: undefined,
			}),
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

		await expect(run(runtimeHost)).resolves.toBe(0);
		expect(session.prompt).toHaveBeenCalledTimes(1);
		expect(session.waitForIdle).toHaveBeenCalledTimes(3);
		expect(errorSpy).not.toHaveBeenCalledWith("provider down");
	});
});
