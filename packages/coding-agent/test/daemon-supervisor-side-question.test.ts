import { mkdtempSync, rmSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { DaemonSocketClient } from "../src/modes/daemon/active-session-state.js";
import { DaemonCatalogClient } from "../src/modes/daemon/daemon-catalog-process.js";
import {
	createDaemonCommandEnvelope,
	DAEMON_COMMAND_COMPATIBILITY,
	type DaemonCommand,
	type DaemonResponse,
} from "../src/modes/daemon/daemon-protocol.js";
import { DaemonSupervisor } from "../src/modes/daemon/daemon-supervisor.js";
import { MutationDrainLatch } from "../src/modes/daemon/mutation-drain-latch.js";

interface SupervisorHarness {
	handleLine(client: DaemonSocketClient, line: string): Promise<void>;
}

describe("daemon supervisor side-question routing", () => {
	it("accepts start and abort commands before forwarding them to a worker", async () => {
		const handleCommand = vi.fn(
			async (_client: DaemonSocketClient, command: DaemonCommand): Promise<DaemonResponse> => ({
				id: command.id,
				type: "response",
				command: command.type,
				success: true,
			}),
		);
		const write = vi.fn();
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			ready: Promise.resolve(),
			ownership: { assertCurrent: vi.fn(async () => undefined) },
			workers: new Map(),
			clients: new Set(),
			protocolClientIds: new WeakMap(),
			mutationDrain: new MutationDrainLatch(),
			commandJournal: {
				lookup: vi.fn(() => undefined),
				begin: vi.fn(() => ({ status: "new" })),
				recordResult: vi.fn(),
			},
			cancelOwnedWorkerCleanup: vi.fn(),
			handleCommand,
			write,
			log: vi.fn(),
		}) as SupervisorHarness;
		const client = { id: "client-1" } as DaemonSocketClient;
		const commands = [
			{
				id: "start-1",
				type: "start_side_question",
				activeSessionId: "active-1",
				sideQuestionId: "question-1",
				question: "What changed?",
			},
			{
				id: "abort-1",
				type: "abort_side_question",
				activeSessionId: "active-1",
				sideQuestionId: "question-1",
			},
		] satisfies DaemonCommand[];

		for (const command of commands) {
			await supervisor.handleLine(
				client,
				JSON.stringify(createDaemonCommandEnvelope(command, command.id!, client.id)),
			);
		}

		expect(handleCommand.mock.calls.map((call) => call[1])).toEqual(commands);
		expect(write.mock.calls.map((call) => call[1])).toEqual([
			expect.objectContaining({ command: "start_side_question", success: true }),
			expect.objectContaining({ command: "abort_side_question", success: true }),
		]);
	});
	it("rejects an old client before forwarding a state request", async () => {
		const handleCommand = vi.fn();
		const write = vi.fn();
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			ready: Promise.resolve(),
			ownership: { assertCurrent: vi.fn(async () => undefined) },
			workers: new Map(),
			clients: new Set(),
			protocolClientIds: new WeakMap(),
			mutationDrain: new MutationDrainLatch(),
			commandJournal: {
				lookup: vi.fn(() => undefined),
				begin: vi.fn(() => ({ status: "new" })),
				recordResult: vi.fn(),
			},
			cancelOwnedWorkerCleanup: vi.fn(),
			handleCommand,
			write,
			log: vi.fn(),
		}) as SupervisorHarness;
		const client = { id: "old-client" } as DaemonSocketClient;
		const command = { type: "get_state", activeSessionId: "active-1" } as const;

		await supervisor.handleLine(
			client,
			JSON.stringify(
				createDaemonCommandEnvelope(
					command,
					"state-1",
					undefined,
					DAEMON_COMMAND_COMPATIBILITY.get_state.minProtocol - 1,
				),
			),
		);

		expect(handleCommand).not.toHaveBeenCalled();
		expect(write).toHaveBeenCalledWith(
			client,
			expect.objectContaining({
				id: "state-1",
				command: "parse",
				success: false,
				error: expect.stringContaining("require protocol 7"),
			}),
		);
	});

	it("rejects a protocol-6 client through the supervisor socket before state exchange", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-supervisor-old-client-"));
		const socketPath = join(root, "supervisor.sock");
		const supervisor = new DaemonSupervisor(socketPath, {
			defaultSessionConfig: { cwd: root, agentDir: root },
			descriptorDir: join(root, "workers"),
		});
		const catalogStart = vi.spyOn(DaemonCatalogClient.prototype, "start").mockResolvedValue();
		let socket: Socket | undefined;
		try {
			await supervisor.start();
			const connectedSocket = createConnection(socketPath);
			socket = connectedSocket;
			await new Promise<void>((resolve, reject) => {
				connectedSocket.once("connect", resolve);
				connectedSocket.once("error", reject);
			});
			const messages = new Promise<Array<Record<string, unknown>>>((resolve, reject) => {
				const received: Array<Record<string, unknown>> = [];
				let buffer = "";
				const timer = setTimeout(() => reject(new Error("Timed out waiting for protocol rejection")), 2000);
				connectedSocket.on("data", (chunk) => {
					buffer += chunk.toString();
					let newline = buffer.indexOf("\n");
					while (newline >= 0) {
						const line = buffer.slice(0, newline);
						buffer = buffer.slice(newline + 1);
						newline = buffer.indexOf("\n");
						if (!line) continue;
						const message = JSON.parse(line) as Record<string, unknown>;
						received.push(message);
						if (message.type === "response") {
							clearTimeout(timer);
							resolve(received);
						}
					}
				});
			});
			const command = { type: "get_state", activeSessionId: "active-1" } as const;
			connectedSocket.write(`${JSON.stringify(createDaemonCommandEnvelope(command, "state-1", "old-client", 6))}\n`);

			await expect(messages).resolves.toEqual([
				expect.objectContaining({ type: "daemon_hello" }),
				expect.objectContaining({
					id: "state-1",
					type: "response",
					command: "parse",
					success: false,
					error: expect.stringContaining("require protocol 7"),
				}),
			]);
		} finally {
			socket?.destroy();
			await Reflect.apply(Reflect.get(supervisor, "cleanupSupervisorResources"), supervisor, []);
			catalogStart.mockRestore();
			rmSync(root, { recursive: true, force: true });
		}
	});
});
