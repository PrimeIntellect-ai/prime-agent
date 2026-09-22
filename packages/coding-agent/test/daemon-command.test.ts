import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const daemonClientMock = vi.hoisted(() => {
	type Listener = (message: { type: string; activeSessionId?: string; event?: { type: string } }) => void;
	type CloseListener = (error: Error) => void;
	type Command = {
		type: string;
		name?: string;
		activeSessionId?: string;
		targetActiveSessionId?: string;
		fromActiveSessionId?: string;
		deliveryMode?: string;
		message?: string;
		schedule?: string;
		prompt?: string;
		includeInactive?: boolean;
		all?: boolean;
		sessionPath?: string;
		config?: {
			extensionFlagValues?: Record<string, boolean | string>;
			initialGoal?: { objective: string; tokenBudget?: number };
		};
	};
	type Response =
		| { type: "response"; command: string; success: true; data?: unknown }
		| { type: "response"; command: string; success: false; error: string };

	const instances: MockDaemonClient[] = [];
	const behavior = {
		promptSucceeds: false,
		emitStaleAgentEndOnAttach: false,
		connectFails: false,
		sessions: [] as Array<Record<string, unknown>>,
		/** Optional live-session summary returned by the mocked create request. */
		createdSession: undefined as Record<string, unknown> | undefined,
	};

	class MockDaemonClient {
		readonly messageListeners = new Set<Listener>();
		readonly closeListeners = new Set<CloseListener>();
		readonly requests: Command[] = [];
		messageListenerCountAtClose: number | undefined;
		closeListenerCountAtClose: number | undefined;

		constructor(readonly socketPath: string) {
			instances.push(this);
		}

		async connect(): Promise<void> {
			if (behavior.connectFails) throw new Error("mock connect failed");
		}

		async request(command: Command): Promise<Response> {
			this.requests.push(command);
			if (command.type === "list") {
				return { type: "response", command: command.type, success: true, data: { sessions: behavior.sessions } };
			}
			if (command.type === "create" && behavior.createdSession !== undefined) {
				return { type: "response", command: command.type, success: true, data: behavior.createdSession };
			}
			if (command.type === "attach" && behavior.emitStaleAgentEndOnAttach) {
				this.emitMessage({ type: "session_event", activeSessionId: "active-1", event: { type: "agent_end" } });
			}
			if (command.type === "prompt") {
				if (behavior.promptSucceeds) {
					return { type: "response", command: command.type, success: true };
				}
				return { type: "response", command: command.type, success: false, error: "prompt failed" };
			}
			return { type: "response", command: command.type, success: true };
		}

		onMessage(listener: Listener): () => void {
			this.messageListeners.add(listener);
			return () => {
				this.messageListeners.delete(listener);
			};
		}

		onClose(listener: CloseListener): () => void {
			this.closeListeners.add(listener);
			return () => {
				this.closeListeners.delete(listener);
			};
		}

		emitMessage(message: Parameters<Listener>[0]): void {
			for (const listener of [...this.messageListeners]) {
				listener(message);
			}
		}

		close(): void {
			this.messageListenerCountAtClose = this.messageListeners.size;
			this.closeListenerCountAtClose = this.closeListeners.size;
			for (const listener of [...this.closeListeners]) {
				listener(new Error("closed"));
			}
		}
	}

	return { MockDaemonClient, behavior, instances };
});

vi.mock("../src/modes/daemon/daemon-client.js", () => ({
	DaemonClient: daemonClientMock.MockDaemonClient,
}));

const spawnMock = vi.hoisted(() => {
	const calls: string[][] = [];
	return {
		calls,
		mockSpawn: (...args: unknown[]) => {
			calls.push(args[1] as string[]);
			return {
				unref: () => {},
				kill: () => {},
				pid: 99999,
				stdout: null,
				stderr: null,
				stdin: null,
				on: () => {},
				once: () => {},
			};
		},
	};
});

vi.mock("node:child_process", async (importOriginal) => {
	const original = (await importOriginal()) as Record<string, unknown>;
	return { ...original, spawn: spawnMock.mockSpawn as never };
});

import { handleDaemonCommand } from "../src/cli/daemon-command.js";

describe("daemon command", () => {
	// Table-driven argv parsing: every row runs `daemon --socket <socket> <argv>` and pins the first
	// request the CLI puts on the wire.
	it.each([
		[
			"keeps the create session name after an unknown boolean extension flag",
			["create", "--unknown-typo", "my-session"],
			{ type: "create", name: "my-session", config: { extensionFlagValues: { "unknown-typo": true } } },
		],
		[
			"parses extension flag values with equals without consuming the create name",
			["create", "--ticket=123", "my-session"],
			{ type: "create", name: "my-session", config: { extensionFlagValues: { ticket: "123" } } },
		],
		[
			"keeps bare --resume values as session id selectors",
			["create", "--resume", "abc123"],
			{ type: "create", sessionPath: "abc123" },
		],
		[
			"passes --goal and --goal-token-budget to the create config",
			["create", "--goal", "Write tests", "--goal-token-budget", "50000", "my-session"],
			{
				type: "create",
				name: "my-session",
				config: { initialGoal: { objective: "Write tests", tokenBudget: 50000 } },
			},
		],
		[
			"supports the send separator after the target for flag-like message text",
			["send", "worker", "--", "--from", "literal", "--steer"],
			{
				type: "send_message",
				targetActiveSessionId: "worker",
				fromActiveSessionId: undefined,
				message: "--from literal --steer",
			},
		],
		[
			"supports the send separator before a flag-like target or message",
			["send", "--", "--target-like", "--from", "literal"],
			{ type: "send_message", targetActiveSessionId: "--target-like", message: "--from literal" },
		],
		[
			"parses send message text from an explicit --message value",
			["send", "--from", "planner", "worker", "--message", "please keep --from literal --steer"],
			{
				type: "send_message",
				targetActiveSessionId: "worker",
				fromActiveSessionId: "planner",
				message: "please keep --from literal --steer",
			},
		],
		[
			"preserves the cron add separator before the scheduled prompt",
			["cron", "add", "active-1", "in 5m", "--", "check status"],
			{ type: "cron_add", activeSessionId: "active-1", schedule: "in 5m", prompt: "check status" },
		],
	])("%s", async (_name, argv, expected) => {
		await expect(handleDaemonCommand(["daemon", "--socket", "/tmp/prime-agent.sock", ...argv])).resolves.toBe(true);

		expect(daemonClientMock.instances[0]?.requests[0]).toMatchObject(expected);
	});

	// Rejected argv must never reach the daemon: a half-parsed command would run the wrong thing.
	it.each([
		["rejects unknown send options instead of folding them into the message", ["send", "worker", "--bogus", "hello"]],
		["rejects extra agent-messages status arguments", ["agent-messages", "pause", "active-1"]],
		["rejects an empty --goal in daemon create", ["create", "--goal", "  ", "my-session"]],
		[
			"rejects --goal-token-budget without --goal in daemon create",
			["create", "--goal-token-budget", "50000", "my-session"],
		],
	])("%s", async (_name, argv) => {
		await handleDaemonCommand(["daemon", "--socket", "/tmp/prime-agent.sock", ...argv]);

		expect(daemonClientMock.instances[0]?.requests ?? []).toEqual([]);
	});

	let consoleErrorMessages: unknown[];

	beforeEach(() => {
		process.exitCode = undefined;
		daemonClientMock.instances.length = 0;
		daemonClientMock.behavior.promptSucceeds = false;
		daemonClientMock.behavior.emitStaleAgentEndOnAttach = false;
		daemonClientMock.behavior.connectFails = false;
		daemonClientMock.behavior.sessions = [];
		daemonClientMock.behavior.createdSession = undefined;
		consoleErrorMessages = [];
		vi.spyOn(process, "exit").mockImplementation(((code?: string | number | null | undefined) => {
			throw new Error(`exit ${code}`);
		}) as typeof process.exit);
		vi.spyOn(console, "error").mockImplementation((...messages: unknown[]) => {
			consoleErrorMessages.push(...messages);
		});
		vi.spyOn(console, "log").mockImplementation(() => {});
	});

	afterEach(() => {
		process.exitCode = undefined;
		vi.restoreAllMocks();
	});

	it("ignores stale agent_end events before a daemon prompt starts", async () => {
		daemonClientMock.behavior.promptSucceeds = true;
		daemonClientMock.behavior.emitStaleAgentEndOnAttach = true;
		const command = handleDaemonCommand([
			"daemon",
			"--socket",
			"/tmp/prime-agent.sock",
			"prompt",
			"active-1",
			"hello",
		]);

		await flushPromises();

		const client = daemonClientMock.instances[0];
		expect(client?.requests.map((request) => request.type)).toEqual(["attach", "prompt"]);

		let resolved = false;
		void command.then(() => {
			resolved = true;
		});
		await flushPromises();
		expect(resolved).toBe(false);

		client?.emitMessage({ type: "session_event", activeSessionId: "active-1", event: { type: "agent_start" } });
		client?.emitMessage({ type: "session_event", activeSessionId: "active-1", event: { type: "agent_end" } });

		await expect(command).resolves.toBe(true);
		expect(client?.messageListenerCountAtClose).toBe(0);
		expect(client?.closeListenerCountAtClose).toBe(0);
	});

	it("ends json attach when the session closes", async () => {
		const command = handleDaemonCommand([
			"daemon",
			"--socket",
			"/tmp/prime-agent.sock",
			"--json",
			"attach",
			"active-1",
		]);

		await flushPromises();

		const client = daemonClientMock.instances[0];
		expect(client?.requests.map((request) => request.type)).toEqual(["attach"]);

		client?.emitMessage({ type: "session_closed", activeSessionId: "active-1" });

		await expect(command).resolves.toBe(true);
		expect(client?.messageListenerCountAtClose).toBe(0);
		expect(client?.closeListenerCountAtClose).toBe(0);
	});

	it("chooses a terminating non-colliding default name past the safe-integer range", async () => {
		const unsafeIntegerName = "9007199254740992";
		daemonClientMock.behavior.sessions = [makeSessionSummary("active-1", "session-1", unsafeIntegerName)];

		await expect(handleDaemonCommand(["daemon", "--socket", "/tmp/prime-agent.sock"])).resolves.toBe(true);

		const client = daemonClientMock.instances[1];
		expect(client?.requests[0]).toEqual({ type: "list", all: true });
		expect(client?.requests[1]).toMatchObject({ type: "create", name: "1" });
		expect(client?.requests[1]?.name).not.toBe(unsafeIntegerName);
	});

	it("resolves agent names before filtering scheduled prompts", async () => {
		daemonClientMock.behavior.sessions = [makeSessionSummary("active-1", "session-1", "alpha")];

		await expect(
			handleDaemonCommand(["daemon", "--socket", "/tmp/prime-agent.sock", "--json", "cron", "list", "alpha"]),
		).resolves.toBe(true);

		expect(daemonClientMock.instances[0]?.requests).toEqual([
			{ type: "list" },
			{ type: "cron_list", activeSessionId: "active-1", includeInactive: false },
		]);
	});

	it("does not leak --goal/--goal-token-budget into daemon startup args", async () => {
		// Force canConnectToDaemon to fail so runStart is exercised.
		daemonClientMock.behavior.connectFails = true;
		spawnMock.calls.length = 0;

		await handleDaemonCommand([
			"daemon",
			"--socket",
			"/tmp/prime-agent-goal-leak-test.sock",
			"start",
			"--goal",
			"Leak test goal",
			"--goal-token-budget",
			"100",
		]);

		expect(spawnMock.calls.length).toBe(1);
		const spawnArgs = spawnMock.calls[0]!;
		// The goal flags must NOT appear in the daemon startup args.
		expect(spawnArgs).not.toContain("--goal");
		expect(spawnArgs).not.toContain("Leak test goal");
		expect(spawnArgs).not.toContain("--goal-token-budget");
		expect(spawnArgs).not.toContain("100");
	});

	it("does not leak goal into default config for a subsequent no-goal create", async () => {
		// First create with goal — config has initialGoal.
		await handleDaemonCommand([
			"daemon",
			"--socket",
			"/tmp/prime-agent.sock",
			"create",
			"--goal",
			"Write tests",
			"--goal-token-budget",
			"50000",
			"first",
		]);
		expect(daemonClientMock.instances.at(-1)?.requests[0]).toMatchObject({
			type: "create",
			config: { initialGoal: { objective: "Write tests", tokenBudget: 50000 } },
		});

		// Second create without goal — config must NOT have initialGoal.
		await handleDaemonCommand(["daemon", "--socket", "/tmp/prime-agent.sock", "create", "second"]);
		const secondConfig = daemonClientMock.instances.at(-1)?.requests[0]?.config;
		expect(secondConfig?.initialGoal).toBeUndefined();
	});

	it("prints the created session for non-interactive --json open instead of attaching", async () => {
		daemonClientMock.behavior.createdSession = makeSessionSummary("active-open-1", "session-open-1", "open-1");
		const logCalls: unknown[][] = [];
		vi.spyOn(console, "log").mockImplementation((...messages: unknown[]) => {
			logCalls.push(messages);
		});

		await expect(handleDaemonCommand(["daemon", "--socket", "/tmp/prime-agent.sock", "--json"])).resolves.toBe(true);

		// No attach-guard error: the machine-readable path prints the summary and exits.
		expect(process.exitCode).toBeUndefined();
		expect(consoleErrorMessages).toEqual([]);
		const client = daemonClientMock.instances.at(-1);
		expect(client?.requests.some((request) => request.type === "attach")).toBe(false);
		expect(logCalls.length).toBe(1);
		expect(() => JSON.parse(String(logCalls[0]?.[0]))).not.toThrow();
	});
});

function makeSessionSummary(activeSessionId: string, sessionId: string, sessionName: string): Record<string, unknown> {
	return {
		id: activeSessionId,
		activeSessionId,
		sessionId,
		sessionName,
		cwd: "/tmp/project",
		lifecycle: "ready",
		activity: "idle",
		isSessionActive: false,
		isStreaming: false,
		isCompacting: false,
		attachedClients: 0,
		messageCount: 0,
		sessionActions: { queuedCount: 0, steering: [], followUps: [] },
	};
}

async function flushPromises(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}
