import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCliSubprocessEnv, createCliSubprocessLaunchSpec } from "../../../src/cli/subprocess-launch.js";
import { ENV_AGENT_DIR } from "../../../src/config.js";
import type { AutonomousRuntimeState } from "../../../src/core/autonomous.js";
import type { DaemonSocketClient } from "../../../src/modes/daemon/active-session-state.js";
import { DaemonClient } from "../../../src/modes/daemon/daemon-client.js";
import { DaemonSupervisor } from "../../../src/modes/daemon/daemon-supervisor.js";
import { waitForHeadlessCompletion } from "../../../src/modes/headless-completion.js";
import { RpcClient } from "../../../src/modes/rpc/rpc-client.js";
import { createRpcExtensionUiBridge } from "../../../src/modes/rpc/rpc-extension-ui-context.js";
import { createHarness, getAssistantTexts, getUserTexts, type Harness } from "../harness.js";

const fixturePath = resolve(__dirname, "../../fixtures/rpc-connection-mode-fixture.ts");
const fauxExtensionPath = resolve(__dirname, "../../fixtures/eng-4600-faux-extension.ts");
const rpcEofFauxExtensionPath = resolve(__dirname, "../../fixtures/rpc-eof-faux-extension.ts");
const cliPath = resolve(__dirname, "../../../src/cli.ts");
const tsxPath = resolve(__dirname, "../../../../../node_modules/tsx/dist/cli.mjs");
const repoTsconfigPath = resolve(__dirname, "../../../../../tsconfig.json");
const children = new Set<ChildProcess>();
const harnesses: Harness[] = [];
const daemonSockets = new Set<string>();
const tempRoots = new Set<string>();

afterEach(async () => {
	for (const child of children) {
		if (child.exitCode === null && child.signalCode === null) {
			child.kill("SIGKILL");
		}
	}
	children.clear();
	while (harnesses.length > 0) {
		harnesses.pop()?.cleanup();
	}
	for (const socketPath of daemonSockets) {
		const client = new DaemonClient(socketPath);
		try {
			await client.connect(500);
			await client.request({ type: "shutdown" }, 5000);
		} catch {
			// The process may have exited before publishing its socket.
		} finally {
			client.close();
		}
		for (let attempt = 0; attempt < 50 && existsSync(socketPath); attempt++) {
			await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
		}
	}
	daemonSockets.clear();
	for (const root of tempRoots) {
		rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
	}
	tempRoots.clear();
});

interface CliResult {
	code: number | null;
	signal: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
}

async function runCli(
	args: string[],
	options: { agentDir: string; stdin?: string; environment?: NodeJS.ProcessEnv },
): Promise<CliResult> {
	const child = spawn(process.execPath, [tsxPath, cliPath, ...args], {
		env: {
			...process.env,
			TSX_TSCONFIG_PATH: repoTsconfigPath,
			[ENV_AGENT_DIR]: options.agentDir,
			PI_SKIP_VERSION_CHECK: "1",
			PRIME_AGENT_INTERNAL_LEGACY_OWNED_WORKER_FRONTEND: "0",
			PRIME_AGENT_INTERNAL_DAEMON_WORKER: undefined,
			PRIME_AGENT_INTERNAL_DAEMON_WORKER_TOKEN: undefined,
			PRIME_AGENT_INTERNAL_DAEMON_WORKER_ACTIVE_SESSION_ID: undefined,
			PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_SOCKET: undefined,
			PRIME_AGENT_INTERNAL_DAEMON_WORKER_RECOVERY_JOURNAL: undefined,
			RLM_DEPTH: undefined,
			RLM_MAX_DEPTH: undefined,
			...options.environment,
		},
		stdio: ["pipe", "pipe", "pipe"],
	});
	children.add(child);
	let stdout = "";
	let stderr = "";
	child.stdout?.on("data", (chunk: Buffer) => {
		stdout += chunk.toString("utf8");
	});
	child.stderr?.on("data", (chunk: Buffer) => {
		stderr += chunk.toString("utf8");
	});
	child.stdin?.end(options.stdin ?? "");
	const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit, reject) => {
		const timeout = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`CLI timed out\n${stderr}`));
		}, 20_000);
		child.once("exit", (code, signal) => {
			clearTimeout(timeout);
			resolveExit({ code, signal: signal as NodeJS.Signals | null });
		});
	});
	children.delete(child);
	return { ...exit, stdout, stderr };
}

async function runRpc(
	commands: unknown[],
	options: { trailingNewline?: boolean } = {},
): Promise<{ stdout: object[]; stderr: string }> {
	const child = spawn(process.execPath, [tsxPath, fixturePath], {
		env: { ...process.env, TSX_TSCONFIG_PATH: repoTsconfigPath },
		stdio: ["pipe", "pipe", "pipe"],
	});
	children.add(child);
	let stdout = "";
	let stderr = "";
	child.stdout?.on("data", (chunk: Buffer) => {
		stdout += chunk.toString("utf8");
	});
	child.stderr?.on("data", (chunk: Buffer) => {
		stderr += chunk.toString("utf8");
	});
	const input = commands.map((command) => JSON.stringify(command)).join("\n");
	child.stdin?.end(options.trailingNewline === false ? input : `${input}\n`);
	const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit, reject) => {
		const timeout = setTimeout(() => reject(new Error(`RPC fixture timed out\n${stderr}`)), 10_000);
		child.once("exit", (code, signal) => {
			clearTimeout(timeout);
			resolveExit({ code, signal: signal as NodeJS.Signals | null });
		});
	});
	children.delete(child);
	expect(exit).toEqual({ code: 0, signal: null });
	return {
		stdout: stdout
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as object),
		stderr,
	};
}

describe("ENG-4685 daemon-backed client modes", () => {
	it("commits owned-worker promotion before best-effort peer synchronization", async () => {
		const client = { id: "client-1" } as DaemonSocketClient;
		const worker = {
			descriptor: { ownerClientId: "protocol-client" },
			launchEnv: { TEST: "value" },
		};
		const persistWorker = vi.fn();
		const syncAgentPeers = vi.fn(async () => {
			throw new Error("peer unavailable");
		});
		const log = vi.fn();
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			protocolClientId: () => "protocol-client",
			persistWorker,
			syncAgentPeers,
			log,
		}) as {
			promoteOwnedWorker(client: DaemonSocketClient, resident: typeof worker): Promise<void>;
		};

		await supervisor.promoteOwnedWorker(client, worker);
		await supervisor.promoteOwnedWorker(client, worker);

		expect(worker.descriptor.ownerClientId).toBeUndefined();
		expect(worker.launchEnv).toBeUndefined();
		expect(persistWorker).toHaveBeenCalledOnce();
		expect(syncAgentPeers).toHaveBeenCalledOnce();
		expect(log).toHaveBeenCalledWith(expect.stringContaining("peer unavailable"));
	});

	it("rolls back owned-worker promotion when persistence fails", async () => {
		const client = { id: "client-1" } as DaemonSocketClient;
		const descriptor = { ownerClientId: "protocol-client" };
		const timer = setTimeout(() => {}, 60_000);
		const worker = {
			descriptor,
			launchEnv: { TEST: "value" },
			ownerCleanupTimer: timer,
		};
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			protocolClientId: () => "protocol-client",
			persistWorker: () => {
				throw new Error("disk full");
			},
		}) as {
			promoteOwnedWorker(client: DaemonSocketClient, resident: typeof worker): Promise<void>;
		};

		await expect(supervisor.promoteOwnedWorker(client, worker)).rejects.toThrow("disk full");

		expect(worker.descriptor).toBe(descriptor);
		expect(worker.launchEnv).toEqual({ TEST: "value" });
		expect(worker.ownerCleanupTimer).toBe(timer);
		clearTimeout(timer);
	});

	it("runs host-owned autonomous gate retries through the shared completion loop", async () => {
		const gate = `${process.execPath} -e "process.exit(0)"`;
		const harness = await createHarness({
			autonomous: {
				enabled: true,
				maxContinuations: 2,
				gates: { commands: [gate], maxRetries: 2 },
			},
		});
		harnesses.push(harness);
		const state = (
			harness.session as unknown as {
				_autonomousState: AutonomousRuntimeState;
			}
		)._autonomousState;
		state.gateAttempts[gate] = 1;
		state.lastGateFailure = {
			command: gate,
			attempt: 1,
			exitText: "exited 1",
			output: "gate failed",
		};
		harness.setResponses([fauxAssistantMessage("I fixed the gate failure.")]);

		const status = await waitForHeadlessCompletion(harness.session);

		expect(getUserTexts(harness)).toHaveLength(1);
		expect(getUserTexts(harness)[0]).toContain("Autonomous quality gate failed");
		expect(getAssistantTexts(harness)).toEqual(["I fixed the gate failure."]);
		expect(status).toMatchObject({
			continuationsUsed: 1,
			lastGateFailure: undefined,
		});
	});

	it("resolves source subprocesses independently of a spaced runtime cwd", () => {
		const entrypoint = resolve(__dirname, "../../../src/cli.ts");
		const launch = createCliSubprocessLaunchSpec([], process.execPath, [], "packages/coding-agent/src/cli.ts");
		const environment = createCliSubprocessEnv({}, entrypoint, ["--import", "tsx"]);

		expect(launch.args[0]).toBe(resolve("packages/coding-agent/src/cli.ts"));
		expect(environment.TSX_TSCONFIG_PATH).toBe(repoTsconfigPath);
	});

	it("launches real daemon workers for every migrated client surface", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-agent-4685-clients-"));
		tempRoots.add(root);
		const agentDir = join(root, "agent dir");
		const socketPath = join(root, "daemon.sock");
		daemonSockets.add(socketPath);
		const baseArgs = [
			"--daemon-socket",
			socketPath,
			"--model",
			"faux/faux",
			"--extension",
			fauxExtensionPath,
			"--no-tools",
			"--no-skills",
			"--no-prompt-templates",
			"--no-themes",
			"--no-context-files",
		];
		const cases = [
			{ name: "print", args: ["--print"], stdin: "" },
			{ name: "json", args: ["--mode", "json"], stdin: "" },
			{ name: "rpc", args: ["--mode", "rpc"], stdin: '{"id":"state","type":"get_state"}\n' },
			{ name: "piped stdin", args: [], stdin: "   \n" },
			{ name: "no-session", args: ["--print", "--no-session"], stdin: "" },
		];

		for (const testCase of cases) {
			const result = await runCli([...baseArgs, ...testCase.args], { agentDir, stdin: testCase.stdin });
			expect(result, testCase.name).toMatchObject({ code: 0, signal: null });
			expect(result.stderr, testCase.name).not.toContain("Timed out waiting for daemon worker");
			if (testCase.name === "rpc") {
				expect(result.stdout).toContain('"command":"get_state","success":true');
			}
		}
		expect(existsSync(socketPath)).toBe(true);
	}, 90_000);

	it("keeps the rollback frontend fully off the daemon path", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-agent-4685-rollback-"));
		tempRoots.add(root);
		const agentDir = join(root, "agent");
		const socketPath = join(root, "must-not-exist.sock");
		const result = await runCli(
			[
				"--print",
				"--daemon-socket",
				socketPath,
				"--model",
				"faux/faux",
				"--extension",
				fauxExtensionPath,
				"--no-tools",
				"--no-skills",
				"--no-prompt-templates",
				"--no-themes",
				"--no-context-files",
			],
			{
				agentDir,
				environment: { PRIME_AGENT_INTERNAL_LEGACY_OWNED_WORKER_FRONTEND: "1" },
			},
		);

		expect(result).toMatchObject({ code: 0, signal: null });
		expect(existsSync(socketPath)).toBe(false);
	}, 30_000);

	it("loads headless runtime services only in the worker", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-agent-4685-services-"));
		tempRoots.add(root);
		const agentDir = join(root, "agent");
		const socketPath = join(root, "daemon.sock");
		const markerPath = join(root, "extension-loads.txt");
		const extensionPath = join(root, "load-marker.ts");
		daemonSockets.add(socketPath);
		writeFileSync(
			extensionPath,
			'import { appendFileSync } from "node:fs";\nexport default function() { appendFileSync(process.env.PRIME_AGENT_TEST_EXTENSION_LOAD_MARKER, "loaded\\n"); }\n',
		);

		const result = await runCli(
			[
				"--print",
				"--daemon-socket",
				socketPath,
				"--model",
				"faux/faux",
				"--extension",
				fauxExtensionPath,
				"--extension",
				extensionPath,
				"--no-tools",
				"--no-skills",
				"--no-prompt-templates",
				"--no-themes",
				"--no-context-files",
			],
			{
				agentDir,
				environment: { PRIME_AGENT_TEST_EXTENSION_LOAD_MARKER: markerPath },
			},
		);

		expect(result).toMatchObject({ code: 0, signal: null });
		expect(readFileSync(markerPath, "utf8").trim().split("\n")).toEqual(["loaded"]);
	}, 30_000);

	it("drains accepted RPC commands before EOF releases the connection", async () => {
		const result = await runRpc([{ id: "models", type: "get_available_models" }]);
		expect(result.stderr).toBe("");
		expect(result.stdout).toEqual([
			{
				id: "models",
				type: "response",
				command: "get_available_models",
				success: true,
				data: { models: [] },
			},
		]);
	});

	it("drains accepted RPC prompt work before EOF releases the connection", async () => {
		const result = await runRpc([{ id: "prompt", type: "prompt", message: "async-eof" }]);
		expect(result.stderr).toBe("");
		expect(result.stdout).toEqual([
			{ id: "prompt", type: "response", command: "prompt", success: true },
			{ type: "agent_start" },
			{ type: "agent_end", messages: [] },
		]);
	});

	it("drains accepted daemon RPC prompt work before EOF", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-agent-4685-rpc-eof-"));
		tempRoots.add(root);
		const socketPath = join(root, "daemon.sock");
		daemonSockets.add(socketPath);
		const result = await runCli(
			[
				"--mode",
				"rpc",
				"--no-session",
				"--daemon-socket",
				socketPath,
				"--model",
				"faux/faux",
				"--extension",
				rpcEofFauxExtensionPath,
				"--no-tools",
				"--no-skills",
				"--no-prompt-templates",
				"--no-themes",
				"--no-context-files",
			],
			{
				agentDir: join(root, "agent"),
				stdin: '{"id":"prompt","type":"prompt","message":"finish before EOF"}\n',
			},
		);

		expect(result).toMatchObject({ code: 0, signal: null, stderr: "" });
		expect(result.stdout).toContain('{"id":"prompt","type":"response","command":"prompt","success":true}');
		expect(result.stdout).toContain("rpc eof response");
		expect(result.stdout).toContain('"type":"agent_end"');
	}, 30_000);

	it("drains an unterminated final RPC command before EOF", async () => {
		const result = await runRpc([{ id: "models", type: "get_available_models" }], {
			trailingNewline: false,
		});
		expect(result.stderr).toBe("");
		expect(result.stdout).toEqual([
			{
				id: "models",
				type: "response",
				command: "get_available_models",
				success: true,
				data: { models: [] },
			},
		]);
	});

	it("returns a structured error for scalar JSON input", async () => {
		const result = await runRpc([null]);
		expect(result.stderr).toBe("");
		expect(result.stdout).toEqual([
			{
				type: "response",
				command: "parse",
				success: false,
				error: "Invalid command: expected an object with a string type",
			},
		]);
	});

	it("cancels pending extension dialogs on RPC EOF", async () => {
		const result = await runRpc([{ id: "prompt", type: "prompt", message: "extension-ui" }]);
		expect(result.stderr).toBe("");
		expect(result.stdout).toEqual([
			{
				type: "extension_ui_request",
				id: "extension-ui-1",
				method: "confirm",
				title: "Confirm",
				message: "Continue?",
			},
			{ id: "prompt", type: "response", command: "prompt", success: true },
			{ type: "agent_start" },
		]);
	});

	it("closes local RPC extension dialogs and rejects future waits", async () => {
		const bridge = createRpcExtensionUiBridge(() => {});
		const pending = bridge.uiContext.editor("Edit", "draft");

		bridge.close();

		await expect(pending).resolves.toBeUndefined();
		await expect(bridge.uiContext.editor("Edit again", "draft")).resolves.toBeUndefined();
	});

	it("isolates throwing RPC event listeners", () => {
		const client = new RpcClient();
		const observed: string[] = [];
		client.onObservedSessionEvent(() => {
			throw new Error("listener failed");
		});
		client.onObservedSessionEvent((event) => observed.push(event.type));

		(client as unknown as { handleLine(line: string): void }).handleLine(
			JSON.stringify({ type: "observed_session_closed", activeSessionId: "child" }),
		);

		expect(observed).toEqual(["observed_session_closed"]);
	});

	it("orders concurrent observation baselines before their live events", async () => {
		const result = await runRpc([
			{ id: "observe-1", type: "observe", activeSessionId: "slow-child" },
			{ id: "observe-2", type: "observe", activeSessionId: "slow-child" },
		]);
		const firstResponse = result.stdout.findIndex((record) => "id" in record && record.id === "observe-1");
		const firstEvent = result.stdout.findIndex(
			(record) => "type" in record && record.type === "observed_session_event",
		);

		expect(firstResponse).toBeGreaterThanOrEqual(0);
		expect(firstEvent).toBeGreaterThan(firstResponse);
	});

	it("preserves prompt acknowledgements before events and repeated prompts", async () => {
		const result = await runRpc([
			{ id: "prompt-1", type: "prompt", message: "one" },
			{ id: "prompt-2", type: "prompt", message: "two" },
		]);
		expect(result.stderr).toBe("");
		expect(result.stdout).toEqual([
			{ id: "prompt-1", type: "response", command: "prompt", success: true },
			{ type: "agent_start" },
			{ id: "prompt-2", type: "response", command: "prompt", success: true },
			{ type: "agent_start" },
		]);
	});

	it("preserves RPC trimming and omitted-value encoding", async () => {
		const result = await runRpc([
			{ id: "last", type: "get_last_assistant_text" },
			{ id: "name", type: "set_session_name", name: "  exact name  " },
		]);
		expect(result.stderr).toBe("");
		expect(result.stdout).toEqual([
			{ id: "last", type: "response", command: "get_last_assistant_text", success: true, data: {} },
			{ id: "name", type: "response", command: "set_session_name", success: true },
		]);
	});

	it("exposes daemon schedules, heartbeats, messaging, and observation", async () => {
		const result = await runRpc([
			{ id: "schedules", type: "list_schedules" },
			{ id: "heartbeats", type: "list_heartbeats" },
			{ id: "status", type: "agent_messages_status" },
			{ id: "message", type: "send_message", targetActiveSessionId: "child", message: "check in" },
			{ id: "observe", type: "observe", activeSessionId: "child" },
		]);

		expect(result.stderr).toBe("");
		expect(result.stdout).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: "schedules",
					success: true,
					data: expect.objectContaining({ jobs: expect.arrayContaining([expect.any(Object)]) }),
				}),
				expect.objectContaining({
					id: "heartbeats",
					success: true,
					data: expect.objectContaining({ heartbeats: expect.arrayContaining([expect.any(Object)]) }),
				}),
				expect.objectContaining({
					id: "status",
					success: true,
					data: expect.objectContaining({ paused: false }),
				}),
				expect.objectContaining({
					id: "message",
					success: true,
					data: expect.objectContaining({ deliveryStatus: "delivered" }),
				}),
				expect.objectContaining({
					id: "observe",
					success: true,
					data: expect.objectContaining({ messages: expect.arrayContaining([expect.any(Object)]) }),
				}),
				{
					type: "observed_session_event",
					activeSessionId: "child",
					event: { type: "agent_start" },
				},
			]),
		);
	});
});
