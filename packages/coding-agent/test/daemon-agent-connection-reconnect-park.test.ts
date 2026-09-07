import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DaemonAgentConnection } from "../src/modes/agent-connection/daemon-agent-connection.js";
import { DaemonClient } from "../src/modes/daemon/daemon-client.js";

const tempDirs: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
	for (const server of servers.splice(0)) await new Promise((resolveClose) => server.close(resolveClose));
	for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const sessionSummary = {
	id: "active-1",
	sessionId: "session-1",
	activeSessionId: "active-1",
	sessionFile: "/tmp/session-1.jsonl",
	lifecycle: "live",
	activity: "idle",
	isSessionActive: true,
	cwd: "/tmp/project",
	isStreaming: false,
	isCompacting: false,
	attachedClients: 1,
	messageCount: 0,
	sessionActions: { queuedCount: 0, steering: [], followUps: [] },
};

type ScriptedCommand = { type: string };
type ConnectionScript = (command: ScriptedCommand, socket: Socket, reply: (data?: unknown) => void) => void;

/** Serves every command normally, except the listed types kill the socket mid-flight instead of replying. */
function respondAll(cutTypes?: readonly string[]): ConnectionScript {
	return (command, socket, reply) => {
		if (cutTypes?.includes(command.type)) {
			socket.destroy();
			return;
		}
		switch (command.type) {
			case "attach":
				reply(sessionSummary);
				return;
			case "list":
				reply({ sessions: [sessionSummary] });
				return;
			case "get_connection_state":
				reply({ sessionId: "session-1", sessionFile: "/tmp/session-1.jsonl" });
				return;
			case "get_messages":
				reply({ messages: [] });
				return;
			case "get_session_context":
				reply({ context: {} });
				return;
			default:
				reply();
		}
	};
}

/** Minimal scripted daemon: one script per accepted connection, replaying the last script for extras. */
async function startScriptedDaemon(
	socketPath: string,
	scripts: readonly ConnectionScript[],
): Promise<{ sockets: Socket[] }> {
	const sockets: Socket[] = [];
	const server = createServer((socket) => {
		const script = scripts[Math.min(sockets.length, scripts.length - 1)];
		sockets.push(socket);
		socket.on("error", () => undefined);
		socket.write(`${JSON.stringify({ type: "daemon_hello", protocol: { version: 7 }, serverCapabilities: [] })}\n`);
		let buffered = "";
		socket.on("data", (chunk: Buffer) => {
			buffered += chunk.toString("utf8");
			let newlineIndex = buffered.indexOf("\n");
			while (newlineIndex !== -1 && !socket.destroyed) {
				const line = buffered.slice(0, newlineIndex);
				buffered = buffered.slice(newlineIndex + 1);
				newlineIndex = buffered.indexOf("\n");
				if (!line.trim()) continue;
				const wire = JSON.parse(line) as { id?: string; type?: string; command?: ScriptedCommand };
				const command = wire.type === "command" && wire.command ? wire.command : (wire as ScriptedCommand);
				if (command.type === "ack_result") continue;
				script(command, socket, (data?: unknown) => {
					socket.write(
						`${JSON.stringify({ type: "response", id: wire.id, command: command.type, success: true, data })}\n`,
					);
				});
			}
		});
	});
	servers.push(server);
	await new Promise<void>((resolveListen) => server.listen(socketPath, resolveListen));
	return { sockets };
}

function waitForResync(connection: DaemonAgentConnection): Promise<void> {
	return new Promise<void>((resolveResync) => {
		connection.subscribe((event) => {
			if (event.type === "session_resynced") resolveResync();
		});
	});
}

describe("daemon agent connection reconnect parking", () => {
	it("reconnect loop survives cuts mid-attach and mid-snapshot instead of parking its own requests", async () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-reconnect-park-"));
		tempDirs.push(directory);
		const socketPath = join(directory, "daemon.sock");
		const { sockets } = await startScriptedDaemon(socketPath, [
			respondAll(),
			// Cut mid-attach: unfixed, the request parks behind a hello only this stuck loop could produce.
			respondAll(["attach"]),
			// Cut mid-initial-snapshot on the next retry.
			respondAll(["get_connection_state", "get_messages", "get_session_context"]),
			respondAll(),
		]);
		const client = new DaemonClient(socketPath);
		try {
			await client.connect();
			await client.waitForHello();
			const connection = await DaemonAgentConnection.attach(client, "active-1", {
				recoverDaemon: async () => undefined,
				reconnectTimeoutMs: 10_000,
			});
			const resynced = waitForResync(connection);
			sockets[0]?.destroy();
			await expect(resynced).resolves.toBeUndefined();
			await connection.dispose();
		} finally {
			client.close();
		}
	}, 15_000);

	it("update-restart restore survives cuts mid-list, mid-attach, and mid-snapshot instead of parking", async () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-update-park-"));
		tempDirs.push(directory);
		const socketPath = join(directory, "daemon.sock");
		const { sockets } = await startScriptedDaemon(socketPath, [
			respondAll(),
			respondAll(["list"]),
			respondAll(["attach"]),
			respondAll(["get_connection_state", "get_messages", "get_session_context"]),
			respondAll(),
		]);
		const client = new DaemonClient(socketPath);
		try {
			await client.connect();
			await client.waitForHello();
			const connection = await DaemonAgentConnection.attach(client, "active-1", {
				recoverDaemon: async () => undefined,
			});
			const resynced = waitForResync(connection);
			sockets[0]?.write(`${JSON.stringify({ type: "daemon_closing", reason: "update" })}\n`, () => {
				sockets[0]?.destroy();
			});
			await expect(resynced).resolves.toBeUndefined();
			await connection.dispose();
		} finally {
			client.close();
		}
	}, 15_000);
});
