import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.js";
import { initializeTelemetryErrorReporting, registerTelemetryErrorReporter } from "../src/core/telemetry-errors.js";
import { DaemonClient } from "../src/modes/daemon/daemon-client.js";
import { AgentDaemon } from "../src/modes/daemon/daemon-mode.js";
import {
	DAEMON_DEFAULT_SERVER_CAPABILITIES,
	DAEMON_PROTOCOL_INFO,
	type DaemonCommand,
	type DaemonCommandEnvelope,
	type DaemonResponse,
} from "../src/modes/daemon/daemon-protocol.js";
import { attachJsonlLineReader } from "../src/modes/rpc/jsonl.js";

const INPUT = {
	inputId: "10000000-0000-4000-8000-000000000001",
	clientSessionId: "10000000-0000-4000-8000-000000000002",
};

describe("optional daemon input telemetry", () => {
	const cleanups: Array<() => void | Promise<void>> = [];
	beforeEach(() => {
		for (const key of ["PI_OFFLINE", "DO_NOT_TRACK", "PRIME_AGENT_TELEMETRY"]) vi.stubEnv(key, "");
	});
	afterEach(async () => {
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
	});

	async function endpoint(onConnection: (socket: Socket, connection: number) => void) {
		const directory = mkdtempSync(join(tmpdir(), "telemetry-daemon-input-"));
		const socketPath = join(directory, "daemon.sock");
		const sockets = new Set<Socket>();
		let connection = 0;
		const server: Server = createServer((socket) => {
			sockets.add(socket);
			onConnection(socket, ++connection);
		});
		await new Promise<void>((resolve) => server.listen(socketPath, resolve));
		cleanups.push(async () => {
			for (const socket of sockets) socket.destroy();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			rmSync(directory, { recursive: true, force: true });
		});
		const client = new DaemonClient(socketPath);
		cleanups.push(() => client.close());
		await client.connect();
		await client.waitForHello();
		return client;
	}

	function hello(socket: Socket, revision: number, enabled: boolean) {
		socket.write(
			`${JSON.stringify({
				type: "daemon_hello",
				protocol: DAEMON_PROTOCOL_INFO,
				schemaRevision: revision,
				serverCapabilities: enabled ? DAEMON_DEFAULT_SERVER_CAPABILITIES : ["session_input_admission"],
				clientId: "old-client",
			})}\n`,
		);
	}
	function respond(socket: Socket, wire: DaemonCommandEnvelope) {
		socket.write(`${JSON.stringify({ id: wire.id, type: "response", command: wire.command.type, success: true })}\n`);
	}

	it.each([
		[27, false],
		[27, true],
		[28, false],
		[28, true],
	] as const)("degrades optional fields against schema %s and capability %s", async (revision, enabled) => {
		const received: DaemonCommand[] = [];
		const client = await endpoint((socket) => {
			hello(socket, revision, enabled);
			attachJsonlLineReader(socket, (line) => {
				const wire = JSON.parse(line) as DaemonCommandEnvelope;
				if (wire.command.type === "ack_result") return;
				received.push(wire.command);
				respond(socket, wire);
			});
		});
		await expect(
			client.request({ type: "prompt", activeSessionId: "active", message: "hello", telemetryInput: INPUT }),
		).resolves.toMatchObject({ success: true });
		if (revision >= 28 && enabled) expect(received[0]).toHaveProperty("telemetryInput", INPUT);
		else expect(received[0]).not.toHaveProperty("telemetryInput");
	});

	it("removes optional metadata on reconnect downgrade while retaining the command identity", async () => {
		const received: DaemonCommandEnvelope[] = [];
		let closed = () => {};
		const disconnected = new Promise<void>((resolve) => {
			closed = resolve;
		});
		const client = await endpoint((socket, connection) => {
			hello(socket, connection === 1 ? 28 : 27, connection === 1);
			attachJsonlLineReader(socket, (line) => {
				const wire = JSON.parse(line) as DaemonCommandEnvelope;
				if (wire.command.type === "ack_result") return;
				received.push(wire);
				if (connection === 1) socket.destroy();
				else respond(socket, wire);
			});
		});
		client.enableRequestRecovery();
		client.onClose(closed);
		const prompt = client.request({
			type: "prompt",
			activeSessionId: "active",
			message: "hello",
			telemetryInput: INPUT,
		});
		await disconnected;
		await client.reconnect();
		await client.waitForHello();
		await expect(prompt).resolves.toMatchObject({ success: true });
		expect(received[0]?.command).toHaveProperty("telemetryInput", INPUT);
		expect(received[1]?.command).not.toHaveProperty("telemetryInput");
		expect(received[1]?.id).toBe(received[0]?.id);
		expect(received[1]?.clientId).toBe(received[0]?.clientId);
	});

	function worker(disabled = false) {
		const settingsManager = SettingsManager.inMemory({ telemetry: { enabled: !disabled } });
		const prompt = vi.fn(async (_text: string, options: { preflightResult?: (success: boolean) => void }) => {
			options.preflightResult?.(true);
		});
		const session = {
			settingsManager,
			promptUntilAccepted: prompt,
			promptAndWait: prompt,
			requestAbort: vi.fn(() => {
				throw new Error("worker operation failed");
			}),
		};
		const state = { runtime: { session, services: { agentDir: "/tmp/telemetry-daemon-test" }, runtimeConfig: {} } };
		const daemon = Object.assign(Object.create(AgentDaemon.prototype), {
			sessions: new Map([["active", state]]),
			promptAdmissions: new Map(),
			getBoundSessionState: () => state,
			getSessionState: () => state,
			recordWorkerRecoveryState: vi.fn(),
			write: vi.fn(),
		}) as { handleCommand(client: object, command: DaemonCommand): Promise<DaemonResponse | undefined> };
		return { daemon, prompt, settingsManager, state };
	}

	it.each(["prompt", "prompt_and_wait"] as const)(
		"accepts old-client %s and forwards new-client correlation",
		async (type) => {
			const { daemon, prompt } = worker();
			await daemon.handleCommand({}, { type, activeSessionId: "active", message: "old-client" });
			expect(prompt.mock.calls[0]?.[1]).not.toHaveProperty("telemetryInput", INPUT);
			await daemon.handleCommand(
				{},
				{ type, activeSessionId: "active", message: "new-client", telemetryInput: INPUT },
			);
			expect(prompt.mock.calls[1]?.[1]).toHaveProperty("telemetryInput", INPUT);
		},
	);

	it.each([false, true])(
		"uses the target session consent for non-HTTP command failures (disabled=%s)",
		async (disabled) => {
			const { daemon, state } = worker(disabled);
			const reporter = vi.fn();
			cleanups.push(registerTelemetryErrorReporter(reporter));
			cleanups.push(
				initializeTelemetryErrorReporting({
					agentDir: "/tmp/unrelated-context",
					settingsManager: SettingsManager.inMemory(),
				}),
			);
			await expect(daemon.handleCommand({}, { type: "abort", activeSessionId: "active" })).rejects.toThrow(
				"worker operation failed",
			);
			expect(reporter).toHaveBeenCalledTimes(disabled ? 0 : 1);
			Object.assign(state.runtime.runtimeConfig, { telemetryDisabled: true });
			await expect(daemon.handleCommand({}, { type: "abort", activeSessionId: "active" })).rejects.toThrow();
			expect(reporter).toHaveBeenCalledTimes(disabled ? 0 : 1);
		},
	);
});
