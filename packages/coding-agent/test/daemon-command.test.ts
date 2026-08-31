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
	let consoleErrorMessages: unknown[];

	beforeEach(() => {
		process.exitCode = undefined;
		daemonClientMock.instances.length = 0;
		daemonClientMock.behavior.promptSucceeds = false;
		daemonClientMock.behavior.emitStaleAgentEndOnAttach = false;
		daemonClientMock.behavior.connectFails = false;
		daemonClientMock.behavior.sessions = [];
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

	it("cleans prompt listeners when the prompt request fails", async () => {
		await expect(
			handleDaemonCommand(["daemon", "--socket", "/tmp/prime-agent.sock", "prompt", "active-1", "hello"]),
		).resolves.toBe(true);

		const client = daemonClientMock.instances[0];
		expect(client?.messageListenerCountAtClose).toBe(0);
		expect(client?.closeListenerCountAtClose).toBe(0);
		expect(
			consoleErrorMessages.some((message) => typeof message === "string" && message.includes("prompt failed")),
		).toBe(true);
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

	it("keeps create session name after an unknown boolean extension flag", async () => {
		await expect(
			handleDaemonCommand(["daemon", "--socket", "/tmp/prime-agent.sock", "create", "--unknown-typo", "my-session"]),
		).resolves.toBe(true);

		const client = daemonClientMock.instances[0];
		expect(client?.requests[0]).toEqual({
			type: "create",
			name: "my-session",
			config: {
				extensionFlagValues: {
					"unknown-typo": true,
				},
			},
			sessionPath: undefined,
			continueRecent: undefined,
		});
	});

	it("parses extension flag values with equals without consuming the create name", async () => {
		await expect(
			handleDaemonCommand(["daemon", "--socket", "/tmp/prime-agent.sock", "create", "--ticket=123", "my-session"]),
		).resolves.toBe(true);

		const client = daemonClientMock.instances[0];
		expect(client?.requests[0]).toEqual({
			type: "create",
			name: "my-session",
			config: {
				extensionFlagValues: {
					ticket: "123",
				},
			},
			sessionPath: undefined,
			continueRecent: undefined,
		});
	});

	it("keeps bare --resume values as session id selectors", async () => {
		await expect(
			handleDaemonCommand(["daemon", "--socket", "/tmp/prime-agent.sock", "create", "--resume", "abc123"]),
		).resolves.toBe(true);

		const client = daemonClientMock.instances[0];
		expect(client?.requests[0]).toMatchObject({
			type: "create",
			sessionPath: "abc123",
		});
	});

	it("rejects unknown send options instead of folding them into the message", async () => {
		await expect(
			handleDaemonCommand(["daemon", "--socket", "/tmp/prime-agent.sock", "send", "worker", "--bogus", "hello"]),
		).resolves.toBe(true);

		expect(daemonClientMock.instances[0]?.requests).toEqual([]);
		expect(
			consoleErrorMessages.some(
				(message) => typeof message === "string" && message.includes("Unknown option for send: --bogus"),
			),
		).toBe(true);
	});

	it("supports send separator after the target for flag-like message text", async () => {
		await expect(
			handleDaemonCommand([
				"daemon",
				"--socket",
				"/tmp/prime-agent.sock",
				"send",
				"worker",
				"--",
				"--from",
				"literal",
				"--steer",
			]),
		).resolves.toBe(true);

		const client = daemonClientMock.instances[0];
		expect(client?.requests[0]).toEqual({
			type: "send_message",
			targetActiveSessionId: "worker",
			fromActiveSessionId: undefined,
			message: "--from literal --steer",
		});
	});

	it("supports send separator before a flag-like target or message", async () => {
		await expect(
			handleDaemonCommand([
				"daemon",
				"--socket",
				"/tmp/prime-agent.sock",
				"send",
				"--",
				"--target-like",
				"--from",
				"literal",
			]),
		).resolves.toBe(true);

		const client = daemonClientMock.instances[0];
		expect(client?.requests[0]).toMatchObject({
			type: "send_message",
			targetActiveSessionId: "--target-like",
			message: "--from literal",
		});
	});

	it("rejects extra agent-messages status arguments", async () => {
		await expect(
			handleDaemonCommand(["daemon", "--socket", "/tmp/prime-agent.sock", "agent-messages", "pause", "active-1"]),
		).resolves.toBe(true);

		expect(daemonClientMock.instances[0]?.requests).toEqual([]);
		expect(
			consoleErrorMessages.some(
				(message) => typeof message === "string" && message.includes("Usage: daemon agent-messages pause"),
			),
		).toBe(true);
	});

	it("parses send message text from an explicit --message value", async () => {
		await expect(
			handleDaemonCommand([
				"daemon",
				"--socket",
				"/tmp/prime-agent.sock",
				"send",
				"--from",
				"planner",
				"worker",
				"--message",
				"please keep --from literal --steer",
			]),
		).resolves.toBe(true);

		const client = daemonClientMock.instances[0];
		expect(client?.requests[0]).toEqual({
			type: "send_message",
			targetActiveSessionId: "worker",
			fromActiveSessionId: "planner",
			message: "please keep --from literal --steer",
		});
	});

	it("preserves cron add separator before the scheduled prompt", async () => {
		await expect(
			handleDaemonCommand([
				"daemon",
				"--socket",
				"/tmp/prime-agent.sock",
				"cron",
				"add",
				"active-1",
				"in 5m",
				"--",
				"check status",
			]),
		).resolves.toBe(true);

		const client = daemonClientMock.instances[0];
		expect(client?.requests[0]).toEqual({
			type: "cron_add",
			activeSessionId: "active-1",
			schedule: "in 5m",
			prompt: "check status",
		});
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

	it("passes --goal and --goal-token-budget to the create config", async () => {
		await expect(
			handleDaemonCommand([
				"daemon",
				"--socket",
				"/tmp/prime-agent.sock",
				"create",
				"--goal",
				"Write tests",
				"--goal-token-budget",
				"50000",
				"my-session",
			]),
		).resolves.toBe(true);

		expect(daemonClientMock.instances[0]?.requests[0]).toMatchObject({
			type: "create",
			name: "my-session",
			config: {
				initialGoal: { objective: "Write tests", tokenBudget: 50000 },
			},
		});
	});

	it("rejects empty --goal in daemon create", async () => {
		await handleDaemonCommand([
			"daemon",
			"--socket",
			"/tmp/prime-agent.sock",
			"create",
			"--goal",
			"  ",
			"my-session",
		]);
		expect(process.exitCode).toBe(1);
		expect(
			consoleErrorMessages.some((m) => typeof m === "string" && m.includes("--goal requires a non-empty objective")),
		).toBe(true);
	});

	it("rejects --goal-token-budget without --goal in daemon create", async () => {
		await handleDaemonCommand([
			"daemon",
			"--socket",
			"/tmp/prime-agent.sock",
			"create",
			"--goal-token-budget",
			"50000",
			"my-session",
		]);
		expect(process.exitCode).toBe(1);
		expect(
			consoleErrorMessages.some((m) => typeof m === "string" && m.includes("--goal-token-budget requires --goal")),
		).toBe(true);
		// DaemonClient is constructed before runCreate parses session args
		expect(daemonClientMock.instances.length).toBe(1);
		expect(daemonClientMock.instances[0]?.requests.length).toBe(0);
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
